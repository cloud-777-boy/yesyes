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
const { wrapHorizontal } = require('./terrain.js');
require('./physics.js');
require('./player.js');
require('./projectile.js');
const GameEngine = require('./engine.js');

const WORLD_WIDTH = 11200;
const WORLD_HEIGHT = 900;

class GameServer {
    constructor(port = 5000) {
        this.port = port;
        this.wss = new WebSocket.Server({ port: this.port });

        // Game state
        this.players = new Map();
        this.tick = 0;
        this.terrainModifications = [];
        this.maxTerrainModHistory = 1024;
        this.maxTerrainModBroadcast = 64;
        this.terrainSnapshot = null;
        this.playerCounter = 0;
        this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
        this.random = DeterministicRandom ? new DeterministicRandom(this.seed) : null;
        this.engine = this.createAuthoritativeEngine();
        this.terrainSnapshot = this.engine ? this.engine.getTerrainSnapshot() : null;
        this.tick = this.engine ? this.engine.tick : 0;
        this.currentSimulationTick = this.tick;
        
        // Network settings
        this.tickRate = 60; // Server updates per second
        this.stateUpdateRate = 20; // State broadcasts per second
        
        // Sand update throttling to prevent memory leak
        this.sandUpdateRate = 10; // Sand updates per second (reduced from state update rate)
        this.lastSandUpdateTime = 0;
        this.pendingSandUpdate = null;
        
        // Performance tracking
        this.startTime = Date.now();
        this.totalMessages = 0;
        
        this.setupServer();
        this.startGameLoop();
    }

    createAuthoritativeEngine() {
        const engine = new GameEngine(null, true, { seed: this.seed });
        engine.init();
        engine.onProjectileSpawn = (projectile) => this.handleServerProjectileSpawn(projectile);
        engine.onTerrainDestruction = ({ x, y, radius, explosive, broadcast }) => {
            if (broadcast === false) return;
            this.recordAndBroadcastTerrainModification(x, y, radius, explosive);
        };
        // Throttle sand updates to prevent memory leak
        engine.onSandUpdate = (payload) => {
            // Store the latest sand update instead of broadcasting immediately
            this.pendingSandUpdate = payload;
        };
        return engine;
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
                selectedSpell: this.getRandomSpellIndex(playerId),
                lastInputSequence: 0,
                joinTime: Date.now()
            };

            this.players.set(playerId, player);

            if (this.engine && typeof this.engine.addPlayer === 'function') {
                const enginePlayer = this.engine.addPlayer(playerId, spawnX, spawnY, player.selectedSpell);
                if (enginePlayer) {
                    enginePlayer.alive = true;
                }
            }

            // Send welcome message
            const welcomePayload = {
                type: 'welcome',
                playerId: playerId,
                tick: this.tick,
                spawnX: spawnX,
                spawnY: spawnY,
                selectedSpell: player.selectedSpell,
                seed: this.seed,
                needsTerrainSnapshot: false,
                terrainMods: this.terrainModifications.slice(-this.maxTerrainModBroadcast)
            };
            if (this.terrainSnapshot) {
                welcomePayload.terrainSnapshot = this.terrainSnapshot;
            }
            if (this.engine) {
                const initialSand = this.engine.serializeSandChunks(false);
                if (initialSand) {
                    welcomePayload.sandChunks = initialSand;
                }
                if (typeof this.engine.chunkSize === 'number') {
                    welcomePayload.chunkSize = this.engine.chunkSize;
                }
            }
            this.sendToPlayer(playerId, welcomePayload);
            
            // Notify other players
            this.broadcast({
                type: 'player_joined',
                playerId: playerId,
                x: spawnX,
                y: spawnY,
                selectedSpell: player.selectedSpell
            }, playerId);
            
