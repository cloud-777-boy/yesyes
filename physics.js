/**
 * PhysicsChunk - Broken terrain pieces with physics
 */

class PhysicsChunk {
    constructor() {
        this.reset();
    }
    
    init(pixels, x, y, width, height) {
        this.pixels = pixels;
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        
        // Calculate center of mass
        this.calculateCenterOfMass();
        
        // Physics
        this.vx = 0;
        this.vy = 0;
        this.rotation = 0;
        this.angularVelocity = (Math.random() - 0.5) * 0.1;
        
        this.grounded = false;
        this.lifetime = 0;
        this.maxLifetime = 10000; // 10 seconds
        
        // For splitting
        this.health = pixels.length;
    }
    
    reset() {
        this.pixels = [];
        this.x = 0;
        this.y = 0;
        this.width = 0;
        this.height = 0;
        this.vx = 0;
        this.vy = 0;
        this.rotation = 0;
        this.angularVelocity = 0;
        this.centerX = 0;
        this.centerY = 0;
        this.mass = 0;
        this.grounded = false;
        this.lifetime = 0;
        this.health = 0;
    }
    
    calculateCenterOfMass() {
        let sumX = 0;
        let sumY = 0;
        
        for (const px of this.pixels) {
            sumX += px.x - this.x;
            sumY += px.y - this.y;
        }
        
        this.centerX = sumX / this.pixels.length;
        this.centerY = sumY / this.pixels.length;
        this.mass = this.pixels.length;
    }
    
    update(dt, engine) {
        this.lifetime += dt;
        
        if (this.grounded) return;
        
        // Apply gravity
        this.vy += engine.gravity * (dt / 16.67);
        
        // Apply velocity
        this.x += this.vx;
        this.y += this.vy;
        this.rotation += this.angularVelocity;
        
        // Collision with terrain
        const collisionPoints = this.getCollisionPoints();
        let hitSomething = false;
        
        for (const point of collisionPoints) {
            const worldX = this.x + point.x;
            const worldY = this.y + point.y;
            
            if (engine.terrain.isSolid(worldX, worldY)) {
                hitSomething = true;
                
                // Bounce
                this.vy *= -0.3;
                this.vx *= 0.8;
                this.angularVelocity *= 0.8;
                
                // Move out of terrain
                this.y -= 2;
                
                // Check if we should settle
                if (Math.abs(this.vy) < 0.5 && Math.abs(this.vx) < 0.5) {
                    this.settle(engine);
                }
                
                break;
            }
        }
        
        // Friction
        this.vx *= 0.99;
        this.angularVelocity *= 0.98;
        
        // Check for splitting due to impact
        if (hitSomething && Math.abs(this.vy) > 5 && this.pixels.length > 10) {
            this.split(engine);
        }
        
        // Bounds check
        if (this.y > engine.height + 100) {
            this.grounded = true;
        }
    }
    
    getCollisionPoints() {
        // Sample points around the chunk for collision
        const points = [];
        const step = Math.max(1, Math.floor(this.pixels.length / 8));
        
        for (let i = 0; i < this.pixels.length; i += step) {
            const px = this.pixels[i];
            points.push({
                x: px.x - this.x,
                y: px.y - this.y
            });
        }
        
        return points;
    }
    
    split(engine) {
        if (this.pixels.length < 20) return;
        
        // Split chunk into smaller pieces
        const midX = this.x + this.width / 2;
        const midY = this.y + this.height / 2;
        
        const groups = [[], []];
        
        for (const px of this.pixels) {
            const idx = px.x < midX ? 0 : 1;
            groups[idx].push(px);
        }
        
        for (const group of groups) {
            if (group.length < 5) continue;
            
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            
            for (const px of group) {
                minX = Math.min(minX, px.x);
                maxX = Math.max(maxX, px.x);
                minY = Math.min(minY, px.y);
                maxY = Math.max(maxY, px.y);
            }
            
            const newChunk = engine.getChunkFromPool();
            newChunk.init(group, minX, minY, maxX - minX + 1, maxY - minY + 1);
            newChunk.vx = this.vx + (Math.random() - 0.5) * 2;
            newChunk.vy = this.vy + (Math.random() - 0.5) * 2;
            engine.chunks.push(newChunk);
        }
        
        this.grounded = true;
    }
    
    settle(engine) {
        // Merge back into terrain
        for (const px of this.pixels) {
            engine.terrain.setPixel(Math.floor(this.x + px.x - this.x), Math.floor(this.y + px.y - this.y), px.material);
        }
        
        this.grounded = true;
    }
    
    takeDamage(damage, engine) {
        this.health -= damage;
        
        if (this.health <= 0) {
            // Break into particles
            const particleCount = Math.min(20, this.pixels.length);
            for (let i = 0; i < particleCount; i++) {
                const px = this.pixels[Math.floor(Math.random() * this.pixels.length)];
                const color = engine.terrain.colors[px.material];
                if (color) {
                    engine.spawnParticles(this.x + px.x - this.x, this.y + px.y - this.y, 1, color);
                }
            }
            
            this.grounded = true;
        } else if (this.pixels.length > 10) {
            this.split(engine);
        }
    }
    
    shouldRemove() {
        return this.grounded || this.lifetime > this.maxLifetime;
    }
    
    render(ctx, scale) {
        if (this.grounded) return;
        
        ctx.save();
        
        // Translate to chunk position
        ctx.translate((this.x + this.centerX) * scale, (this.y + this.centerY) * scale);
        ctx.rotate(this.rotation);
        
        // Render pixels
        for (const px of this.pixels) {
            const color = this.getColorForMaterial(px.material);
            if (color) {
                ctx.fillStyle = color;
                const rx = (px.x - this.x - this.centerX) * scale;
                const ry = (px.y - this.y - this.centerY) * scale;
                ctx.fillRect(rx, ry, scale, scale);
            }
        }
        
        ctx.restore();
    }
    
    getColorForMaterial(material) {
        const colors = {
            1: '#6b7280', // STONE
            2: '#92633c', // DIRT
            3: '#4ade80', // GRASS
        };
        return colors[material];
    }
    
    serialize() {
        return {
            x: this.x,
            y: this.y,
            vx: this.vx,
            vy: this.vy,
            rotation: this.rotation,
            pixels: this.pixels.length
        };
    }
}

/**
 * Particle system for effects
 */
class Particle {
    constructor() {
        this.reset();
    }
    
    init(x, y, vx, vy, color) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.color = color;
        this.life = 1.0;
        this.decay = 0.02 + Math.random() * 0.02;
        this.gravity = 0.15;
        this.dead = false;
    }
    
    reset() {
        this.x = 0;
        this.y = 0;
        this.vx = 0;
        this.vy = 0;
        this.color = '#ffffff';
        this.life = 0;
        this.decay = 0.02;
        this.gravity = 0.15;
        this.dead = true;
    }
    
    update(dt) {
        this.vy += this.gravity;
        this.x += this.vx;
        this.y += this.vy;
        
        this.vx *= 0.98;
        this.vy *= 0.98;
        
        this.life -= this.decay;
        
        if (this.life <= 0) {
            this.dead = true;
        }
    }
    
    render(ctx, scale) {
        if (this.dead) return;
        
        ctx.globalAlpha = this.life;
        ctx.fillStyle = this.color;
        ctx.fillRect(this.x * scale, this.y * scale, scale, scale);
        ctx.globalAlpha = 1.0;
    }
}
