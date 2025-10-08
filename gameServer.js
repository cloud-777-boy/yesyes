const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

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

function createStaticRequestHandler(staticRoot = '.', logger = console) {
    const resolvedRoot = path.resolve(staticRoot);
    return (req, res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');

        const urlPath = req.url.split('?')[0];
        let filePath = path.join(resolvedRoot, urlPath);
        if (filePath === resolvedRoot + '/' || filePath === resolvedRoot + '\\') {
            filePath = path.join(resolvedRoot, 'index.html');
        }

        const extname = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[extname] || 'application/octet-stream';

        fs.readFile(filePath, (error, content) => {
            if (error) {
                if (error.code === 'ENOENT') {
                    res.writeHead(404, { 'Content-Type': 'text/html' });
                    res.end('<h1>404 - File Not Found</h1>', 'utf-8');
                } else {
                    res.writeHead(500);
                    res.end('Server Error: ' + error.code);
                    logger.error('[HTTP] Error serving %s: %s', filePath, error.message);
                }
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content, 'utf-8');
            }
        });
    };
}

class NetworkGameServer {
    constructor(httpServer, options = {}) {
        this.httpServer = httpServer;
        this.options = options;
        this.workerIndex = Number.isFinite(options.workerIndex) ? Number(options.workerIndex) : 0;
        this.workerCount = Number.isFinite(options.workerCount) ? Number(options.workerCount) : 1;
        this.workerLabel = options.workerLabel || `[Worker ${this.workerIndex + 1}/${this.workerCount}]`;

        this.players = new Map(); // playerId -> ws
        this.pendingConnections = new Map(); // requestId -> ws
        this.nextConnectionId = 1;
        this.tick = 0;

        this.logger = options.logger || console;

        this.setupProcessChannel();
        this.setupWebSocketServer();
    }

    log(message, ...args) {
        this.logger.log(`${this.workerLabel} ${message}`, ...args);
    }

    error(message, ...args) {
        this.logger.error(`${this.workerLabel} ${message}`, ...args);
    }

    setupProcessChannel() {
        process.on('message', (msg) => {
            if (!msg || typeof msg !== 'object') return;
            switch (msg.type) {
                case 'cluster:player_connected':
                    this.handlePlayerConnected(msg);
                    break;
                case 'cluster:player_connect_failed':
                    this.handlePlayerConnectFailed(msg);
                    break;
                case 'cluster:send_to_player':
                    this.sendToPlayer(msg.playerId, msg.message);
                    break;
                case 'cluster:broadcast':
                    this.broadcast(msg.message, msg.exclude || null);
                    break;
                case 'cluster:sim_event':
                    this.handleSimulationEvent(msg.event, msg.data);
                    break;
                default:
                    break;
            }
        });
    }

    setupWebSocketServer() {
        this.wss = new WebSocket.Server({ server: this.httpServer });
        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    }

    handleConnection(ws, req) {
        ws.isAlive = true;

        const requestId = this.nextConnectionId++;
        ws.pendingRequestId = requestId;
        this.pendingConnections.set(requestId, ws);

        ws.on('message', (data) => this.handleSocketMessage(ws, data));
        ws.on('close', () => this.handleSocketClose(ws));
        ws.on('error', (error) => {
            this.error('[WebSocket] error: %s', error.message);
            this.handleSocketClose(ws);
        });

        const meta = {
            ip: req.socket.remoteAddress,
            userAgent: req.headers['user-agent'] || ''
        };

        process.send({
            type: 'cluster:player_connect',
            requestId,
            meta
        });
    }

    handleSocketMessage(ws, data) {
        if (!ws.playerId) {
            return;
        }

        let msg;
        try {
            msg = JSON.parse(data);
        } catch (error) {
            this.error('[Message] Failed to parse for %s: %s', ws.playerId, error.message);
            return;
        }

        switch (msg.type) {
            case 'input':
                process.send({
                    type: 'cluster:player_input',
                    playerId: ws.playerId,
                    input: msg.input || {}
                });
                break;
            case 'projectile':
                process.send({
                    type: 'cluster:projectile',
                    playerId: ws.playerId,
                    message: msg
                });
                break;
            case 'terrain_destroy':
                process.send({
                    type: 'cluster:terrain_destroy',
                    playerId: ws.playerId,
                    message: msg
                });
                break;
            case 'ping':
                this.sendToPlayer(ws.playerId, {
                    type: 'pong',
                    timestamp: msg.timestamp,
                    serverTime: Date.now()
                });
                break;
            default:
                break;
        }
    }

