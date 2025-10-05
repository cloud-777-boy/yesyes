const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const DeterministicRandom = require('./deterministic.js');
const { Terrain } = require('./terrain.js');

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
        this.playerCounter = 0;
        this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
        this.random = DeterministicRandom ? new DeterministicRandom(this.seed) : null;

        this.tickRate = 60;
        this.stateUpdateRate = 20;
        
        this.startTime = Date.now();
        this.totalMessages = 0;
        
        this.generateServerTerrain();
        this.setupServer();
        this.startGameLoop();
    }
    
    generateServerTerrain() {
        console.log(`[${new Date().toISOString()}] Generating server terrain with seed: ${this.seed}`);
        const terrain = new Terrain(1600, 900, this.random);
        terrain.generate();
        this.terrainSnapshot = {
            width: terrain.width,
            height: terrain.height,
            pixels: terrain.serializeSnapshot().pixels,
            seed: this.seed
        };
        const pixelLength = this.terrainSnapshot.pixels ? this.terrainSnapshot.pixels.length : 0;
        console.log(`[${new Date().toISOString()}] Server terrain generated successfully (${pixelLength} chars base64)`);
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
                ws: ws,
                x: spawnX,
                y: spawnY,
                vx: 0,
                vy: 0,
                health: 100,
                maxHealth: 100,
                alive: true,
                aimAngle: 0,
                selectedSpell: this.getRandomSpellIndex(playerId),
                lastInputSequence: 0,
                joinTime: Date.now()
            };
            
            this.players.set(playerId, player);
            
            const welcomePayload = {
                type: 'welcome',
                playerId: playerId,
                tick: this.tick,
                spawnX: player.x,
                spawnY: player.y,
                selectedSpell: player.selectedSpell,
                seed: this.seed,
                terrainSnapshot: this.terrainSnapshot,
                terrainMods: this.terrainModifications.slice(-this.maxTerrainModBroadcast)
            };
            console.log(`[${new Date().toISOString()}] Sending welcome to ${playerId} with terrain: ${this.terrainSnapshot ? 'YES' : 'NO'}`);
            this.sendToPlayer(playerId, welcomePayload);
            
            this.broadcast({
                type: 'player_joined',
                playerId: playerId,
                x: player.x,
                y: player.y,
                selectedSpell: player.selectedSpell
            }, playerId);
            
            for (const [id, p] of this.players.entries()) {
                if (id !== playerId) {
                    this.sendToPlayer(playerId, {
                        type: 'player_joined',
                        playerId: id,
                        x: p.x,
                        y: p.y,
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
                
                this.broadcast({
                    type: 'player_left',
                    playerId: playerId
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
        const player = this.players.get(playerId);
        if (!player || !player.alive) return;
        
        // Update aim angle
        player.aimAngle = Math.atan2(
            input.mouseY - (player.y + 6),
            input.mouseX - (player.x + 3)
        );
        
        // Accept client position with basic bounds validation
        // Client handles terrain collision locally
        if (input.x !== undefined && input.y !== undefined) {
            player.x = Math.max(0, Math.min(input.x, 1600));
            player.y = Math.max(0, Math.min(input.y, 900));
            
            if (input.vx !== undefined) player.vx = input.vx;
            if (input.vy !== undefined) player.vy = input.vy;
        }
        
        if (input.sequence) {
            player.lastInputSequence = input.sequence;
        }
        
        this.sendToPlayer(playerId, {
            type: 'input_ack',
            sequence: input.sequence
        });
    }
    
    handleProjectile(playerId, msg) {
        const player = this.players.get(playerId);
        if (!player || !player.alive) return;
        
        this.broadcast({
            type: 'projectile',
            x: msg.x,
            y: msg.y,
            vx: msg.vx,
            vy: msg.vy,
            type: msg.type,
            ownerId: playerId
        }, playerId);
    }
    
    handleTerrainDestruction(playerId, msg) {
        const mod = {
            tick: this.tick,
            x: msg.x,
            y: msg.y,
            radius: msg.radius,
            explosive: msg.explosive
        };
        this.terrainModifications.push(mod);
        if (this.terrainModifications.length > this.maxTerrainModHistory) {
            this.terrainModifications.splice(0, this.terrainModifications.length - this.maxTerrainModHistory);
        }

        this.broadcast({
            type: 'terrain_update',
            x: msg.x,
            y: msg.y,
            radius: msg.radius,
            explosive: msg.explosive,
            tick: this.tick
        });
    }

    
    startGameLoop() {
        const tickInterval = 1000 / this.tickRate;
        const stateInterval = 1000 / this.stateUpdateRate;
        
        setInterval(() => {
            this.tick++;
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
        for (const [id, player] of this.players.entries()) {
            if (!player.alive) continue;
            
            // Basic bounds checking only - client handles terrain collision
            player.x = Math.max(0, Math.min(player.x, 1600));
            player.y = Math.max(0, Math.min(player.y, 900));
        }
    }
    
    broadcastState() {
        const state = {
            type: 'state',
            tick: this.tick,
            seed: this.seed,
            players: Array.from(this.players.values()).map(p => ({
                id: p.id,
                x: p.x,
                y: p.y,
                vx: p.vx,
                vy: p.vy,
                health: p.health,
                alive: p.alive,
                aimAngle: p.aimAngle,
                selectedSpell: p.selectedSpell,
                lastProcessedInput: p.lastInputSequence
            })),
            terrainMods: this.terrainModifications.slice(-this.maxTerrainModBroadcast)
        };
        
        this.broadcast(state);
        
        if (this.terrainModifications.length > 100) {
            this.terrainModifications = this.terrainModifications.slice(-50);
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
