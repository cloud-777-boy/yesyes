class EigenSandChunk {
    constructor(engine, chunkX, chunkY, size) {
        this.engine = engine;
        this.chunkX = chunkX;
        this.chunkY = chunkY;
        this.size = size;
        this.modeCount = Math.min(8, size);
        this.heights = new Float32Array(size);
        this.nextHeights = new Float32Array(size);
        this.columnMaterial = new Uint16Array(size);
        this.columnCapacity = new Uint16Array(size);
        this.columnCells = new Array(size);
        this.mask = new Uint8Array(size * size);
        this.volume = 0;
        this.hasLiquid = false;
        this.warm = false;
        this.diffusionRate = 0.18;
        this.lastUpdateTick = -1;
        this.basis = [];
        this.norm = [];
        this.lambda = [];
        this._precomputeBasis();
    }

    _precomputeBasis() {
        const size = this.size;
        for (let k = 0; k < this.modeCount; k++) {
            const row = new Float32Array(size);
            for (let x = 0; x < size; x++) {
                row[x] = Math.cos(Math.PI * (x + 0.5) * k / size);
            }
            this.basis.push(row);
            this.lambda.push(2 - 2 * Math.cos(Math.PI * k / size));
            this.norm.push(k === 0 ? 1 / size : 2 / size);
        }
    }

    key() {
        return `${this.chunkX}|${this.chunkY}`;
    }

    ensureIngested() {
        if (!this.warm) {
            this.ingestFromTerrain();
        }
    }

    ingestFromTerrain() {
        const terrain = this.engine.terrain;
        if (!terrain) return;
        const size = this.size;
        const baseX = this.chunkX * size;
        const baseY = this.chunkY * size;
        this.mask.fill(0);
        this.columnMaterial.fill(0);
        this.columnCapacity.fill(0);
        this.volume = 0;
        this.hasLiquid = false;

        for (let x = 0; x < size; x++) {
            const cells = [];
            const worldColumn = ((baseX + x) % this.engine.width + this.engine.width) % this.engine.width;
            const materialCounts = new Map();
            let capacity = 0;
            for (let y = 0; y < size; y++) {
                const worldY = baseY + y;
                const material = terrain.getPixel(worldColumn, worldY);
                if (material === terrain.EMPTY || material === terrain.BEDROCK) continue;
                const props = terrain.substances[material];
                if (!props || (props.type !== 'liquid' && props.type !== 'granular')) continue;
                const maskIndex = y * size + x;
                this.mask[maskIndex] = 1;
                cells.push(y);
                capacity++;
                const count = materialCounts.get(material) || 0;
                materialCounts.set(material, count + 1);
            }
            this.columnCells[x] = cells;
            this.columnCapacity[x] = capacity;
            if (capacity > 0) {
                this.hasLiquid = true;
                let topCount = 0;
                let chosenMaterial = 0;
                for (const [mat, count] of materialCounts.entries()) {
                    if (count > topCount) {
                        topCount = count;
                        chosenMaterial = mat;
                    }
                }
                this.columnMaterial[x] = chosenMaterial || terrain.WATER;
                this.heights[x] = capacity;
                this.volume += capacity;
            } else {
                this.columnMaterial[x] = 0;
                this.heights[x] = 0;
            }
        }
        this.warm = this.hasLiquid;
        this.lastUpdateTick = this.engine.tick;
    }

    idle(dt) {
        if (!this.warm) return;
        // light diffusion to slowly settle while chunk is in warm buffer
        this.solveSpectral(dt * 0.25);
    }

    freeze() {
        this.warm = false;
    }

    update(dt) {
        if (!this.warm || !this.hasLiquid) return;
        this.solveSpectral(dt);
        this.applyToTerrain();
        this.lastUpdateTick = this.engine.tick;
    }

    solveSpectral(dt) {
        const size = this.size;
        if (!this.hasLiquid || this.volume === 0) return;
        const coeffs = new Float32Array(this.modeCount);

        for (let k = 0; k < this.modeCount; k++) {
            let sum = 0;
            const basisRow = this.basis[k];
            for (let x = 0; x < size; x++) {
                sum += this.heights[x] * basisRow[x];
            }
            coeffs[k] = sum * this.norm[k];
        }

        for (let k = 0; k < this.modeCount; k++) {
            const decay = Math.exp(-this.lambda[k] * this.diffusionRate * dt);
            coeffs[k] *= decay;
        }

        let newVolume = 0;
        for (let x = 0; x < size; x++) {
            let value = 0;
            for (let k = 0; k < this.modeCount; k++) {
                value += coeffs[k] * this.basis[k][x];
            }
            value = Math.max(0, Math.min(this.columnCapacity[x], value));
            this.nextHeights[x] = value;
            newVolume += value;
        }

        if (newVolume > 0) {
            const scale = this.volume / newVolume;
            newVolume = 0;
            for (let x = 0; x < size; x++) {
                const scaled = Math.max(0, Math.min(this.columnCapacity[x], this.nextHeights[x] * scale));
                this.nextHeights[x] = scaled;
                newVolume += scaled;
            }
        }

        for (let x = 0; x < size; x++) {
            this.heights[x] = this.nextHeights[x];
        }
        this.volume = newVolume;
    }

    applyToTerrain() {
        const terrain = this.engine.terrain;
        if (!terrain || !this.hasLiquid) return;
        const size = this.size;
        const baseX = this.chunkX * size;
        const baseY = this.chunkY * size;
        const width = this.engine.width;
        const wrap = typeof wrapHorizontal === 'function'
            ? wrapHorizontal
            : (value, w) => {
                let wrapped = value % w;
                if (wrapped < 0) wrapped += w;
                return wrapped;
            };

        for (let x = 0; x < size; x++) {
            const cells = this.columnCells[x];
            if (!cells || cells.length === 0) continue;
            const fill = Math.round(Math.min(this.columnCapacity[x], this.heights[x]));
            const material = this.columnMaterial[x];
            if (!material) continue;
            const worldColumn = wrap(baseX + x, width) | 0;
            const sortedCells = cells.slice().sort((a, b) => a - b);

            for (let idx = 0; idx < sortedCells.length; idx++) {
                const relY = sortedCells[idx];
                const worldY = baseY + relY;
                if (idx < fill) {
                    if (terrain.getPixel(worldColumn, worldY) !== material) {
                        terrain.setPixel(worldColumn, worldY, material);
                        terrain.markDirty(worldColumn, worldY);
                    }
                } else {
                    if (terrain.getPixel(worldColumn, worldY) !== terrain.EMPTY) {
                        terrain.setPixel(worldColumn, worldY, terrain.EMPTY);
                        terrain.markDirty(worldColumn, worldY);
                    }
                }
            }
        }
    }
}

