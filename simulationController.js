const { Worker } = require('worker_threads');
const path = require('path');
const EventEmitter = require('events');
const DeterministicRandom = require('./deterministic.js');

class SimulationController extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = options;
        this.tickRate = options.tickRate || 60;
        this.stateUpdateRate = options.stateUpdateRate || this.tickRate;
        this.sandUpdateRate = options.sandUpdateRate || 20;
        this.chunkSyncRadius = options.chunkSyncRadius ?? 1;
        this.playerChunkComputeRadius = options.playerChunkComputeRadius ?? 1;
        this.playerChunkBufferRadius = options.playerChunkBufferRadius ?? 1;
        this.maxChunkSyncPerTick = options.maxChunkSyncPerTick || 12;
        this.workerIndex = options.workerIndex ?? 0;
        this.workerCount = options.workerCount ?? 1;

        const seedSource = options.seed
            ?? ((Date.now() ^ (process.pid & 0xffff) << 11) ^ this.workerIndex);
        this.random = DeterministicRandom ? new DeterministicRandom(seedSource >>> 0) : null;

        this.worker = null;
        this.workerRequests = new Map();
        this.nextRequestId = 1;
        this.readyPromise = null;

        this.startWorker();
    }

    startWorker() {
        const workerConfig = {
            seed: this.random ? this.random.nextInt(0xffffffff) : ((Date.now() + this.workerIndex) >>> 0),
            tickRate: this.tickRate,
            stateUpdateRate: this.stateUpdateRate,
            sandUpdateRate: this.sandUpdateRate,
            chunkSyncRadius: this.chunkSyncRadius,
            playerChunkComputeRadius: this.playerChunkComputeRadius,
            playerChunkBufferRadius: this.playerChunkBufferRadius,
            maxChunkSyncPerTick: this.maxChunkSyncPerTick,
            workerIndex: this.workerIndex,
            workerCount: this.workerCount
        };

        const workerPath = path.resolve(__dirname, 'simulationWorker.js');
        this.worker = new Worker(workerPath, { workerData: workerConfig });

        this.worker.on('message', (msg) => this.handleWorkerMessage(msg));
        this.worker.on('error', (error) => {
            this.emit('error', { scope: 'simulationWorker', message: error.message, stack: error.stack });
        });
        this.worker.on('exit', (code) => {
            if (code !== 0) {
                this.emit('error', { scope: 'simulationWorker', message: `worker exited with code ${code}` });
            }
        });

        this.readyPromise = this.request('init', workerConfig)
            .then((meta) => {
                this.meta = meta || {};
                return this.request('start', {});
            })
            .catch((error) => {
                this.emit('error', { scope: 'simulationWorker', message: error.message, stack: error.stack });
                throw error;
            });
    }

    handleWorkerMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'response') {
            const pending = this.workerRequests.get(msg.requestId);
            if (!pending) return;
            this.workerRequests.delete(msg.requestId);
            clearTimeout(pending.timeout);
            pending.resolve(msg.data);
            return;
        }
        if (msg.type === 'event') {
            this.emit(msg.event, msg.data);
        }
    }

    request(type, payload = {}, expectResponse = true) {
        if (!this.worker) {
            return Promise.reject(new Error('Simulation worker not ready'));
        }

        if (!expectResponse) {
            this.worker.postMessage({ type, payload });
            return Promise.resolve();
        }

        const requestId = this.nextRequestId++;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.workerRequests.delete(requestId);
                reject(new Error(`Simulation worker request "${type}" timed out`));
            }, 5000);

            this.workerRequests.set(requestId, { resolve, reject, timeout });
            this.worker.postMessage({ type, payload, requestId });
        });
    }

    async ready() {
        if (this.readyPromise) {
            await this.readyPromise;
            this.readyPromise = null;
        }
    }

    addPlayer(playerId, selectedSpell = 0) {
        return this.request('add_player', { playerId, selectedSpell });
    }

    removePlayer(playerId) {
        return this.request('remove_player', { playerId }, false);
    }

    playerInput(playerId, input) {
        return this.request('player_input', { playerId, input }, false);
    }

    projectile(playerId, message) {
        return this.request('projectile', { playerId, message }, false);
    }

    terrainDestroy(playerId, message) {
        return this.request('terrain_destroy', { playerId, message }, false);
    }

    async destroy() {
        for (const pending of this.workerRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Simulation controller shutting down'));
        }
        this.workerRequests.clear();

        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }
    }
}

module.exports = SimulationController;
