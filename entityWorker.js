const { parentPort, workerData } = require('worker_threads');
const DeterministicRandom = require('./deterministic.js');
require('./terrain.js');
require('./physics.js');
require('./player.js');
require('./projectile.js');
const GameEngine = require('./engine.js');

class EntityWorkerCore {
    constructor(config = {}) {
        this.config = config;
        this.seed = config.seed ?? ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
        this.engine = null;
        this.ready = false;
        this.terrainModifications = [];
    }

    initialize(config = {}) {
        const width = config.width || workerData.width || 11200;
        const height = config.height || workerData.height || 900;
        const chunkSize = config.chunkSize || workerData.chunkSize || 64;
        const seed = config.seed ?? this.seed;

        this.engine = new GameEngine(null, true, {
            seed,
            width,
            height
        });
        this.engine.chunkSize = chunkSize;
        this.engine.init(true);

        this.terrainModifications = [];
        this.engine.onTerrainDestruction = ({ x, y, radius, explosive, broadcast }) => {
            this.terrainModifications.push({ x, y, radius, explosive });
        };

        if (config.terrainSnapshot) {
            this.engine.loadTerrainSnapshot(config.terrainSnapshot);
        }

        this.ready = true;
    }

    processUpdate(payload = {}) {
        if (!this.ready || !this.engine) {
            throw new Error('Entity worker not initialized');
        }

        const dt = Number.isFinite(payload.dt) ? payload.dt : (this.engine.fixedTimeStep || (1000 / 60));
        const tick = Number.isFinite(payload.tick) ? payload.tick : this.engine.tick;
        const keys = Array.isArray(payload.keys) ? payload.keys : null;
        const keySet = keys ? new Set(keys) : null;

        if (payload.terrainSnapshot && payload.terrainSnapshot.chunks && payload.terrainSnapshot.chunks.length) {
            this.engine.terrain.applyChunkSnapshots(payload.terrainSnapshot);
        }

        if (payload.entities) {
            this.engine.applyEntitySnapshot(payload.entities);
        }

        this.engine.tick = tick;
        this.engine.updateEntities(dt, keySet);

        const entities = this.engine.serializeEntities(keySet, true);
        const diffs = this.engine.terrain.getModifications();
        const mods = this.terrainModifications.splice(0);
        const dirtyChunks = new Set(keys || []);
        if (diffs && Array.isArray(diffs.chunks)) {
            for (const chunk of diffs.chunks) {
                if (chunk && typeof chunk.key === 'string') {
                    dirtyChunks.add(chunk.key);
                }
            }
        }

        const chunkSize = this.engine.chunkSize || 64;
        const chunkWidth = Math.max(1, Math.ceil(this.engine.width / chunkSize));
        const chunkHeight = Math.max(1, Math.ceil(this.engine.height / chunkSize));

        for (const mod of mods) {
            if (!mod) continue;
            const cx = Math.floor(mod.x / chunkSize);
            const cy = Math.floor(mod.y / chunkSize);
            const radiusChunks = Math.max(0, Math.ceil((mod.radius || 0) / chunkSize)) + 1;
            for (let dy = -radiusChunks; dy <= radiusChunks; dy++) {
                const chunkY = Math.max(0, Math.min(chunkHeight - 1, cy + dy));
                for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
                    const chunkX = ((cx + dx) % chunkWidth + chunkWidth) % chunkWidth;
                    dirtyChunks.add(`${chunkX}|${chunkY}`);
                }
            }
        }

        const chunkSnapshot = dirtyChunks.size
            ? this.engine.terrain.serializeChunksForKeys(dirtyChunks)
            : null;

        return {
            entities,
            terrainMods: mods,
            terrainModifications: diffs,
            chunkSnapshot,
            dirtyChunks: Array.from(dirtyChunks)
        };
    }
}

const core = new EntityWorkerCore(workerData);

function respond(requestId, data) {
    if (!parentPort) return;
    parentPort.postMessage({ type: 'response', requestId, data });
}

if (!parentPort) {
    module.exports = EntityWorkerCore;
} else {
parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const { type, requestId, payload } = msg;
    try {
        switch (type) {
            case 'init':
                core.initialize(payload || {});
                respond(requestId, { ok: true });
                break;
            case 'update':
                respond(requestId, core.processUpdate(payload || {}));
                break;
            default:
                respond(requestId, { error: `Unknown message type: ${type}` });
                break;
        }
    } catch (error) {
        respond(requestId, { error: error.message, stack: error.stack });
    }
});
}
