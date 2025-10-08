const cluster = require('cluster');
const os = require('os');

const SimulationController = require('./simulationController');
const { startNetworkServer } = require('./gameServer');

const DEFAULT_PORT = Number(process.env.PORT) || 5000;
const DEFAULT_STATIC_ROOT = process.env.STATIC_ROOT || '.';
const DEFAULT_WORKERS = (() => {
    const requested = process.env.WORKERS ? Number(process.env.WORKERS) : NaN;
    if (Number.isFinite(requested) && requested > 0) {
        return Math.max(1, Math.floor(requested));
    }
    return Math.max(1, os.cpus().length);
})();

if (cluster.isPrimary) {
    (async () => {
        const simulation = new SimulationController({
            tickRate: Number(process.env.TICK_RATE) || 60,
            stateUpdateRate: Number(process.env.STATE_UPDATE_RATE) || 60,
            sandUpdateRate: Number(process.env.SAND_UPDATE_RATE) || 20,
            chunkSyncRadius: Number(process.env.CHUNK_SYNC_RADIUS) || 1,
            playerChunkComputeRadius: Number(process.env.PLAYER_CHUNK_COMPUTE_RADIUS) || 1,
            playerChunkBufferRadius: Number(process.env.PLAYER_CHUNK_BUFFER_RADIUS) || 1,
            maxChunkSyncPerTick: Number(process.env.MAX_CHUNK_SYNC_PER_TICK) || 12
        });

        await simulation.ready();
        console.log(`[Master ${process.pid}] Simulation ready. Spawning ${DEFAULT_WORKERS} worker(s) on port ${DEFAULT_PORT}`);

        let playerCounter = 0;
        const playerToWorker = new Map();
        const workerToPlayers = new Map();

        const broadcastToWorkers = (message) => {
            for (const id in cluster.workers) {
                const worker = cluster.workers[id];
                if (worker && worker.isConnected()) {
                    worker.send(message);
                }
            }
        };

        const sendToWorker = (workerId, message) => {
            const worker = cluster.workers[workerId];
            if (worker && worker.isConnected()) {
                worker.send(message);
            }
        };

        const sendToPlayer = (playerId, message) => {
            const workerId = playerToWorker.get(playerId);
            if (!workerId) return;
            sendToWorker(workerId, {
                type: 'cluster:send_to_player',
                playerId,
                message
            });
        };

        simulation.on('state', (data) => {
            broadcastToWorkers({ type: 'cluster:sim_event', event: 'state', data });
        });
        simulation.on('sand_update', (data) => {
            broadcastToWorkers({ type: 'cluster:sim_event', event: 'sand_update', data });
        });
        simulation.on('terrain_static', (data) => {
            broadcastToWorkers({ type: 'cluster:sim_event', event: 'terrain_static', data });
        });
        simulation.on('terrain_static_clear', (data) => {
            broadcastToWorkers({ type: 'cluster:sim_event', event: 'terrain_static_clear', data });
        });
        simulation.on('broadcast', (data) => {
            broadcastToWorkers({ type: 'cluster:broadcast', message: data.message, exclude: data.exclude || null });
        });
        simulation.on('send_to_player', (data) => {
            if (!data || !data.playerId || !data.message) return;
            sendToPlayer(data.playerId, data.message);
        });
        simulation.on('error', (data) => {
            console.error('[Simulation] error:', data);
        });

        const handleWorkerMessage = async (worker, msg) => {
            if (!msg || typeof msg !== 'object') return;
            try {
                switch (msg.type) {
                    case 'cluster:player_connect': {
                        const requestId = msg.requestId;
                        playerCounter += 1;
                        const playerId = `player-${playerCounter.toString(36)}`;
                        const selectedSpell = Math.floor(Math.random() * 4);
                        try {
                            const result = await simulation.addPlayer(playerId, selectedSpell);
                            playerToWorker.set(playerId, worker.id);
                            let set = workerToPlayers.get(worker.id);
                            if (!set) {
                                set = new Set();
                                workerToPlayers.set(worker.id, set);
                            }
                            set.add(playerId);

                            worker.send({
                                type: 'cluster:player_connected',
                                requestId,
                                playerId,
                                welcome: result ? result.welcome : null,
                                existingPlayers: result ? result.existingPlayers : [],
                                selectedSpell
                            });
                        } catch (error) {
                            worker.send({
                                type: 'cluster:player_connect_failed',
                                requestId,
                                reason: error.message || 'Simulation error'
                            });
                        }
                        break;
                    }
                    case 'cluster:player_input':
                        simulation.playerInput(msg.playerId, msg.input || {});
                        break;
                    case 'cluster:projectile':
                        simulation.projectile(msg.playerId, msg.message || {});
                        break;
                    case 'cluster:terrain_destroy':
                        simulation.terrainDestroy(msg.playerId, msg.message || {});
                        break;
                    case 'cluster:player_disconnect': {
                        const playerId = msg.playerId;
                        if (!playerId) break;
                        const workerSet = workerToPlayers.get(worker.id);
                        if (workerSet) {
                            workerSet.delete(playerId);
                        }
                        playerToWorker.delete(playerId);
                        simulation.removePlayer(playerId);
                        break;
                    }
                    default:
                        break;
                }
            } catch (error) {
                console.error(`[Master ${process.pid}] Error handling worker message:`, error);
            }
        };

        const spawnWorker = (index) => {
            const env = {
                WORKER_INDEX: String(index),
                WORKER_COUNT: String(DEFAULT_WORKERS),
                PORT: String(DEFAULT_PORT),
                STATIC_ROOT: DEFAULT_STATIC_ROOT
            };
            const worker = cluster.fork(env);
            worker.on('message', (msg) => handleWorkerMessage(worker, msg));
            worker.on('exit', (code, signal) => {
                const set = workerToPlayers.get(worker.id);
                if (set) {
                    for (const playerId of set.values()) {
                        playerToWorker.delete(playerId);
                        simulation.removePlayer(playerId);
                    }
                    workerToPlayers.delete(worker.id);
                }
                console.error(`[Master ${process.pid}] Worker ${worker.process.pid} exited (code=${code}, signal=${signal || 'none'}) – respawning`);
                spawnWorker(index);
            });
            console.log(`[Master ${process.pid}] Spawned worker #${index + 1} (pid ${worker.process.pid})`);
        };

        for (let i = 0; i < DEFAULT_WORKERS; i += 1) {
            spawnWorker(i);
        }

        const graceful = async (signal) => {
            console.log(`[Master ${process.pid}] Received ${signal}, shutting down`);
            for (const id in cluster.workers) {
                const worker = cluster.workers[id];
                if (worker && worker.isConnected()) {
                    worker.send({ type: 'cluster:shutdown' });
                }
            }
            await simulation.destroy();
            process.exit(0);
        };

        process.on('SIGINT', () => graceful('SIGINT'));
        process.on('SIGTERM', () => graceful('SIGTERM'));
    })().catch((error) => {
        console.error(`[Master ${process.pid}] Failed to start:`, error);
        process.exit(1);
    });
} else {
    const workerIndex = Number(process.env.WORKER_INDEX || (cluster.worker ? cluster.worker.id - 1 : 0));
    const workerCount = Number(process.env.WORKER_COUNT || DEFAULT_WORKERS);
    const port = Number(process.env.PORT) || DEFAULT_PORT;
    const staticRoot = process.env.STATIC_ROOT || DEFAULT_STATIC_ROOT;

    (async () => {
        try {
            const { shutdown } = await startNetworkServer({
                port,
                staticRoot,
                workerIndex,
                workerCount,
                workerLabel: `[Worker ${workerIndex + 1}/${workerCount}]`
            });

            const graceful = async (signal) => {
                console.log(`[Worker ${process.pid}] Received ${signal}, shutting down`);
                try {
                    await shutdown();
                } finally {
                    process.exit(0);
                }
            };

            process.on('SIGINT', () => graceful('SIGINT'));
            process.on('SIGTERM', () => graceful('SIGTERM'));

            process.on('message', (msg) => {
                if (msg && msg.type === 'cluster:shutdown') {
                    graceful('cluster:shutdown');
                }
            });
        } catch (error) {
            console.error(`[Worker ${process.pid}] Failed to start network server:`, error);
            process.exit(1);
        }
    })();
}
