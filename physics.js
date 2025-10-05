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

const SandActivityLevel = {
    EDGE: 0,
    SHELL: 1,
    BULK: 2
};

class SandParticle {
    constructor() {
        this.reset();
    }

    init(x, y, material, color, drift = 0, mass = 1, isLiquid = false) {
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
        this.activityLevel = SandActivityLevel.EDGE;
        this.updateInterval = 1;
        this.nextUpdateTick = 0;
        this.lastClassifiedTick = -1;
        this.mass = typeof mass === 'number' && mass > 0 ? mass : 1;
        this.isLiquid = !!isLiquid;
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
        this.activityLevel = SandActivityLevel.EDGE;
        this.updateInterval = 1;
        this.nextUpdateTick = 0;
        this.lastClassifiedTick = -1;
        this.mass = 1;
        this.isLiquid = false;
    }

    key() {
        return ((this.y << 16) | (this.x & 0xffff)) >>> 0;
    }

    canOccupy(engine, occupancy, x, y, occupancyMap = null, allowFluidDisplacement = false) {
        if (y < 0 || y >= engine.height) return false;
        const wrappedX = wrapValue(x, engine.width) | 0;
        if (engine.terrain.getPixel(wrappedX, y) !== engine.terrain.EMPTY) {
            return false;
        }
        const key = ((y << 16) | (wrappedX & 0xffff)) >>> 0;
        if (occupancy.has(key)) {
            if (!occupancyMap) {
                return false;
            }
            const occupant = occupancyMap.get(key);
            if (!allowFluidDisplacement || !this.canDisplace(engine, occupant)) {
                return false;
            }
        }
        return true;
    }

    canDisplace(engine, occupant) {
        if (!occupant || occupant.dead || occupant === this) return true;
        const terrain = engine.terrain;
        const selfProps = terrain.substances[this.material] || {};
        const otherProps = terrain.substances[occupant.material] || {};
        const otherIsLiquid = otherProps.type === 'liquid' || occupant.isLiquid;
        if (!otherIsLiquid) {
            return false;
        }
        const selfMass = this.mass || (selfProps.density || 1);
        const otherMass = occupant.mass || (otherProps.density || 1);
        return selfMass > otherMass;
    }