            // Send existing players to new player
            for (const [id, p] of this.players.entries()) {
                if (id !== playerId) {
                    const existingPlayer = this.engine ? this.engine.players.get(id) : null;
                    this.sendToPlayer(playerId, {
                        type: 'player_joined',
                        playerId: id,
                        x: existingPlayer ? existingPlayer.x : 0,
                        y: existingPlayer ? existingPlayer.y : 0,
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

                if (this.engine && typeof this.engine.removePlayer === 'function') {
                    this.engine.removePlayer(playerId);
                }

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

            case 'terrain_snapshot':
                this.handleTerrainSnapshot(playerId, msg.snapshot);
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
        const enginePlayer = this.engine ? this.engine.players.get(playerId) : null;
        if (!player || !enginePlayer || !enginePlayer.alive) return;

        enginePlayer.input.left = !!input.left;
        enginePlayer.input.right = !!input.right;
        enginePlayer.input.jump = !!input.jump;
        enginePlayer.input.shoot = !!input.shoot;

        if (typeof input.mouseX === 'number') {
            enginePlayer.input.mouseX = wrapHorizontal(input.mouseX, this.engine.width);
        }
        if (typeof input.mouseY === 'number') {
            enginePlayer.input.mouseY = Math.max(0, Math.min(input.mouseY, this.engine.height));
        }

        if (typeof input.sequence === 'number') {
            player.lastInputSequence = input.sequence;
        }

        this.sendToPlayer(playerId, {
            type: 'input_ack',
            sequence: input.sequence
        });
    }

    handleProjectile(playerId, msg) {
        console.warn(`[${new Date().toISOString()}] Ignoring client projectile message from ${playerId}; server simulates projectiles.`);
    }

    handleTerrainDestruction(playerId, msg) {
        console.warn(`[${new Date().toISOString()}] Ignoring client terrain destruction from ${playerId}; server terrain is authoritative.`);
    }

    handleTerrainSnapshot(playerId, snapshot) {
        console.warn(`[${new Date().toISOString()}] Ignoring terrain snapshot from ${playerId}; server terrain is authoritative.`);
    }
    
    startGameLoop() {
        const tickInterval = 1000 / this.tickRate;
        const stateInterval = 1000 / this.stateUpdateRate;
        const sandInterval = 1000 / this.sandUpdateRate;
        
        // Physics tick
        setInterval(() => {
            this.updatePhysics();
        }, tickInterval);
        
        // State broadcast
        setInterval(() => {
            this.broadcastState();
        }, stateInterval);
        
        // Throttled sand updates to prevent memory leak
        setInterval(() => {
            this.broadcastPendingSandUpdate();
        }, sandInterval);
        
        // Stats logging
        setInterval(() => {
            this.logStats();
        }, 10000); // Every 10 seconds
    }
    
    updatePhysics() {
        if (!this.engine) return;
        const dt = this.engine.fixedTimeStep || (1000 / this.tickRate);
        const nextTick = this.engine.tick + 1;
        this.currentSimulationTick = nextTick;
        this.engine.update(dt);
        this.engine.tick = nextTick;
        this.tick = nextTick;
    }

    broadcastState() {
        const state = {
            type: 'state',
            tick: this.tick,
            seed: this.seed,
            terrainMods: this.terrainModifications.slice(-this.maxTerrainModBroadcast)
        };

        if (this.engine) {
            const engineState = this.engine.getState();
            if (engineState) {
                if (typeof engineState.chunkSize === 'number') {
                    state.chunkSize = engineState.chunkSize;
                }
                const players = Array.isArray(engineState.players) ? engineState.players : [];
                state.players = players.map((p) => ({
                    ...p,
                    lastProcessedInput: this.players.get(p.id)?.lastInputSequence || 0
                }));
                state.projectiles = Array.isArray(engineState.projectiles) ? engineState.projectiles : [];
                if (engineState.sandChunks) {
                    state.sandChunks = engineState.sandChunks;
                }
                if (engineState.terrain) {
                    state.terrain = engineState.terrain;
                }
                if (typeof engineState.sand === 'number') {
                    state.sand = engineState.sand;
                }
            }
        }

        if (!Array.isArray(state.players)) {
            state.players = [];
        }
        if (!Array.isArray(state.projectiles)) {
            state.projectiles = [];
        }

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

    recordAndBroadcastTerrainModification(x, y, radius, explosive) {
        const mod = {
            tick: this.currentSimulationTick ?? this.tick,
            x,
            y,
            radius,
            explosive
        };
        this.terrainModifications.push(mod);
        if (this.terrainModifications.length > this.maxTerrainModHistory) {
            this.terrainModifications.splice(0, this.terrainModifications.length - this.maxTerrainModHistory);
        }
        this.broadcast({
            type: 'terrain_update',
            x: mod.x,
            y: mod.y,
            radius: mod.radius,
            explosive: mod.explosive,
            tick: mod.tick
        });
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
            ownerId: projectile.ownerId
        };
        this.broadcast(payload);
    }

    broadcastPendingSandUpdate() {
        // Only broadcast if we have pending sand updates and enough time has passed
        if (!this.pendingSandUpdate || !this.engine) return;
        
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastSandUpdateTime;
        
        // Ensure minimum time between updates
        if (timeSinceLastUpdate < (1000 / this.sandUpdateRate)) {
            return;
        }
        
        // Get fresh sand data but only for active chunks
        const sandUpdate = this.engine.serializeSandChunks(true);
        if (sandUpdate && sandUpdate.chunks && sandUpdate.chunks.length > 0) {
            const message = {
                type: 'sand_update',
                chunkSize: sandUpdate.chunkSize,
                chunks: sandUpdate.chunks,
                full: false
            };
            this.broadcast(message);
            this.lastSandUpdateTime = now;
        }
        
        // Clear pending update
        this.pendingSandUpdate = null;
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
