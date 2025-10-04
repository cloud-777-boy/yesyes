/**
 * Player - Mage character with staff and spells
 */

class Player {
    constructor(id, x, y) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 0;
        
        // Dimensions
        this.width = 6;
        this.height = 12;
        
        // Movement
        this.speed = 2;
        this.jumpPower = -6;
        this.grounded = false;
        
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
        this.selectedSpell = 0;
        this.spells = ['fireball', 'ice', 'lightning', 'earth'];
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
        }
        
        // Horizontal movement
        if (this.input.left) {
            this.vx = -this.speed;
        } else if (this.input.right) {
            this.vx = this.speed;
        } else {
            this.vx *= 0.8;
        }
        
        // Apply gravity
        this.vy += engine.gravity;
        
        // Apply velocity
        this.x += this.vx;
        this.y += this.vy;
        
        // Collision detection
        this.grounded = false;
        
        // Check ground
        for (let ox = 0; ox < this.width; ox++) {
            if (engine.terrain.isSolid(this.x + ox, this.y + this.height)) {
                this.grounded = true;
                this.y = Math.floor(this.y);
                this.vy = 0;
                break;
            }
        }
        
        // Check ceiling
        for (let ox = 0; ox < this.width; ox++) {
            if (engine.terrain.isSolid(this.x + ox, this.y)) {
                this.vy = 0;
                this.y = Math.floor(this.y) + 1;
                break;
            }
        }
        
        // Check walls
        let hitWall = false;
        for (let oy = 0; oy < this.height; oy++) {
            if (engine.terrain.isSolid(this.x, this.y + oy)) {
                this.x = Math.floor(this.x) + 1;
                this.vx = 0;
                hitWall = true;
                break;
            }
            if (engine.terrain.isSolid(this.x + this.width, this.y + oy)) {
                this.x = Math.floor(this.x);
                this.vx = 0;
                hitWall = true;
                break;
            }
        }
        
        // Jumping
        if (this.input.jump && this.grounded) {
            this.vy = this.jumpPower;
            this.grounded = false;
        }
        
        // Aim staff
        const centerX = this.x + this.width / 2;
        const centerY = this.y + this.height / 2;
        this.aimAngle = Math.atan2(this.input.mouseY - centerY, this.input.mouseX - centerX);
        
        // Shoot spell
        if (this.input.shoot && this.cooldown <= 0) {
            this.castSpell(engine);
            this.cooldown = this.cooldownTime;
        }
        
        // Bounds
        this.x = Math.max(0, Math.min(this.x, engine.width - this.width));
        this.y = Math.max(0, Math.min(this.y, engine.height - this.height));
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
        engine.spawnProjectile(staffEndX, staffEndY, vx, vy, spell, this.id);
        
        // Particle effect
        const color = this.getSpellColor(spell);
        engine.spawnParticles(staffEndX, staffEndY, 5, color);
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
        this.selectedSpell = data.selectedSpell;
    }
}
