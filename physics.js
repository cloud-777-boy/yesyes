/**
 * Sand Physics - Falling sand style debris simulation
 */

function wrapValue(value, width) {
    if (typeof wrapHorizontal === 'function') {
        return wrapHorizontal(value, width);
    }
    if (!isFinite(width) || width <= 0) {
        return value;
    }
    let wrapped = value % width;
    if (wrapped < 0) wrapped += width;
    return wrapped;
}

class SandParticle {
    constructor() {
        this.reset();
    }

    init(x, y, material, color, drift = 0) {
        this.x = Math.floor(x);
        this.y = Math.floor(y);
        this.material = material;
        this.color = color;
        this.drift = Math.sign(drift);
        this.restTime = 0;
        this.settleDelay = 180; // ms before welding back into terrain
        this.dead = false;
        this.chunkX = 0;
        this.chunkY = 0;
        this.chunkKey = null;
        this.chunkIndex = -1;
    }

    reset() {
        this.x = 0;
        this.y = 0;
        this.material = 0;
        this.color = '#ffffff';
        this.drift = 0;
        this.restTime = 0;
        this.settleDelay = 180;
        this.dead = true;
        this.chunkX = 0;
        this.chunkY = 0;
        this.chunkKey = null;
        this.chunkIndex = -1;
    }

    key() {
        return ((this.y << 16) | (this.x & 0xffff)) >>> 0;
    }

    canOccupy(engine, occupancy, x, y) {
        if (y < 0 || y >= engine.height) return false;
        const wrappedX = wrapValue(x, engine.width) | 0;
        if (engine.terrain.getPixel(wrappedX, y) !== engine.terrain.EMPTY) {
            return false;
        }
        const key = ((y << 16) | (wrappedX & 0xffff)) >>> 0;
        if (occupancy.has(key)) {
            return false;
        }
        return true;
    }

    tryMove(engine, occupancy, dx, dy) {
        const targetX = this.x + dx;
        const targetY = this.y + dy;
        if (!this.canOccupy(engine, occupancy, targetX, targetY)) {
            return false;
        }
        const wrappedX = wrapValue(targetX, engine.width) | 0;
        this.x = wrappedX;
        this.y = targetY;
        this.restTime = 0;
        return true;
    }

    settle(engine) {
        const x = wrapValue(this.x, engine.width) | 0;
        const y = this.y;
        if (y >= 0 && y < engine.height) {
            if (engine.terrain.getPixel(x, y) === engine.terrain.EMPTY) {
                engine.terrain.setPixel(x, y, this.material);
            } else {
                // Find nearest empty cell above to avoid losing material
                let targetY = y - 1;
                while (targetY >= 0 && engine.terrain.getPixel(x, targetY) !== engine.terrain.EMPTY) {
                    targetY--;
                }
                if (targetY >= 0) {
                    engine.terrain.setPixel(x, targetY, this.material);
                    engine.terrain.markDirty(x, targetY);
                }
            }
            engine.terrain.markDirty(x, y);
        }
        this.dead = true;
    }

    update(engine, occupancy, dt) {
        if (this.dead) return;

        // Remove current position from occupancy while moving
        const previousKey = this.key();
        occupancy.delete(previousKey);

        const timeStep = dt || 16;
        this.restTime += timeStep;

        const preferLeft = this.drift < 0;
        const preferRight = this.drift > 0;
        const randomBias = Math.random() < 0.5;

        const moveOrder = [];
        // Always try straight down first
        moveOrder.push({ dx: 0, dy: 1 });

        const diagOptions = [
            { dx: -1, dy: 1 },
            { dx: 1, dy: 1 }
        ];

        if (preferLeft) {
            moveOrder.push(diagOptions[0], diagOptions[1]);
        } else if (preferRight) {
            moveOrder.push(diagOptions[1], diagOptions[0]);
        } else {
            if (randomBias) {
                moveOrder.push(diagOptions[0], diagOptions[1]);
            } else {
                moveOrder.push(diagOptions[1], diagOptions[0]);
            }
        }

        let moved = false;
        for (const move of moveOrder) {
            if (this.tryMove(engine, occupancy, move.dx, move.dy)) {
                moved = true;
                break;
            }
        }

        if (!moved) {
            // Allow slow sideways creep when blocked
            if (this.drift !== 0 && this.canOccupy(engine, occupancy, this.x + this.drift, this.y)) {
                const targetX = this.x + this.drift;
                const wrappedX = wrapValue(targetX, engine.width) | 0;
                this.x = wrappedX;
                this.restTime += timeStep * 0.5;
            }

            if (this.restTime >= this.settleDelay && this.isSupported(engine)) {
                this.settle(engine);
            }
        }

        if (!this.dead && (this.y >= engine.height || this.y < 0)) {
            this.dead = true;
        }

        if (!this.dead) {
            const colorObj = engine.terrain.getMaterialColor(this.material, this.x, this.y);
            if (colorObj) {
                this.color = colorObj.hex;
            }
            occupancy.add(this.key());
        }
    }

    isSupported(engine) {
        const belowY = this.y + 1;
        if (belowY >= engine.height) return true;
        const x = wrapValue(this.x, engine.width) | 0;
        if (engine.terrain.isSolid(x, belowY)) return true;
        // Check diagonals for support to avoid perpetual sliding
        const leftSupport = engine.terrain.isSolid(wrapValue(x - 1, engine.width), belowY);
        const rightSupport = engine.terrain.isSolid(wrapValue(x + 1, engine.width), belowY);
        return leftSupport || rightSupport;
    }

    render(ctx, scale) {
        if (this.dead) return;
        ctx.fillStyle = this.color;
        ctx.fillRect(this.x * scale, this.y * scale, scale, scale);
    }
}

/**
 * Particle system for effects (unchanged)
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
    
    update(dt, worldWidth = null) {
        this.vy += this.gravity;
        this.x += this.vx;
        this.y += this.vy;

        this.vx *= 0.98;
        this.vy *= 0.98;

        if (worldWidth !== null && isFinite(worldWidth)) {
            this.x = wrapValue(this.x, worldWidth);
        }

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
