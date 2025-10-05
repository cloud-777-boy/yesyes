/**
 * Example WebSocket Server for Pixel Mage Arena
 * 
 * This is a basic multiplayer server implementation.
 * For production use, add:
 * - Player authentication
 * - Server-side physics validation
 * - Anti-cheat measures
 * - Database for persistence
 * - Load balancing for multiple servers
 */

const WebSocket = require('ws');
require('./deterministic.js');
const DeterministicRandom = globalThis.DeterministicRandom;

class GameServer {
    constructor(port = 8080) {
        this.port = port;
        this.wss = new WebSocket.Server({ port: this.port });
        
        // Game state
        this.players = new Map();
        this.tick = 0;
        this.terrainModifications = [];
        this.playerCounter = 0;
        this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
        this.random = DeterministicRandom ? new DeterministicRandom(this.seed) : null;
        
        // Network settings
        this.tickRate = 60; // Server updates per second
        this.stateUpdateRate = 20; // State broadcasts per second
        
        // Performance tracking
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
            
            // Initialize player
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
            
            // Send welcome message
            this.sendToPlayer(playerId, {
                type: 'welcome',
                playerId: playerId,
                tick: this.tick,
                spawnX: player.x,
                spawnY: player.y,
                selectedSpell: player.selectedSpell,
                seed: this.seed
            });
            
            // Notify other players
            this.broadcast({
                type: 'player_joined',
                playerId: playerId,
                x: player.x,
                y: player.y,
                selectedSpell: player.selectedSpell
            }, playerId);
            
            // Send existing players to new player
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
            
            // Handle messages
            ws.on('message', (data) => {
                this.totalMessages++;
                try {
                    const msg = JSON.parse(data);
                    this.handleMessage(playerId, msg);
                } catch (error) {
                    console.error(`Error parsing message from ${playerId}:`, error);
                }
            });
            
            // Handle disconnect
            ws.on('close', () => {
                console.log(`[${new Date().toISOString()}] Player ${playerId} disconnected`);
                this.players.delete(playerId);
                
                this.broadcast({
                    type: 'player_left',
                    playerId: playerId
                });
            });
            
            // Handle errors
            ws.on('error', (error) => {
                console.error(`WebSocket error for ${playerId}:`, error);
            });
        });
        
        console.log(`🎮 Game server listening on port ${this.port}`);
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
        
        // Basic server-side physics (simplified)
        // In production, validate all movements
        
        if (input.left) player.x -= 2;
        if (input.right) player.x += 2;
        if (input.jump && player.grounded) player.vy = -6;
        
        // Bounds check
        player.x = Math.max(0, Math.min(player.x, 1600));
        
        // Update aim
        player.aimAngle = Math.atan2(
            input.mouseY - (player.y + 6),
            input.mouseX - (player.x + 3)
        );
        
        // Track input sequence for reconciliation
        if (input.sequence) {
            player.lastInputSequence = input.sequence;
        }
        
        // Acknowledge input
        this.sendToPlayer(playerId, {
            type: 'input_ack',
            sequence: input.sequence
        });
    }
    
    handleProjectile(playerId, msg) {
        // Validate projectile (basic anti-cheat)
        const player = this.players.get(playerId);
        if (!player || !player.alive) return;
        
        // Broadcast to all other players
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
        // Record terrain modification
        this.terrainModifications.push({
            tick: this.tick,
            x: msg.x,
            y: msg.y,
            radius: msg.radius,
            explosive: msg.explosive
        });
        
        // Broadcast to all clients
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
        
        // Physics tick
        setInterval(() => {
            this.tick++;
            this.updatePhysics();
        }, tickInterval);
        
        // State broadcast
        setInterval(() => {
            this.broadcastState();
        }, stateInterval);
        
        // Stats logging
        setInterval(() => {
            this.logStats();
        }, 10000); // Every 10 seconds
    }
    
    updatePhysics() {
        // Server-side physics simulation
        for (const [id, player] of this.players.entries()) {
            if (!player.alive) continue;
            
            // Apply gravity
            player.vy += 0.3;
            
            // Apply velocity
            player.y += player.vy;
            
            // Simple ground collision
            if (player.y > 300) {
                player.y = 300;
                player.vy = 0;
                player.grounded = true;
            } else {
                player.grounded = false;
            }
            
            // Friction
            player.vx *= 0.8;
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
            terrainMods: this.terrainModifications.slice(-10) // Last 10 modifications
        };
        
        this.broadcast(state);
        
        // Clear old terrain modifications
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

// Start server
const PORT = process.env.PORT || 8080;
const server = new GameServer(PORT);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    server.wss.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});
