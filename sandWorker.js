const { parentPort, workerData } = require('worker_threads');
const DeterministicRandom = require('./deterministic.js');
require('./terrain.js');
require('./physics.js');
require('./player.js');
require('./projectile.js');
const GameEngine = require('./engine.js');

class SandWorkerCore {
    constructor(config = {}) {
        this.config = config;
        this.seed = config.seed ?? ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
        this.engine = null;
        this.ready = false;
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

        if (config.terrainSnapshot) {
            this.engine.loadTerrainSnapshot(config.terrainSnapshot);
        }

        this.ready = true;
    }

    processUpdate(payload = {}) {
        if (!this.ready || !this.engine) {
            throw new Error('Sand worker not initialized');
        }

        const dt = Number.isFinite(payload.dt) ? payload.dt : (this.engine.fixedTimeStep || (1000 / 60));
        const tick = Number.isFinite(payload.tick) ? payload.tick : this.engine.tick;
        const keys = Array.isArray(payload.keys) ? payload.keys : [];

        if (payload.terrainSnapshot && payload.terrainSnapshot.chunks && payload.terrainSnapshot.chunks.length) {
            this.engine.terrain.applyChunkSnapshots(payload.terrainSnapshot);
        }

        this.engine.clearSandChunks();
        if (payload.sandSnapshot && Array.isArray(payload.sandSnapshot.chunks)) {
            const snapshot = {
                ...payload.sandSnapshot,
                includeState: !!payload.sandSnapshot.includeState,
                chunkSize: payload.sandSnapshot.chunkSize || this.engine.chunkSize
            };
            this.engine.applySandSnapshot(snapshot, true);
        }

        this.engine.tick = tick;
        this.engine.updateSand(dt);

        const targetKeys = keys.length
            ? keys
            : (this.engine.activeSandChunkKeys && this.engine.activeSandChunkKeys.length
                ? Array.from(this.engine.activeSandChunkKeys)
                : []);

        let sandSnapshot = targetKeys.length
            ? this.engine.serializeSandChunksForKeys(targetKeys, { includeState: true })
            : this.engine.serializeSandChunks(true, { includeState: true });

        if (!sandSnapshot) {
            sandSnapshot = {
                chunkSize: this.engine.chunkSize,
                chunks: [],
                full: false,
                includeState: true
            };
        }

        const dirtyKeys = this.engine.dirtySandChunkKeys
            ? Array.from(this.engine.dirtySandChunkKeys)
            : [];
        if (dirtyKeys.length) {
            this.engine.clearDirtySandChunks(dirtyKeys);
        }

        return {
            sandSnapshot,
            dirtyKeys,
            sandCount: this.engine.sandParticleCount
        };
    }
}

const core = new SandWorkerCore(workerData);

function respond(requestId, data) {
    parentPort.postMessage({ type: 'response', requestId, data });
}

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