    tryMove(engine, occupancy, occupancyMap, dx, dy) {
        const targetX = this.x + dx;
        const targetY = this.y + dy;
        if (targetY < 0 || targetY >= engine.height) {
            return false;
        }
        const wrappedX = wrapValue(targetX, engine.width) | 0;
        const terrain = engine.terrain;
        if (terrain.getPixel(wrappedX, targetY) !== terrain.EMPTY) {
            return false;
        }
        const key = ((targetY << 16) | (wrappedX & 0xffff)) >>> 0;

        let displaced = null;
        if (occupancyMap && occupancyMap.has(key)) {
            const occupant = occupancyMap.get(key);
            if (occupant && !occupant.dead) {
                if (!this.canDisplace(engine, occupant)) {
                    return false;
                }
                displaced = occupant;
            }
            occupancy.delete(key);
            occupancyMap.delete(key);
        } else if (occupancy.has(key)) {
            // Stale occupancy entry without map context
            occupancy.delete(key);
        }

        const prevWrappedX = wrapValue(this.x, engine.width) | 0;
        const prevY = this.y;

        this.x = wrappedX;
        this.y = targetY;
        this.restTime = 0;

        if (displaced) {
            const prevKey = ((prevY << 16) | (prevWrappedX & 0xffff)) >>> 0;
            displaced.x = prevWrappedX;
            displaced.y = prevY;
            displaced.restTime = 0;
            displaced.lastClassifiedTick = -1;
            displaced.nextUpdateTick = Math.min(displaced.nextUpdateTick, (engine.tick || 0) + 1);
            occupancy.add(prevKey);
            if (occupancyMap) {
                occupancyMap.set(prevKey, displaced);
            }

            const chunkSize = engine.chunkSize;
            const totalChunksX = Math.ceil(engine.width / chunkSize);
            const totalChunksY = Math.ceil(engine.height / chunkSize);
            let newChunkX = Math.floor(prevWrappedX / chunkSize);
            let newChunkY = Math.floor(prevY / chunkSize);
            newChunkY = Math.max(0, Math.min(totalChunksY - 1, newChunkY));
            newChunkX = ((newChunkX % totalChunksX) + totalChunksX) % totalChunksX;
            if (displaced.chunkX !== newChunkX || displaced.chunkY !== newChunkY) {
                engine.moveSandToChunk(displaced, newChunkX, newChunkY);
            }
        }

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

    classifyActivity(engine, occupancy, occupancyMap, tick) {
        if (this.dead) {
            this.activityLevel = SandActivityLevel.BULK;
            this.lastClassifiedTick = tick;
            return this.activityLevel;
        }

        if (this.lastClassifiedTick === tick) {
            return this.activityLevel;
        }

        const terrain = engine.terrain;
        if (!terrain) {
            this.activityLevel = SandActivityLevel.EDGE;
            this.lastClassifiedTick = tick;
            return this.activityLevel;
        }

        const width = engine.width;
        const height = engine.height;
        const material = this.material;
        const empty = terrain.EMPTY;
        const props = terrain.substances[material] || {};
        this.isLiquid = props.type === 'liquid';

        // Treat a particle as "edge" when any nearby cell is empty or holds a
        // different material. Inner shells are grouped into bulk scheduling to
        // keep large blobs cheap to simulate.
        const checkOffsets = (offsets) => {
            for (let i = 0; i < offsets.length; i++) {
                const dx = offsets[i][0];
                const dy = offsets[i][1];
                const nx = this.x + dx;
                const ny = this.y + dy;
                if (ny < 0 || ny >= height) {
                    return true;
                }
                const wrappedX = wrapValue(nx, width) | 0;
                const terrainPixel = terrain.getPixel(wrappedX, ny);
                if (terrainPixel !== empty) {
                    if (terrainPixel !== material) {
                        return true;
                    }
                    continue;
                }

                const key = ((ny << 16) | (wrappedX & 0xffff)) >>> 0;
                const neighbor = occupancyMap.get(key);
                if (!neighbor) {
                    return true;
                }
                if (neighbor.material !== material) {
                    return true;
                }
            }
            return false;
        };

        const primaryOffsets = [
            [0, 1],
            [-1, 0],
            [1, 0],
            [0, -1]
        ];

        if (checkOffsets(primaryOffsets)) {
            this.activityLevel = SandActivityLevel.EDGE;
        } else {
            const secondaryOffsets = [
                [-1, 1],
                [1, 1],
                [-2, 0],
                [2, 0],
                [0, 2],
                [0, -2],
                [-1, -1],
                [1, -1]
            ];

            if (checkOffsets(secondaryOffsets)) {
                this.activityLevel = SandActivityLevel.SHELL;
            } else {
                this.activityLevel = SandActivityLevel.BULK;
            }
        }

        if (props.type === 'liquid' && this.activityLevel > SandActivityLevel.SHELL) {
            this.activityLevel = SandActivityLevel.SHELL;
        }

        this.lastClassifiedTick = tick;
        return this.activityLevel;
    }

    resolveUpdateInterval(engine) {
        const terrain = engine ? engine.terrain : null;
        if (!terrain) {
            this.updateInterval = 1;
            return this.updateInterval;
        }

        const props = terrain.substances[this.material] || {};
        const config = engine.sandBlobConfig || {};
        const solidIntervals = config.solidIntervals || [1, 3, 7];
        const liquidIntervals = config.liquidIntervals || [1, 2, 5];
        const table = props.type === 'liquid' ? liquidIntervals : solidIntervals;
        const index = Math.min(table.length - 1, Math.max(0, this.activityLevel));
        const interval = table[index] || 1;
        this.updateInterval = interval < 1 ? 1 : Math.floor(interval);
        return this.updateInterval;
    }

    update(engine, occupancy, dt, occupancyMap = null) {
        if (this.dead) return;

        const terrain = engine.terrain;
        const props = terrain.substances[this.material] || {};
        const isLiquid = props.type === 'liquid';
        this.isLiquid = isLiquid;

        // Remove current position from occupancy while moving
        const previousKey = this.key();
        occupancy.delete(previousKey);
        if (occupancyMap) {
            occupancyMap.delete(previousKey);
        }

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

        if (isLiquid) {
            const lateral = randomBias
                ? [{ dx: -1, dy: 0 }, { dx: 1, dy: 0 }]
                : [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }];
            moveOrder.push(...lateral);
        }

        let moved = false;
        for (const move of moveOrder) {
            if (this.tryMove(engine, occupancy, occupancyMap, move.dx, move.dy)) {
                this.restTime = 0;
                moved = true;
                break;
            }
        }

        if (!moved) {
            // Allow slow sideways creep when blocked
            if (this.drift !== 0) {
                if (this.tryMove(engine, occupancy, occupancyMap, this.drift, 0)) {
                    this.restTime += timeStep * 0.5;
                } else if (this.canOccupy(engine, occupancy, this.x + this.drift, this.y)) {
                    const targetX = this.x + this.drift;
                    const wrappedX = wrapValue(targetX, engine.width) | 0;
                    this.x = wrappedX;
                    this.restTime += timeStep * 0.5;
                }
            }

            if (isLiquid) {
                if (this.tryMix(engine, props)) {
                    return;
                }
                if (this.tryLiquidSpread(engine, occupancy, randomBias, timeStep)) {
                    moved = true;
                }
            }

            if (!moved) {
                if (isLiquid) {
                    // Liquids remain dynamic - never settle into static terrain
                    this.restTime = Math.max(0, this.restTime - timeStep * 0.3);
                } else if (this.restTime >= this.settleDelay && this.isSupported(engine)) {
                    this.settle(engine);
                }
            }
        }

        if (!this.dead && (this.y >= engine.height || this.y < 0)) {
            this.dead = true;
        }

        if (!this.dead) {
            const colorObj = terrain.getMaterialColor(this.material, this.x, this.y);
            if (colorObj) {
                this.color = colorObj.hex;
            }
            occupancy.add(this.key());
            if (occupancyMap) {
                occupancyMap.set(this.key(), this);
            }
        }
    }

