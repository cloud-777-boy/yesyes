/**
 * Projectile - Magic spells with different effects
 */

class Projectile {
    constructor(x, y, vx, vy, type, ownerId) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.type = type;
        this.ownerId = ownerId;
        
        this.radius = 3;
        this.damage = 20;
        this.lifetime = 0;
        this.maxLifetime = 3000;
        this.dead = false;
        this.pending = false;
        
        // Effect properties based on type
        this.setupType();
        
        // Trail particles
        this.particleTimer = 0;
    }
    
    setupType() {
        switch (this.type) {
            case 'fireball':
                this.color = '#ff6b35';
                this.explosionRadius = 15;
                this.damage = 25;
                this.gravity = 0.05;
                break;
                
            case 'ice':
                this.color = '#4ecdc4';
                this.explosionRadius = 10;
                this.damage = 15;
                this.gravity = 0;
                this.piercing = true;
                break;
                
            case 'lightning':
                this.color = '#ffd93d';
                this.explosionRadius = 8;
                this.damage = 30;
                this.gravity = 0;
                this.speed = 1.5;
                this.vx *= this.speed;
                this.vy *= this.speed;
                break;
                
            case 'earth':
                this.color = '#92633c';
                this.explosionRadius = 20;
                this.damage = 20;
                this.gravity = 0.2;
                break;
                
            default:
                this.color = '#ffffff';
                this.explosionRadius = 10;
                this.gravity = 0;
        }
    }
    
    update(dt, engine) {
        this.lifetime += dt;
        
        if (this.lifetime > this.maxLifetime) {
            this.dead = true;
            return;
        }
        
        // Apply gravity
        if (this.gravity) {
            this.vy += this.gravity;
        }
        
        const stepX = this.vx;
        const stepY = this.vy;
        const isAuthoritative = engine ? !!engine.isServer : false;

        if (engine) {
            if (isAuthoritative) {
                const hit = this.raycast(engine, this.x, this.y, stepX, stepY);
                this.x = wrapHorizontal(hit.x, engine.width);
                this.y = hit.y;

                if (hit.collided) {
                    this.explode(engine);
                    return;
                }
            } else {
                const hit = this.raycast(engine, this.x, this.y, stepX, stepY);
                this.x = wrapHorizontal(hit.x, engine.width);
                this.y = hit.y;

                if (hit.collided) {
                    this.dead = true;
                    return;
                }
            }
        } else {
            this.x += stepX;
            this.y += stepY;
        }
        
        // Spawn trail particles for visual feedback
        if (engine && typeof engine.spawnParticles === 'function') {
            this.particleTimer += dt;
            if (this.particleTimer > 30) {
                engine.spawnParticles(this.x, this.y, 2, this.color);
                this.particleTimer = 0;
            }
        }
        
        if (!engine) return;

        // Check collision with players (server authoritative)
        if (isAuthoritative) {
            for (const [id, player] of engine.players.entries()) {
                if (id === this.ownerId) continue;
                if (!player.alive) continue;

                if (this.checkPlayerCollision(player, engine)) {
                    player.takeDamage(this.damage);

                    if (!this.piercing) {
                        this.explode(engine);
                        return;
                    }
                }
            }
        }

        // Bounds check (vertical only, horizontal wraps)
        if (this.y < 0 || this.y > engine.height) {
            this.dead = true;
        }
    }

    raycast(engine, startX, startY, deltaX, deltaY) {
        const steps = Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)));
        if (steps <= 0) {
            return { x: startX, y: startY, collided: false };
        }
        const stepX = deltaX / steps;
        const stepY = deltaY / steps;
        let x = startX;
        let y = startY;
        for (let i = 1; i <= steps; i++) {
            x += stepX;
            y += stepY;
            const wrappedX = wrapHorizontal(x, engine.width);
            if (engine.terrain.isSolid(Math.floor(wrappedX), Math.floor(y))) {
                return { x: wrappedX, y, collided: true };
            }
        }
        return { x, y, collided: false };
    }

    checkPlayerCollision(player, engine) {
        const px = player.x + player.width / 2;
        const py = player.y + player.height / 2;
        const dx = shortestWrappedDelta(this.x, px, engine.width);
        const dy = this.y - py;
        const dist = Math.sqrt(dx ** 2 + dy ** 2);
        return dist < this.radius + Math.max(player.width, player.height) / 2;
    }
    
    explode(engine) {
        const isAuthoritative = engine ? !!engine.isServer : false;

        if (this.explosionRadius > 0) {
            engine.destroyTerrain(this.x, this.y, this.explosionRadius, true);
        }

        // Damage nearby players
        for (const [id, player] of engine.players.entries()) {
            if (id === this.ownerId) continue;
            if (!player.alive) continue;
            
            const px = player.x + player.width / 2;
            const py = player.y + player.height / 2;
            const dx = shortestWrappedDelta(this.x, px, engine.width);
            const dy = this.y - py;
            const dist = Math.sqrt(dx ** 2 + dy ** 2);
            
            if (dist < this.explosionRadius * 2) {
                const damageFactor = 1 - (dist / (this.explosionRadius * 2));
                player.takeDamage(Math.floor(this.damage * damageFactor * 0.5));
            }
        }
        
        // Particle effect
        const particleCount = Math.floor(this.explosionRadius);
        engine.spawnParticles(this.x, this.y, particleCount, this.color);
        
        // Type-specific effects
        this.typeSpecificEffect(engine);
        
        this.dead = true;
    }
    
    typeSpecificEffect(engine) {
        switch (this.type) {
            case 'fireball':
                // Extra particles for fire
                engine.spawnParticles(this.x, this.y, 10, '#ff9500');
                break;
                
            case 'ice':
                // Freeze effect - spawn ice particles
                engine.spawnParticles(this.x, this.y, 15, '#a5f3fc');
                break;
                
            case 'lightning':
                // Lightning chain effect
                for (let i = 0; i < 5; i++) {
                    const rng = engine && engine.random ? engine.random : null;
                    const angle = (rng ? rng.nextFloat() : Math.random()) * Math.PI * 2;
                    const dist = (rng ? rng.nextFloat() : Math.random()) * 20;
                    const px = this.x + Math.cos(angle) * dist;
                    const py = this.y + Math.sin(angle) * dist;
                    engine.spawnParticles(wrapHorizontal(px, engine.width), py, 3, this.color);
                }
                break;
                
            case 'earth':
                // Spawn small debris
                break;
        }
    }
    
    render(ctx, scale) {
        if (this.dead) return;
        
        // Glow effect
        const gradient = ctx.createRadialGradient(
            this.x * scale, this.y * scale, 0,
            this.x * scale, this.y * scale, this.radius * scale * 2
        );
        gradient.addColorStop(0, this.color);
        gradient.addColorStop(0.5, this.color + '80');
        gradient.addColorStop(1, this.color + '00');
        
        ctx.fillStyle = gradient;
        ctx.fillRect(
            (this.x - this.radius * 2) * scale,
            (this.y - this.radius * 2) * scale,
            this.radius * 4 * scale,
            this.radius * 4 * scale
        );
        
        // Core
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x * scale, this.y * scale, this.radius * scale, 0, Math.PI * 2);
        ctx.fill();
        
        // Type-specific rendering
        if (this.type === 'lightning') {
            ctx.strokeStyle = this.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo((this.x - this.vx) * scale, (this.y - this.vy) * scale);
            ctx.lineTo(this.x * scale, this.y * scale);
            ctx.stroke();
        }
    }
    
    serialize() {
        return {
            x: this.x,
            y: this.y,
            vx: this.vx,
            vy: this.vy,
            type: this.type,
            ownerId: this.ownerId,
            lifetime: this.lifetime
        };
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.Projectile = globalThis.Projectile || Projectile;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Projectile;
}
