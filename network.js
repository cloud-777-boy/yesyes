/**
 * NetworkManager - Handles multiplayer synchronization
 * Uses deterministic lockstep for physics sync
 */

class NetworkManager {
    constructor(engine) {
        this.engine = engine;
        this.socket = null;
        this.connected = false;
        this.playerId = null;
        
        // Lockstep networking
        this.inputBuffer = new Map(); // tick -> inputs
        this.currentTick = 0;
        this.confirmedTick = 0;
        
        // Input prediction
        this.pendingInputs = [];
        this.inputSequence = 0;
        
        // Server reconciliation
        this.stateHistory = [];
        this.maxHistorySize = 60; // 1 second at 60fps
        
        // Connection
        this.latency = 0;
        this.serverUrl = null;
    }
    
    connect(url) {
        this.serverUrl = url;
        this.socket = new WebSocket(url);
        
        this.socket.onopen = () => {
            console.log('Connected to server');
            this.connected = true;
            this.send({ type: 'join' });
        };
        
        this.socket.onclose = () => {
            console.log('Disconnected from server');
            this.connected = false;
        };
        
        this.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
        
        this.socket.onmessage = (event) => {
            this.handleMessage(JSON.parse(event.data));
        };
    }
    
    disconnect() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.connected = false;
    }
    
    send(data) {
        if (this.connected && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(data));
        }
    }
    
    handleMessage(msg) {
        switch (msg.type) {
            case 'welcome':
                this.playerId = msg.playerId;
                this.engine.playerId = msg.playerId;
                this.currentTick = msg.tick;
                this.confirmedTick = msg.tick;
                
                // Add local player
                this.engine.addPlayer(this.playerId, msg.spawnX, msg.spawnY);
                break;
                
            case 'state':
                this.handleStateUpdate(msg);
                break;
                
            case 'player_joined':
                if (msg.playerId !== this.playerId) {
                    this.engine.addPlayer(msg.playerId, msg.x, msg.y);
                }
                break;
                
            case 'player_left':
                this.engine.removePlayer(msg.playerId);
                break;
                
            case 'input_ack':
                this.handleInputAck(msg);
                break;
                
            case 'terrain_update':
                this.handleTerrainUpdate(msg);
                break;
                
            case 'projectile':
                // Spawn projectile from another player
                if (msg.ownerId !== this.playerId) {
                    this.engine.spawnProjectile(
                        msg.x, msg.y, msg.vx, msg.vy, msg.type, msg.ownerId
                    );
                }
                break;
        }
    }
    
    handleStateUpdate(msg) {
        // Server authoritative state
        this.confirmedTick = msg.tick;
        
        // Update all players except local (we use prediction for local)
        for (const pData of msg.players) {
            if (pData.id === this.playerId) continue;
            
            const player = this.engine.players.get(pData.id);
            if (player) {
                player.deserialize(pData);
            }
        }
        
        // For local player, reconcile with server state
        if (this.playerId) {
            const serverPlayer = msg.players.find(p => p.id === this.playerId);
            if (serverPlayer) {
                this.reconcileState(serverPlayer);
            }
        }
        
        // Update terrain modifications
        if (msg.terrainMods) {
            for (const mod of msg.terrainMods) {
                this.engine.destroyTerrain(mod.x, mod.y, mod.radius, mod.explosive);
            }
        }
    }
    
    reconcileState(serverState) {
        const localPlayer = this.engine.players.get(this.playerId);
        if (!localPlayer) return;
        
        // Check if local prediction diverged from server
        const dx = Math.abs(localPlayer.x - serverState.x);
        const dy = Math.abs(localPlayer.y - serverState.y);
        
        if (dx > 5 || dy > 5) {
            // Significant divergence, snap to server state
            localPlayer.deserialize(serverState);
            
            // Re-apply pending inputs
            for (const input of this.pendingInputs) {
                if (input.sequence > serverState.lastProcessedInput) {
                    this.applyInput(localPlayer, input);
                }
            }
        }
        
        // Remove acknowledged inputs
        this.pendingInputs = this.pendingInputs.filter(
            i => i.sequence > serverState.lastProcessedInput
        );
    }
    
    handleInputAck(msg) {
        // Server confirmed processing this input
        this.pendingInputs = this.pendingInputs.filter(
            i => i.sequence > msg.sequence
        );
    }
    
    handleTerrainUpdate(msg) {
        // Apply terrain modification
        this.engine.destroyTerrain(msg.x, msg.y, msg.radius, msg.explosive);
    }
    
    sendInput(input) {
        if (!this.connected || !this.playerId) return;
        
        const localPlayer = this.engine.players.get(this.playerId);
        
        // Add sequence number and position data
        input.sequence = this.inputSequence++;
        input.tick = this.currentTick;
        
        // Include current position for server reconciliation
        if (localPlayer) {
            input.x = localPlayer.x;
            input.y = localPlayer.y;
            input.vx = localPlayer.vx;
            input.vy = localPlayer.vy;
        }
        
        // Store for reconciliation
        this.pendingInputs.push({...input});
        
        // Send to server
        this.send({
            type: 'input',
            input: input
        });
        
        // Apply locally (client-side prediction)
        if (localPlayer) {
            this.applyInput(localPlayer, input);
        }
    }
    
    applyInput(player, input) {
        // Apply input to player
        player.input = {
            left: input.left || false,
            right: input.right || false,
            jump: input.jump || false,
            shoot: input.shoot || false,
            mouseX: input.mouseX || 0,
            mouseY: input.mouseY || 0
        };
    }
    
    sendProjectile(proj) {
        if (!this.connected) return;
        
        this.send({
            type: 'projectile',
            x: proj.x,
            y: proj.y,
            vx: proj.vx,
            vy: proj.vy,
            type: proj.type,
            ownerId: proj.ownerId
        });
    }
    
    sendTerrainDestruction(x, y, radius, explosive) {
        if (!this.connected) return;
        
        this.send({
            type: 'terrain_destroy',
            x: x,
            y: y,
            radius: radius,
            explosive: explosive
        });
    }
    
    update() {
        this.currentTick++;
        
        // Measure latency periodically
        if (this.currentTick % 60 === 0) {
            this.measureLatency();
        }
    }
    
    measureLatency() {
        if (!this.connected) return;
        
        const startTime = Date.now();
        this.send({
            type: 'ping',
            timestamp: startTime
        });
    }
    
    getLatency() {
        return this.latency;
    }
}

/**
 * Mock Server (for development/testing)
 * In production, use a proper Node.js WebSocket server
 */
class MockServer {
    constructor() {
        this.players = new Map();
        this.tick = 0;
        this.terrain = null;
    }
    
    start() {
        console.log('Mock server started (replace with real server for production)');
        
        setInterval(() => {
            this.tick++;
            this.broadcast({
                type: 'state',
                tick: this.tick,
                players: Array.from(this.players.values()),
                terrainMods: []
            });
        }, 1000 / 20); // 20 tick/s server update rate
    }
    
    handlePlayerJoin(playerId) {
        this.players.set(playerId, {
            id: playerId,
            x: Math.random() * 800 + 100,
            y: 100,
            vx: 0,
            vy: 0,
            health: 100,
            alive: true
        });
    }
    
    broadcast(msg) {
        // In real server, send to all connected clients
        console.log('Server broadcast:', msg.type);
    }
}