    handleSocketClose(ws) {
        if (ws.pendingRequestId && this.pendingConnections.has(ws.pendingRequestId)) {
            this.pendingConnections.delete(ws.pendingRequestId);
        }

        if (ws.playerId) {
            const playerId = ws.playerId;
            this.players.delete(playerId);
            process.send({
                type: 'cluster:player_disconnect',
                playerId
            });
        }
    }

    handlePlayerConnected(msg) {
        const { requestId, playerId, welcome, existingPlayers } = msg;
        const ws = this.pendingConnections.get(requestId);
        if (!ws) {
            // Connection might have closed before the handshake completed; inform master to clean up.
            process.send({ type: 'cluster:player_disconnect', playerId });
            return;
        }

        this.pendingConnections.delete(requestId);
        ws.playerId = playerId;
        delete ws.pendingRequestId;
        this.players.set(playerId, ws);

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

        this.log(`Player ${playerId} connected (clients=${this.players.size})`);
    }

    handlePlayerConnectFailed(msg) {
        const { requestId, reason } = msg;
        const ws = this.pendingConnections.get(requestId);
        if (!ws) return;
        this.pendingConnections.delete(requestId);
        try {
            ws.close(1011, reason || 'Server error');
        } catch (error) {
            this.error('[ConnectFailed] closing socket: %s', error.message);
        }
    }

    handleSimulationEvent(event, data) {
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
            case 'terrain_static':
                this.broadcast({ type: 'terrain_static', ...data });
                break;
            case 'terrain_static_clear':
                this.broadcast({ type: 'terrain_static_clear', ...data });
                break;
            case 'broadcast':
                if (data && data.message) {
                    this.broadcast(data.message, data.exclude || null);
                }
                break;
            case 'log':
                if (data) {
                    this.log(`[Sim] ${JSON.stringify(data)}`);
                }
                break;
            case 'error':
                if (data) {
                    this.error('[Sim] %o', data);
                }
                break;
            default:
                break;
        }
    }

    sendToPlayer(playerId, message) {
        const ws = this.players.get(playerId);
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            ws.send(JSON.stringify(message));
        } catch (error) {
            this.error('[Send] failed for %s: %s', playerId, error.message);
        }
    }

    broadcast(message, excludePlayerId = null) {
        if (!message) return;
        const payload = JSON.stringify(message);
        for (const [playerId, ws] of this.players.entries()) {
            if (excludePlayerId && excludePlayerId === playerId) continue;
            if (!ws || ws.readyState !== WebSocket.OPEN) continue;
            try {
                ws.send(payload);
            } catch (error) {
                this.error('[Broadcast] failed for %s: %s', playerId, error.message);
            }
        }
    }

    async destroy() {
        for (const ws of this.players.values()) {
            try {
                ws.close(1001, 'Server shutting down');
            } catch (error) {
                // ignore
            }
        }
        this.players.clear();
        this.pendingConnections.clear();

        await new Promise((resolve) => {
            this.wss.close(() => resolve());
        });
    }
}

async function startNetworkServer(options = {}) {
    const port = Number.isFinite(options.port) ? Number(options.port) : 5000;
    const staticRoot = options.staticRoot || '.';

    const httpServer = http.createServer(createStaticRequestHandler(staticRoot));
    const networkServer = new NetworkGameServer(httpServer, options);

    await new Promise((resolve) => {
        httpServer.listen(port, '0.0.0.0', () => {
            networkServer.log(`Listening on port ${port} (pid ${process.pid})`);
            resolve();
        });
    });

    const shutdown = async () => {
        await networkServer.destroy();
        await new Promise((resolve) => {
            httpServer.close(() => resolve());
        });
    };

    return { httpServer, networkServer, shutdown };
}

module.exports = {
    startNetworkServer,
    createStaticRequestHandler
};