    tryLiquidSpread(engine, occupancy, randomBias, timeStep) {
        const lateralOrder = randomBias ? [-1, 1] : [1, -1];
        for (let i = 0; i < lateralOrder.length; i++) {
            const dx = lateralOrder[i];
            if (this.canOccupy(engine, occupancy, this.x + dx, this.y)) {
                const wrappedX = wrapValue(this.x + dx, engine.width) | 0;
                this.x = wrappedX;
                this.restTime = Math.max(0, this.restTime - timeStep * 0.5);
                return true;
            }
        }
        return false;
    }

    tryMix(engine, props) {
        if (!props || !props.mixWith) return false;
        const terrain = engine.terrain;
        const mixTargets = Array.isArray(props.mixWith) ? props.mixWith : [props.mixWith];
        const mixResult = props.mixResult || terrain.STONE;
        const offsets = [
            [0, 1],
            [1, 0],
            [-1, 0],
            [0, -1]
        ];

        for (let i = 0; i < offsets.length; i++) {
            const dx = offsets[i][0];
            const dy = offsets[i][1];
            const worldX = wrapValue(this.x + dx, engine.width) | 0;
            const worldY = this.y + dy;
            if (worldY < 0 || worldY >= engine.height) continue;

            const terrainMaterial = terrain.getPixel(worldX, worldY);
            if (mixTargets.includes(terrainMaterial)) {
                terrain.setPixel(worldX, worldY, mixResult);
                this.settleAsMaterial(engine, mixResult);
                return true;
            }

            const otherSand = engine.findSandParticleAt(worldX, worldY);
            if (otherSand && !otherSand.dead && mixTargets.includes(otherSand.material)) {
                engine.markSandParticleAsConverted(otherSand, mixResult);
                this.settleAsMaterial(engine, mixResult);
                return true;
            }
        }

        return false;
    }

    settleAsMaterial(engine, material) {
        const x = wrapValue(this.x, engine.width) | 0;
        const y = this.y;
        engine.terrain.setPixel(x, y, material);
        this.dead = true;
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
