const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 5000;
const WS_PORT = 8080;

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
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    let filePath = '.' + req.url;
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
    constructor(port = WS_PORT) {
        this.port = port;
        this.wss = new WebSocket.Server({ port: this.port });
        
        this.players = new Map();
        this.tick = 0;
        this.terrainModifications = [];
        
        this.tickRate = 60;
        this.stateUpdateRate = 20;
        
        this.startTime = Date.now();
        this.totalMessages = 0;
        
        this.setupServer();
        this.startGameLoop();
    }
    
    setupServer() {
        this.wss.on('connection', (ws, req) => {
            const playerId = this.generatePlayerId();
            const clientIP = req.socket.remoteAddress;
            
            console.log(`[${new Date().toISOString()}] Player ${playerId} connected from ${clientIP}`);
            
            const player = {
                id: playerId,
                ws: ws,
                x: Math.random() * 1200 + 200,
                y: 100,
                vx: 0,
                vy: 0,
                health: 100,
                maxHealth: 100,
                alive: true,
                aimAngle: 0,
                selectedSpell: 0,
                lastInputSequence: 0,
                joinTime: Date.now()
            };
            
            this.players.set(playerId, player);
            
            this.sendToPlayer(playerId, {
                type: 'welcome',
                playerId: playerId,
                tick: this.tick,
                spawnX: player.x,
                spawnY: player.y
            });
            
            this.broadcast({
                type: 'player_joined',
                playerId: playerId,
                x: player.x,
                y: player.y
            }, playerId);
            
            for (const [id, p] of this.players.entries()) {
                if (id !== playerId) {
                    this.sendToPlayer(playerId, {
                        type: 'player_joined',
                        playerId: id,
                        x: p.x,
                        y: p.y
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
        
        console.log(`🎮 WebSocket server listening on port ${this.port}`);
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
        
        // Update from client input with basic validation
        // Note: Client-authoritative for physics since server lacks terrain data
        // This fixes the hovering bug caused by hardcoded ground collision
        if (input.x !== undefined && input.y !== undefined) {
            // Basic bounds checking only
            player.x = Math.max(0, Math.min(input.x, 1600));
            player.y = Math.max(0, Math.min(input.y, 900));
            
            // Update velocities
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
        this.terrainModifications.push({
            tick: this.tick,
            x: msg.x,
            y: msg.y,
            radius: msg.radius,
            explosive: msg.explosive
        });
        
        this.broadcast({
            type: 'terrain_update',
            x: msg.x,
            y: msg.y,
            radius: msg.radius,
            explosive: msg.explosive
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
            terrainMods: this.terrainModifications.slice(-10)
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
        return 'player-' + Math.random().toString(36).substr(2, 9);
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
    console.log(`🌐 HTTP server running on http://0.0.0.0:${PORT}`);
});

const gameServer = new GameServer(WS_PORT);

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
