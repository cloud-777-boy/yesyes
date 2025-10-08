const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Worker } = require('worker_threads');
const DeterministicRandom = require('./deterministic.js');

const PORT = process.env.PORT || 5000;

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.woff': 'application/font-woff',
    '.ttf': 'application/font-ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'application/font-otf',
    '.wasm': 'application/wasm'
};

const httpServer = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    const urlPath = req.url.split('?')[0];
    let filePath = '.' + urlPath;
    if (filePath === './') {
        filePath = './index.html';
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 - File Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

class GameServer {
    constructor(httpServer) {
        this.wss = new WebSocket.Server({ server: httpServer });

        this.players = new Map();
        this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
        this.random = DeterministicRandom ? new DeterministicRandom(this.seed) : null;

        this.tickRate = 60;
        this.stateUpdateRate = 20;
        this.sandUpdateRate = 20;
        this.chunkSyncRadius = 1;

        this.playerCounter = 0;
        this.totalMessages = 0;
        this.startTime = Date.now();
        this.tick = 0;

        this.worker = null;
        this.workerRequests = new Map();
        this.nextRequestId = 1;
        this.simulationMeta = {};
        this.simReadyPromise = null;

        this.setupWorker();
        this.setupServer();
    }

    setupWorker() {
        const workerConfig = {
            seed: this.seed,
            tickRate: this.tickRate,
            stateUpdateRate: this.stateUpdateRate,
            sandUpdateRate: this.sandUpdateRate,
            chunkSyncRadius: this.chunkSyncRadius,
            playerChunkComputeRadius: 1,
            playerChunkBufferRadius: 1,
            maxChunkSyncPerTick: 4
        };

        const workerPath = path.resolve(__dirname, 'simulationWorker.js');
        this.worker = new Worker(workerPath, { workerData: workerConfig });

        this.worker.on('message', (msg) => this.handleWorkerMessage(msg));
        this.worker.on('error', (error) => {
            console.error('[SimulationWorker] error:', error);
        });
        this.worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`[SimulationWorker] exited with code ${code}`);
            }
        });

        this.simReadyPromise = this.postToWorker('init', workerConfig)
            .then((meta) => {
                this.simulationMeta = meta || {};
                return this.postToWorker('start', {});
            })
            .catch((error) => {
                console.error('[SimulationWorker] initialization failed:', error);
                throw error;
            });
    }

    setupServer() {
        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req).catch((error) => {
                console.error('[GameServer] Connection setup failed:', error);
                ws.close();
            });
        });

        console.log(`🎮 Game server listening on port ${PORT}`);
        console.log(`📊 Tick rate: ${this.tickRate}Hz, State updates: ${this.stateUpdateRate}Hz`);
    }

    async handleConnection(ws, req) {
        await this.ensureSimulationReady();

        const playerId = this.generatePlayerId();
        const selectedSpell = this.getRandomSpellIndex(playerId);
        this.players.set(playerId, {
            ws,
            selectedSpell
        });

        let welcomeData;
        try {
            welcomeData = await this.postToWorker('add_player', { playerId, selectedSpell });
        } catch (error) {
            console.error(`[GameServer] Failed to add player ${playerId}:`, error);
            this.players.delete(playerId);
            ws.close();
            return;
        }

        const { welcome, existingPlayers } = welcomeData || {};
        if (welcome) {
            this.sendToPlayer(playerId, welcome);
        }

        if (Array.isArray(existingPlayers)) {
            for (const info of existingPlayers) {
                this.sendToPlayer(playerId, {
                    type: 'player_joined',
                    playerId: info.playerId,
                    x: info.x,
                    y: info.y,
                    selectedSpell: info.selectedSpell
                });
            }
        }

        ws.on('message', (data) => {
            this.totalMessages += 1;
            this.handleIncomingMessage(playerId, data);
        });

        ws.on('close', () => {
            this.handleDisconnect(playerId);
        });

        ws.on('error', (error) => {
            console.error(`[WebSocket] error for ${playerId}:`, error);
        });
    }

    handleIncomingMessage(playerId, data) {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (error) {
            console.error(`[GameServer] Failed to parse message from ${playerId}:`, error);
            return;
        }
        this.handleMessage(playerId, msg);
    }

    handleMessage(playerId, msg) {
        const player = this.players.get(playerId);
        if (!player) return;

        switch (msg.type) {
            case 'input':
                this.handlePlayerInput(playerId, msg.input || {});
                break;
            case 'projectile':
                this.handleProjectile(playerId, msg);
                break;
            case 'terrain_destroy':
                this.handleTerrainDestruction(playerId, msg);
                break;
            case 'ping':
                this.sendToPlayer(playerId, {
                    type: 'pong',
                    timestamp: msg.timestamp
                });
                break;
            default:
                break;
        }
    }

    handlePlayerInput(playerId, input) {
        this.postToWorker('player_input', { playerId, input }, false);
    }

    handleProjectile(playerId, message) {
        this.postToWorker('projectile', { playerId, message }, false);
    }

    handleTerrainDestruction(playerId, message) {
        this.postToWorker('terrain_destroy', { playerId, message }, false);
    }

    handleDisconnect(playerId) {
        const entry = this.players.get(playerId);
        if (!entry) return;
        this.players.delete(playerId);
        this.postToWorker('remove_player', { playerId }, false);
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
            this.handleWorkerEvent(msg.event, msg.data);
        }
    }

    handleWorkerEvent(event, data) {
        switch (event) {
            case 'state':
                if (data && typeof data.tick === 'number') {
                    this.tick = data.tick;
                }
                this.broadcast({ type: 'state', ...data });
                break;
            case 'sand_update':
                this.broadcast({ type: 'sand_update', ...data });
                break;
            case 'broadcast': {
                if (data && data.message) {
                    this.broadcast(data.message, data.exclude || null);
                }
                break;
            }
            case 'send_to_player': {
                if (data && data.playerId && data.message) {
                    this.sendToPlayer(data.playerId, data.message);
                }
                break;
            }
            case 'log': {
                if (data) {
                    const uptime = data.uptime != null ? `${data.uptime}s` : 'n/a';
                    console.log(`📊 [Sim] players=${data.players} tick=${data.tick} uptime=${uptime} msgs/sec=${data.messagesPerSecond || '0.00'}`);
                }
                break;
            }
            case 'error': {
                if (data) {
                    console.error('[SimulationWorker] error event:', data);
                }
                break;
            }
            default:
                break;
        }
    }

    postToWorker(type, payload = {}, expectResponse = true) {
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

    async ensureSimulationReady() {
        if (this.simReadyPromise) {
            await this.simReadyPromise;
        }
    }

    sendToPlayer(playerId, message) {
        const entry = this.players.get(playerId);
        if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            entry.ws.send(JSON.stringify(message));
        } catch (error) {
            console.error(`[GameServer] Failed to send message to ${playerId}:`, error);
        }
    }

    broadcast(message, excludePlayerId = null) {
        const payload = JSON.stringify(message);
        for (const [id, entry] of this.players.entries()) {
            if (excludePlayerId && excludePlayerId === id) continue;
            if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) continue;
            try {
                entry.ws.send(payload);
            } catch (error) {
                console.error(`[GameServer] Broadcast to ${id} failed:`, error);
            }
        }
    }

    generatePlayerId() {
        this.playerCounter += 1;
        return `player-${this.playerCounter.toString(36)}`;
    }

    getRandomSpellIndex(id = '') {
        if (this.random && typeof this.random.fork === 'function') {
            const rng = this.random.fork(`spell:${id}`);
            return rng.nextInt(4);
        }
        return Math.floor(Math.random() * 4);
    }
}

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP + WebSocket server running on port ${PORT}`);
});

const gameServer = new GameServer(httpServer);

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down servers...');
    httpServer.close(() => {
        console.log('✅ HTTP server closed');
    });
    gameServer.wss.close(() => {
        console.log('✅ WebSocket server closed');
        if (gameServer.worker) {
            gameServer.worker.terminate().finally(() => process.exit(0));
        } else {
            process.exit(0);
        }
    });
});
