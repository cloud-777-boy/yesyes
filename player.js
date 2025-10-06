/**
 * Player - Mage character with staff and spells
 */

class Player {
    constructor(id, x, y, selectedSpell = null, random = null) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 0;
        const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) >>> 0;
        this.random = random || (typeof DeterministicRandom === 'function' ? new DeterministicRandom(0x9e3779b9 ^ hash) : null);
        
        // Dimensions
        this.width = 6;
        this.height = 12;
        
        // Movement
        this.speed = 2;
        this.jumpPower = -6;
        this.grounded = false;
        this.maxFallSpeed = 12;
        this.maxStepHeight = 3;
        this.lastFluidCoverage = 0;
        
        // Spell casting
        this.aimAngle = 0;
        this.staffLength = 10;
        this.cooldown = 0;
        this.cooldownTime = 300; // ms between shots
        
        // Appearance
        this.color = this.generateColor(id);
        this.hatColor = this.generateHatColor(id);
        
        // Input state
        this.input = {
            left: false,
            right: false,
            jump: false,
            shoot: false,
            mouseX: 0,
            mouseY: 0
        };
        
        // Stats
        this.health = 100;
        this.maxHealth = 100;
        this.alive = true;
        
        // Spell type
        this.spells = ['fireball', 'ice', 'lightning', 'earth'];
        const initialSpellIndex = Number.isInteger(selectedSpell)
            ? selectedSpell
            : this.getRandomInt(this.spells.length);
        this.selectedSpell = this.normalizeSpellIndex(initialSpellIndex);
    }

    getRandomFloat() {
        if (this.random && typeof this.random.nextFloat === 'function') {
            return this.random.nextFloat();
        }
        return Math.random();
    }

    getRandomInt(maxExclusive) {
        if (maxExclusive <= 0) return 0;
        if (this.random && typeof this.random.nextInt === 'function') {
            return this.random.nextInt(maxExclusive);
        }
        return Math.floor(Math.random() * maxExclusive);
    }

    normalizeSpellIndex(index) {
        if (!Number.isInteger(index)) return 0;
        const length = this.spells.length;
        if (length === 0) return 0;
        return ((index % length) + length) % length;
    }
    
    generateColor(id) {
        const colors = [
            '#ff6b9d', '#4ecdc4', '#ffd93d', '#a78bfa',
            '#fb923c', '#34d399', '#60a5fa', '#f472b6'
        ];
        const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        return colors[hash % colors.length];
    }
    
    generateHatColor(id) {
        const colors = [
            '#1f2937', '#581c87', '#7c2d12', '#164e63',
            '#1e3a8a', '#4c1d95', '#831843', '#065f46'
        ];
        const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        return colors[hash % colors.length];
    }
    
    update(dt, engine) {
        if (!this.alive) return;
        
        // Update cooldown
        if (this.cooldown > 0) {
            this.cooldown -= dt;
            if (this.cooldown < 0) this.cooldown = 0;
        }
        
        // Horizontal movement
        if (this.input.left && !this.input.right) {
            this.vx = -this.speed;
        } else if (this.input.right && !this.input.left) {
            this.vx = this.speed;
        } else {
            this.vx *= 0.8;
            if (Math.abs(this.vx) < 0.05) {
                this.vx = 0;
            }
        }
        
        // Apply gravity
        this.vy += engine.gravity;
        if (this.vy > this.maxFallSpeed) {
            this.vy = this.maxFallSpeed;
        }

        const fluidCoverage = this.getFluidCoverage(engine);
        this.lastFluidCoverage = fluidCoverage;
        if (fluidCoverage > 0) {
            this.applyFluidForces(engine, fluidCoverage);
        }
        
        // Resolve movement against terrain per axis to avoid tunneling
        this.resolveHorizontal(engine);
        const verticalHit = this.resolveVertical(engine);
        
        if (verticalHit === 'down') {
            this.grounded = true;
        } else if (verticalHit === 'up') {
            this.grounded = false;
        } else {
            this.grounded = this.vy >= 0 && this.isColliding(engine, this.x, this.y + 0.1);
        }
        
        // Jumping
        if (this.input.jump && this.grounded) {
            this.vy = this.jumpPower;
            this.grounded = false;
        }
        
        // Aim staff
        const centerX = this.x + this.width / 2;
        const centerY = this.y + this.height / 2;
        const dx = shortestWrappedDelta(this.input.mouseX, centerX, engine.width);
        const dy = this.input.mouseY - centerY;
        this.aimAngle = Math.atan2(dy, dx);
        
        // Shoot spell
        if (this.input.shoot && this.cooldown <= 0) {
            this.castSpell(engine);
            this.cooldown = this.cooldownTime;
        }
        
        // Bounds (horizontal wraps, vertical clamps)
        this.x = wrapHorizontal(this.x, engine.width);
        this.y = Math.max(0, Math.min(this.y, engine.height - this.height));

        this.riseOutOfGranular(engine);
    }

    castSpell(engine) {
        const centerX = this.x + this.width / 2;
        const centerY = this.y + this.height / 2;
        
        const staffEndX = centerX + Math.cos(this.aimAngle) * this.staffLength;
        const staffEndY = centerY + Math.sin(this.aimAngle) * this.staffLength;

        const speed = 8;
        const vx = Math.cos(this.aimAngle) * speed;
        const vy = Math.sin(this.aimAngle) * speed;

        const spell = this.spells[this.selectedSpell];
        const spawnX = wrapHorizontal(staffEndX, engine.width);

        const isOnline = engine && engine.network && engine.network.connected;
        const projectile = engine.spawnProjectile(
            spawnX,
            staffEndY,
            vx,
            vy,
            spell,
            this.id,
            { pending: isOnline }
        );

        if (isOnline && projectile && typeof engine.network.sendProjectile === 'function') {
            engine.network.sendProjectile(projectile);
        }

        if (engine && typeof engine.spawnParticles === 'function') {
            const color = this.getSpellColor(spell);
            engine.spawnParticles(spawnX, staffEndY, 5, color);
        }
    }
    
    getSpellColor(spell) {
        const colors = {
            fireball: '#ff6b35',
            ice: '#4ecdc4',
            lightning: '#ffd93d',
            earth: '#92633c'
        };
        return colors[spell] || '#ffffff';
    }
    
    takeDamage(damage) {
        this.health -= damage;
        if (this.health <= 0) {
            this.health = 0;
            this.alive = false;
        }
    }

    resolveHorizontal(engine) {
        if (!engine || !engine.terrain) return false;

        const velocity = this.vx;
        if (velocity === 0) return false;

        const steps = Math.max(1, Math.ceil(Math.abs(velocity)));
        const step = velocity / steps;
        const canStepUp = (this.vy >= -0.5);
        const maxStepHeight = Math.max(0, Math.ceil(this.maxStepHeight || 0));
        let collided = false;

        for (let i = 0; i < steps; i++) {
            this.x += step;
            if (this.isColliding(engine, this.x, this.y)) {
                let steppedUp = false;
                if (canStepUp && maxStepHeight > 0) {
                    const originalY = this.y;
                    for (let climb = 1; climb <= maxStepHeight; climb++) {
                        const testY = originalY - climb;
                        if (!this.isColliding(engine, this.x, testY)) {
                            this.y = testY;
                            this.vy = Math.min(this.vy, 0);
                            steppedUp = true;
                            break;
                        }
                    }

                    if (!steppedUp) {
                        this.y = originalY;
                    }
                }

                if (steppedUp) {
                    continue;
                }

                this.x -= step;
                if (step > 0) {
                    this.x = Math.floor(this.x);
                } else {
                    this.x = Math.ceil(this.x);
                }
                collided = true;
                this.vx = 0;
                break;
            }
        }

        return collided;
    }

    resolveVertical(engine) {
        if (!engine || !engine.terrain) return null;

        const velocity = this.vy;
        if (velocity === 0) return null;

        const steps = Math.max(1, Math.ceil(Math.abs(velocity)));
        const step = velocity / steps;
        let collisionDirection = null;

        for (let i = 0; i < steps; i++) {
            this.y += step;
            if (this.isColliding(engine, this.x, this.y)) {
                this.y -= step;
                if (step > 0) {
                    this.y = Math.floor(this.y);
                    collisionDirection = 'down';
                } else {
                    this.y = Math.ceil(this.y);
                    collisionDirection = 'up';
                }
                this.vy = 0;
                break;
            }
        }

        return collisionDirection;
    }

    isColliding(engine, posX, posY) {
        if (!engine || !engine.terrain) return false;

        const left = Math.floor(posX);
        const right = Math.floor(posX + this.width - 0.001);
        const top = Math.floor(posY);
        const bottom = Math.floor(posY + this.height - 0.001);

        const terrain = engine.terrain;
        const width = terrain.width;
        const height = terrain.height;

        if (top < 0 || bottom >= height) {
            return true;
        }

        const pixels = terrain.pixels;
        const empty = terrain.EMPTY;

        for (let y = top; y <= bottom; y++) {
            for (let x = left; x <= right; x++) {
                const wrappedX = Math.floor(wrapHorizontal(x, width));
                const index = y * width + wrappedX;
                if (pixels[index] !== empty) {
                    return true;
                }
            }
        }
        
        return false;
    }

    isInsideGranular(engine) {
        if (!engine || !engine.terrain) return false;
        const terrain = engine.terrain;

        const innerLeft = Math.floor(this.x + 0.9);
        const innerRight = Math.floor(this.x + this.width - 0.9);
        const innerTop = Math.floor(this.y + this.height * 0.3);
        const innerBottom = Math.floor(this.y + this.height - 1.2);

        if (innerBottom < innerTop || innerRight < innerLeft) {
            return false;
        }

        for (let y = innerTop; y <= innerBottom; y++) {
            for (let x = innerLeft; x <= innerRight; x++) {
                if (terrain.isGranular(x, y)) {
                    return true;
                }
            }
        }
        return false;
    }

    getFluidCoverage(engine) {
        if (!engine || !engine.terrain) return 0;

        const terrain = engine.terrain;
        const left = Math.floor(this.x);
        const right = Math.floor(this.x + this.width - 1);
        const top = Math.floor(this.y);
        const bottom = Math.floor(this.y + this.height - 1);

        if (bottom < top || right < left) return 0;

        let fluidCount = 0;
        let sampleCount = 0;

        for (let y = top; y <= bottom; y++) {
            for (let x = left; x <= right; x++) {
                sampleCount++;
                if (typeof terrain.isLiquid === 'function') {
                    if (terrain.isLiquid(x, y)) {
                        fluidCount++;
                    }
                } else {
                    const material = terrain.getPixel(x, y);
                    const props = terrain.substances[material];
                    if (props && props.type === 'liquid') {
                        fluidCount++;
                    }
                }
            }
        }

        if (sampleCount === 0) return 0;
        return fluidCount / sampleCount;
    }

    applyFluidForces(engine, coverage) {
        const gravity = engine ? engine.gravity : 0.3;
        const clampedCoverage = Math.max(0, Math.min(1, coverage));
        const buoyancy = gravity * (1.25 + 1.5 * clampedCoverage);

        this.vy -= buoyancy * clampedCoverage;

        const reducedFallSpeed = Math.max(1.5, this.maxFallSpeed * (1 - 0.75 * clampedCoverage));
        if (this.vy > reducedFallSpeed) {
            this.vy = reducedFallSpeed;
        }

        const maxUpwardSpeed = Math.max(2.5, Math.abs(this.jumpPower) * (0.4 + 0.4 * clampedCoverage));
        if (this.vy < -maxUpwardSpeed) {
            this.vy = -maxUpwardSpeed;
        }

        const drag = Math.max(0.2, 1 - 0.55 * clampedCoverage);
        this.vx *= drag;
        if (Math.abs(this.vx) < 0.01) {
            this.vx = 0;
        }
    }

    riseOutOfGranular(engine) {
        if (!engine || !engine.terrain) return;
        if (!this.isInsideGranular(engine)) return;

        const maxLift = this.height + 2;
        let lifted = 0;
        while (lifted <= maxLift && this.isInsideGranular(engine)) {
            this.y -= 1;
            lifted++;
            if (this.y <= 0) {
                this.y = 0;
                break;
            }
        }

        if (lifted > 0) {
            this.vy = Math.min(this.vy, 0);
            this.grounded = this.isColliding(engine, this.x, this.y + 0.1);
        }
    }

    render(ctx, scale) {
        if (!this.alive) return;
        
        const x = this.x * scale;
        const y = this.y * scale;
        const w = this.width * scale;
        const h = this.height * scale;
        
        // Body (robe)
        ctx.fillStyle = this.color;
        ctx.fillRect(x, y + h * 0.3, w, h * 0.7);
        
        // Head
        ctx.fillStyle = '#ffd1a3';
        ctx.fillRect(x + w * 0.2, y, w * 0.6, h * 0.35);
        
        // Wizard hat
        ctx.fillStyle = this.hatColor;
        ctx.beginPath();
        ctx.moveTo(x + w * 0.5, y - h * 0.3);
        ctx.lineTo(x, y + h * 0.1);
        ctx.lineTo(x + w, y + h * 0.1);
        ctx.closePath();
        ctx.fill();
        
        // Hat brim
        ctx.fillRect(x - w * 0.1, y + h * 0.1, w * 1.2, h * 0.08);
        
        // Staff
        const centerX = (this.x + this.width / 2) * scale;
        const centerY = (this.y + this.height / 2) * scale;
        const staffEndX = centerX + Math.cos(this.aimAngle) * this.staffLength * scale;
        const staffEndY = centerY + Math.sin(this.aimAngle) * this.staffLength * scale;
        
        ctx.strokeStyle = '#8b4513';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(staffEndX, staffEndY);
        ctx.stroke();
        
        // Staff orb
        const spellColor = this.getSpellColor(this.spells[this.selectedSpell]);
        ctx.fillStyle = spellColor;
        ctx.beginPath();
        ctx.arc(staffEndX, staffEndY, 3, 0, Math.PI * 2);
        ctx.fill();
        
        // Health bar
        const barWidth = w;
        const barHeight = 3;
        const barY = y - 8;
        
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(x, barY, barWidth, barHeight);
        
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(x, barY, barWidth * (this.health / this.maxHealth), barHeight);
    }
    
    serialize() {
        return {
            id: this.id,
            x: this.x,
            y: this.y,
            vx: this.vx,
            vy: this.vy,
            aimAngle: this.aimAngle,
            health: this.health,
            alive: this.alive,
            selectedSpell: this.selectedSpell
        };
    }
    
    deserialize(data) {
        this.x = data.x;
        this.y = data.y;
        this.vx = data.vx;
        this.vy = data.vy;
        this.aimAngle = data.aimAngle;
        this.health = data.health;
        this.alive = data.alive;
        this.selectedSpell = this.normalizeSpellIndex(data.selectedSpell);
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.Player = globalThis.Player || Player;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Player;
}