class EigenSandManager {
    constructor(engine) {
        this.engine = engine;
        this.chunks = new Map();
    }

    reset() {
        this.chunks.clear();
    }

    getChunk(chunkX, chunkY) {
        const key = `${chunkX}|${chunkY}`;
        let chunk = this.chunks.get(key);
        if (!chunk) {
            chunk = new EigenSandChunk(this.engine, chunkX, chunkY, this.engine.chunkSize);
            this.chunks.set(key, chunk);
        }
        return chunk;
    }

    updateChunks(priorityMap) {
        if (!priorityMap) return;
        const processed = new Set();
        const entries = Array.from(priorityMap.entries());
        for (let i = 0; i < entries.length; i++) {
            const [key, priority] = entries[i];
            const parts = key.split('|');
            const chunkX = parseInt(parts[0], 10);
            const chunkY = parseInt(parts[1], 10);
            if (Number.isNaN(chunkX) || Number.isNaN(chunkY)) continue;
            const chunk = this.getChunk(chunkX, chunkY);
            processed.add(key);

            if (priority <= this.engine.maxComputedSandPriority) {
                chunk.ensureIngested();
                chunk.update(this.engine.fixedTimeStep);
            } else if (priority <= this.engine.maxComputedSandPriority + (this.engine.playerChunkBufferRadius || 1)) {
                chunk.ensureIngested();
                chunk.idle(this.engine.fixedTimeStep);
            } else {
                chunk.freeze();
            }
        }

        for (const key of this.chunks.keys()) {
            if (!processed.has(key)) {
                const chunk = this.chunks.get(key);
                if (chunk) {
                    chunk.freeze();
                }
            }
        }
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.EigenSandChunk = EigenSandChunk;
    globalThis.EigenSandManager = EigenSandManager;
}
