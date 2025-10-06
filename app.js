const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const DeterministicRandom = require('./deterministic.js');
require('./terrain.js');
require('./physics.js');
require('./player.js');
require('./projectile.js');
const GameEngine = require('./engine.js');

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
    // Aggressive cache busting for Replit deployment
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    // Strip query string for file serving (e.g., ?v=timestamp)
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
        this.tick = 0;
        this.terrainModifications = [];
        this.maxTerrainModHistory = 1024;
        this.maxTerrainModBroadcast = 64;
        this.terrainSnapshot = null;
        this.pendingTerrainBroadcasts = [];
        this.playerCounter = 0;
        this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
        this.random = DeterministicRandom ? new DeterministicRandom(this.seed) : null;
        this.engine = null;

        this.tickRate = 60;
        this.stateUpdateRate = 20;
        
        // Sand update throttling with spatial filtering
        this.sandUpdateRate = 20; // Increased to 20Hz since we only send nearby chunks
        this.sandChunkRadius = 15; // Number of chunks around players to update
        this.lastSandUpdateTime = 0;
        this.hasPendingSandUpdate = false;
        
        this.startTime = Date.now();
        this.totalMessages = 0;

        this.initializeEngine();
        this.setupServer();
        this.startGameLoop();
    }
    
    initializeEngine() {
        console.log(`[${new Date().toISOString()}] Generating server terrain with seed: ${this.seed}`);
        this.engine = new GameEngine(null, true, { seed: this.seed });
        this.engine.init();
        this.engine.onProjectileSpawn = (projectile) => this.handleServerProjectileSpawn(projectile);
        this.engine.onTerrainDestruction = ({ x, y, radius, explosive, broadcast }) => {
            if (broadcast === false) return;
            this.recordAndBroadcastTerrainModification(x, y, radius, explosive);
        };
        // IMMEDIATE REAL-TIME SAND BROADCAST - NO THROTTLING
        this.engine.onSandUpdate = (payload) => {
            if (payload && payload.chunks && payload.chunks.length > 0) {
                this.broadcast({
                    type: 'sand_update',
                    chunkSize: payload.chunkSize,
                    chunks: payload.chunks,
                    full: false
                });
            }
        };
        this.terrainSnapshot = this.engine.getTerrainSnapshot();
        this.tick = this.engine.tick;
        const pixelLength = this.terrainSnapshot && this.terrainSnapshot.pixels
            ? this.terrainSnapshot.pixels.length
            : 0;
        console.log(`[${new Date().toISOString()}] Server terrain generated successfully (${pixelLength} chars base64)`);
    }

    handleServerProjectileSpawn(projectile) {
        if (!projectile) return;
        const payload = {
            type: 'projectile',
            x: projectile.x,
            y: projectile.y,
            vx: projectile.vx,
            vy: projectile.vy,
            type: projectile.type,
            ownerId: projectile.ownerId,
            clientProjectileId: projectile.clientProjectileId || null,
            lifetime: projectile.lifetime
        };
        this.broadcast(payload);
    }

    recordAndBroadcastTerrainModification(x, y, radius, explosive) {
        const mod = {
            tick: this.tick,
            x,
            y,
            radius,
            explosive
        };
        this.terrainModifications.push(mod);
        if (this.terrainModifications.length > this.maxTerrainModHistory) {
            this.terrainModifications.splice(0, this.terrainModifications.length - this.maxTerrainModHistory);
        }
        this.pendingTerrainBroadcasts.push(mod);
        if (this.pendingTerrainBroadcasts.length > this.maxTerrainModBroadcast) {
            this.pendingTerrainBroadcasts.splice(0, this.pendingTerrainBroadcasts.length - this.maxTerrainModBroadcast);
        }
        this.broadcast({
            type: 'terrain_update',
            x,
            y,
            radius,
            explosive,
            tick: mod.tick
        });
    }
    
    setupServer() {
        this.wss.on('connection', (ws, req) => {
            const playerId = this.generatePlayerId();
            const clientIP = req.socket.remoteAddress;
            
            console.log(`[${new Date().toISOString()}] Player ${playerId} connected from ${clientIP}`);
            
            const playerRng = this.random ? this.random.fork(`player:${playerId}`) : null;
            const spawnX = playerRng ? playerRng.nextRange(400, 1200) : Math.random() * 1200 + 200;
            const spawnY = 100;
            const player = {
                id: playerId,
                ws,
                selectedSpell: this.getRandomSpellIndex(playerId),
                lastInputSequence: 0,
                joinTime: Date.now()
            };

            this.players.set(playerId, player);

            let enginePlayer = null;
            if (this.engine && typeof this.engine.addPlayer === 'function') {
                enginePlayer = this.engine.addPlayer(playerId, spawnX, spawnY, player.selectedSpell);
                if (enginePlayer) {
                    enginePlayer.alive = true;
                }
            }

            const welcomePayload = {
                type: 'welcome',
                playerId,
                tick: this.tick,
                spawnX: enginePlayer ? enginePlayer.x : spawnX,
                spawnY: enginePlayer ? enginePlayer.y : spawnY,
                selectedSpell: player.selectedSpell,
                seed: this.seed,
                terrainSnapshot: this.terrainSnapshot,
                terrainMods: this.terrainModifications.slice(-this.maxTerrainModBroadcast)
            };
            if (this.engine) {
                if (typeof this.engine.chunkSize === 'number') {
                    welcomePayload.chunkSize = this.engine.chunkSize;
                }
                const sandSnapshot = this.engine.serializeSandChunks(false);
                if (sandSnapshot) {
                    welcomePayload.sandChunks = sandSnapshot;
                }
            }
            console.log(`[${new Date().toISOString()}] Sending welcome to ${playerId} with terrain: ${this.terrainSnapshot ? 'YES' : 'NO'}`);
            this.sendToPlayer(playerId, welcomePayload);
            
            this.broadcast({
                type: 'player_joined',
                playerId,
                x: enginePlayer ? enginePlayer.x : spawnX,
                y: enginePlayer ? enginePlayer.y : spawnY,
                selectedSpell: player.selectedSpell
            }, playerId);
            
            for (const [id, p] of this.players.entries()) {
                if (id !== playerId) {
                    const existing = this.engine ? this.engine.players.get(id) : null;
                    this.sendToPlayer(playerId, {
                        type: 'player_joined',
                        playerId: id,
                        x: existing ? existing.x : 0,
                        y: existing ? existing.y : 0,
                        selectedSpell: p.selectedSpell
                    });
                }
            }
            
            ws.on('message', (data) => {
                this.totalMessages++;
                try {
                    const msg = JSON.parse(data);
                    this.handleMessage(playerId, msg);
                } catch (error) {
                    console.error(`Error parsing message from ${playerId}:`, error);
                }
            });
            
            ws.on('close', () => {
                console.log(`[${new Date().toISOString()}] Player ${playerId} disconnected`);
                this.players.delete(playerId);
                if (this.engine && typeof this.engine.removePlayer === 'function') {
                    this.engine.removePlayer(playerId);
                }
                
                this.broadcast({
                    type: 'player_left',
                    playerId
                });
            });
            
            ws.on('error', (error) => {
                console.error(`WebSocket error for ${playerId}:`, error);
            });
        });
        
        console.log(`🎮 WebSocket server attached to HTTP server`);
        console.log(`📊 Tick rate: ${this.tickRate}Hz, State updates: ${this.stateUpdateRate}Hz`);
    }
    
    handleMessage(playerId, msg) {
        const player = this.players.get(playerId);
        if (!player) return;
        
        switch (msg.type) {
            case 'input':
                this.handlePlayerInput(playerId, msg.input);
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
        }
    }
    
    handlePlayerInput(playerId, input) {
        const playerInfo = this.players.get(playerId);
        const enginePlayer = this.engine ? this.engine.players.get(playerId) : null;
        if (!playerInfo || !enginePlayer || !enginePlayer.alive) return;

        enginePlayer.input = {
            left: !!input.left,
            right: !!input.right,
            jump: !!input.jump,
            shoot: !!input.shoot,
            mouseX: typeof input.mouseX === 'number' ? input.mouseX : enginePlayer.x,
            mouseY: typeof input.mouseY === 'number' ? input.mouseY : enginePlayer.y
        };

        if (enginePlayer.normalizeSpellIndex && typeof input.selectedSpell === 'number') {
            enginePlayer.selectedSpell = enginePlayer.normalizeSpellIndex(input.selectedSpell);
            playerInfo.selectedSpell = enginePlayer.selectedSpell;
        }

        if (typeof input.sequence === 'number') {
            playerInfo.lastInputSequence = input.sequence;
            this.sendToPlayer(playerId, {
                type: 'input_ack',
                sequence: input.sequence
            });
        }
    }

    handleProjectile(playerId, msg) {
        if (!this.engine) return;
        const playerInfo = this.players.get(playerId);
        const ownerId = playerInfo ? playerInfo.id : playerId;

        const x = typeof msg.x === 'number' ? msg.x : null;
        const y = typeof msg.y === 'number' ? msg.y : null;
        const vx = typeof msg.vx === 'number' ? msg.vx : 0;
        const vy = typeof msg.vy === 'number' ? msg.vy : 0;
        const type = typeof msg.type === 'string' ? msg.type : 'fireball';

        if (x === null || y === null) return;

        const projectile = this.engine.spawnProjectile(x, y, vx, vy, type, ownerId, {
            clientProjectileId: msg.clientProjectileId || null
        });
        if (projectile) {
            // Immediately run an authoritative update step to resolve collisions
            const dt = this.engine.fixedTimeStep || (1000 / this.tickRate);
            projectile.update(dt, this.engine);
            if (projectile.dead) {
                return;
            }
        }
    }

    handleTerrainDestruction(playerId, msg) {
        if (!this.engine) return;
        this.engine.destroyTerrain(msg.x, msg.y, msg.radius, !!msg.explosive);
    }

    
    startGameLoop() {
        const tickInterval = 1000 / this.tickRate;
        const stateInterval = 1000 / this.stateUpdateRate;
        const sandInterval = 1000 / this.sandUpdateRate;
        
        setInterval(() => {
            this.updatePhysics();
        }, tickInterval);
        
        setInterval(() => {
            this.broadcastState();
        }, stateInterval);
        
        setInterval(() => {
            this.logStats();
        }, 10000);
    }
    
    updatePhysics() {
        if (!this.engine) return;
        const dt = this.engine.fixedTimeStep || (1000 / this.tickRate);
        this.engine.update(dt);
        this.engine.tick += 1;
        this.tick = this.engine.tick;
    }
    
    broadcastState() {
        if (!this.engine) return;

        const players = this.engine.playerList.map((player) => ({
            id: player.id,
            x: player.x,
            y: player.y,
            vx: player.vx,
            vy: player.vy,
            health: player.health,
            alive: player.alive,
            aimAngle: player.aimAngle,
            selectedSpell: player.selectedSpell,
            lastProcessedInput: this.players.get(player.id)?.lastInputSequence || 0
        }));

        const projectiles = this.engine.projectiles.map((proj) => ({
            x: proj.x,
            y: proj.y,
            vx: proj.vx,
            vy: proj.vy,
            type: proj.type,
            ownerId: proj.ownerId,
            lifetime: proj.lifetime,
            clientProjectileId: proj.clientProjectileId || null
        }));

        const terrainMods = this.pendingTerrainBroadcasts.length
            ? this.pendingTerrainBroadcasts.splice(0, this.pendingTerrainBroadcasts.length)
            : [];

        const state = {
            type: 'state',
            tick: this.tick,
            seed: this.seed,
            players,
            projectiles,
            terrainMods
        };

        // Sand updates are now handled separately with throttling
        // to prevent memory leaks

        this.broadcast(state);

        if (this.terrainModifications.length > this.maxTerrainModHistory) {
            this.terrainModifications = this.terrainModifications.slice(-this.maxTerrainModHistory);
        }
    }
    
    broadcast(message, excludePlayerId = null) {
        const data = JSON.stringify(message);
        
        for (const [id, player] of this.players.entries()) {
            if (id === excludePlayerId) continue;
            if (player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(data);
            }
        }
    }

    broadcastPendingSandUpdate() {
        if (!this.engine) return;
        
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastSandUpdateTime;
        
        // Ensure minimum time between updates
        if (timeSinceLastUpdate < (1000 / this.sandUpdateRate)) {
            return;
        }
        
        // Broadcast sand chunks near players whenever sand exists
        if (this.engine.sandParticleCount > 0 && this.engine.players.size > 0) {
            // Get sand data only for chunks near players
            const sandUpdate = this.engine.serializeSandChunksNearPlayers(this.sandChunkRadius);
            if (sandUpdate && sandUpdate.chunks && sandUpdate.chunks.length > 0) {
                const message = {
                    type: 'sand_update',
                    chunkSize: sandUpdate.chunkSize,
                    chunks: sandUpdate.chunks,
                    full: false
                };
                this.broadcast(message);
                this.lastSandUpdateTime = now;
                this.hasPendingSandUpdate = false;
            }
        } else {
            // No sand to broadcast, clear flag
            this.hasPendingSandUpdate = false;
        }
    }
    
    broadcastSandUpdate(payload, forceFull = false) {
        if (!payload || !Array.isArray(payload.chunks) || payload.chunks.length === 0) return;
        const message = {
            type: 'sand_update',
            chunkSize: payload.chunkSize,
            chunks: payload.chunks,
            full: forceFull || !!payload.full
        };
        this.broadcast(message);
    }
    
    sendToPlayer(playerId, message) {
        const player = this.players.get(playerId);
        if (player && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
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
    
    logStats() {
        const uptime = ((Date.now() - this.startTime) / 1000).toFixed(0);
        const messagesPerSecond = (this.totalMessages / uptime).toFixed(2);
        
        console.log('═══════════════════════════════════════');
        console.log(`📊 Server Statistics`);
        console.log(`   Uptime: ${uptime}s`);
        console.log(`   Players: ${this.players.size}`);
        console.log(`   Tick: ${this.tick}`);
        console.log(`   Messages/sec: ${messagesPerSecond}`);
        console.log(`   Total messages: ${this.totalMessages}`);
        console.log('═══════════════════════════════════════');
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
        process.exit(0);
    });
});
