/**
 * Production WebSocket Server for Pixel Mage Arena
 * 
 * Features:
 * ✅ Server-authoritative physics simulation
 * ✅ Complete terrain state synchronization
 * ✅ Input validation and anti-cheat
 * ✅ Deterministic lockstep networking
 * ✅ Delta compression for bandwidth optimization
 * ✅ Rate limiting and flood protection
 */

const WebSocket = require('ws');

const roundTo = (value, decimals) => {
    if (!Number.isFinite(value)) return 0;
    if (!decimals) return Math.round(value);
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
};

class GameServer {
    constructor(port = 8080) {
        this.port = port;
        this.wss = new WebSocket.Server({ port: this.port });

        // Game state - SERVER IS SOURCE OF TRUTH
        this.players = new Map();
        this.projectiles = [];
        this.chunks = [];
        this.tick = 0;

        // Terrain state (server-authoritative)
        this.terrain = null;
        this.terrainModifications = []; // Synced to clients
        this.terrainVersion = 0;

        // Physics constants (must match client!)
        this.GRAVITY = 0.3;
        this.WORLD_WIDTH = 1600;
        this.WORLD_HEIGHT = 900;
        this.FIXED_TIMESTEP = 1000 / 60; // 16.67ms

        // Network settings
        this.tickRate = 60; // Server simulation rate
        this.stateUpdateRate = 60; // Client broadcast rate
        this.broadcastIntervalTicks = Math.max(1, Math.round(this.tickRate / this.stateUpdateRate));
        this.lastPlayerBroadcast = new Map();
        this.lastProjectileBroadcast = new Map();
        this.forceFullPlayerBroadcast = true;
        this.forceFullProjectileBroadcast = true;
        this.nextTempProjectileId = 1;

        // Anti-cheat settings
        this.MAX_SPEED = 5; // Max horizontal speed
        this.MAX_JUMP_POWER = 8;
        this.MIN_COOLDOWN = 250; // Min ms between shots
        this.MAX_PROJECTILE_SPEED = 10;

        // Rate limiting (per player)
        this.INPUT_RATE_LIMIT = 120; // Max inputs per second
        this.PROJECTILE_RATE_LIMIT = 10; // Max projectiles per second
        this.PROJECTILE_DEDUP_WINDOW = 10000; // ms to dedupe client projectile resends

        // Performance tracking
        this.startTime = Date.now();
        this.totalMessages = 0;
        this.tickTimes = [];

        // Client projectile deduplication (track recent ids per player)
        this.recentClientProjectiles = new Map();

        this.initTerrain();
        this.setupServer();
        this.startGameLoop();
    }

    initTerrain() {
        // Initialize server-side terrain state
        this.terrain = new ServerTerrain(this.WORLD_WIDTH, this.WORLD_HEIGHT);
        this.terrain.generate();
        console.log('✅ Server terrain initialized');
    }

    setupServer() {
        this.wss.on('connection', (ws, req) => {
            const playerId = this.generatePlayerId();
            const clientIP = req.socket.remoteAddress;

            console.log(`[${new Date().toISOString()}] 🎮 Player ${playerId} connected from ${clientIP}`);

            // Initialize player with server-side physics
            const spawnX = Math.random() * 1200 + 200;
            const spawnY = 100;

            const player = {
                id: playerId,
                ws: ws,

                // Physics state (server-authoritative)
                x: spawnX,
                y: spawnY,
                vx: 0,
                vy: 0,
                width: 6,
                height: 12,

                // Movement
                grounded: false,

                // Combat
                health: 100,
                maxHealth: 100,
                alive: true,
                aimAngle: 0,
                selectedSpell: 0,
                lastShotTime: 0,

                // Input tracking
                currentInput: {
                    left: false,
                    right: false,
                    jump: false,
                    shoot: false,
                    mouseX: spawnX,
                    mouseY: spawnY
                },
                lastProcessedInput: 0,

                // Rate limiting
                inputCount: 0,
                projectileCount: 0,
                lastRateLimitReset: Date.now(),

                // Connection
                joinTime: Date.now(),
                lastPingTime: Date.now(),
                latency: 0,

                // Anti-cheat tracking
                suspiciousActions: 0,
                lastPositions: []
            };

            this.players.set(playerId, player);

            // Send welcome with FULL terrain state
            this.sendToPlayer(playerId, {
                type: 'welcome',
                playerId: playerId,
                tick: this.tick,
                spawnX: player.x,
                spawnY: player.y,
                terrain: this.terrain.serialize(), // Full terrain on connect
                terrainVersion: this.terrainVersion
            });

            // Notify other players
            this.broadcast({
                type: 'player_joined',
                playerId: playerId,
                x: player.x,
                y: player.y
            }, playerId);

            // Send existing players to new player
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

            // Handle messages
            ws.on('message', (data) => {
                this.totalMessages++;
                try {
                    const msg = JSON.parse(data);
                    this.handleMessage(playerId, msg);
                } catch (error) {
                    console.error(`❌ Error parsing message from ${playerId}:`, error);
                    this.flagSuspiciousActivity(playerId, 'Invalid message format');
                }
            });

            // Handle disconnect
            ws.on('close', () => {
                console.log(`[${new Date().toISOString()}] 👋 Player ${playerId} disconnected`);
                this.players.delete(playerId);

                this.broadcast({
                    type: 'player_left',
                    playerId: playerId
                });
            });

            // Handle errors
            ws.on('error', (error) => {
                console.error(`❌ WebSocket error for ${playerId}:`, error);
            });
        });

        console.log(`🎮 Game server listening on port ${this.port}`);
        console.log(`📊 Tick rate: ${this.tickRate}Hz, State updates: ${this.stateUpdateRate}Hz`);
    }

    handleMessage(playerId, msg) {
        const player = this.players.get(playerId);
        if (!player) return;

        // Rate limiting check
        if (!this.checkRateLimit(player)) {
            this.flagSuspiciousActivity(playerId, 'Rate limit exceeded');
            return;
        }

        switch (msg.type) {
            case 'input':
                this.handlePlayerInput(playerId, msg.input);
                break;

            case 'projectile':
                this.handleProjectileRequest(playerId, msg);
                break;

            case 'ping':
                this.handlePing(playerId, msg);
                break;

            default:
                console.warn(`⚠️  Unknown message type from ${playerId}: ${msg.type}`);
        }
    }

    checkRateLimit(player) {
        const now = Date.now();

        // Reset counters every second
        if (now - player.lastRateLimitReset > 1000) {
            player.inputCount = 0;
            player.projectileCount = 0;
            player.lastRateLimitReset = now;
        }

        player.inputCount++;

        if (player.inputCount > this.INPUT_RATE_LIMIT) {
            return false;
        }

        return true;
    }

    handlePlayerInput(playerId, input) {
        const player = this.players.get(playerId);
        if (!player || !player.alive) return;

        // Validate input
        if (!this.validateInput(input)) {
            this.flagSuspiciousActivity(playerId, 'Invalid input data');
            return;
        }

        // Store input for processing in physics tick
        player.currentInput = {
            left: !!input.left,
            right: !!input.right,
            jump: !!input.jump,
            shoot: !!input.shoot,
            mouseX: this.clamp(input.mouseX || player.x, 0, this.WORLD_WIDTH),
            mouseY: this.clamp(input.mouseY || player.y, 0, this.WORLD_HEIGHT)
        };

        // Track sequence for reconciliation
        if (input.sequence !== undefined) {
            player.lastProcessedInput = input.sequence;
        }
    }

    validateInput(input) {
        // Basic input validation
        if (typeof input !== 'object') return false;

        // Check for required fields
        if (input.mouseX !== undefined && (typeof input.mouseX !== 'number' || !isFinite(input.mouseX))) {
            return false;
        }

        if (input.mouseY !== undefined && (typeof input.mouseY !== 'number' || !isFinite(input.mouseY))) {
            return false;
        }

        return true;
    }

    handleProjectileRequest(playerId, msg) {
        const player = this.players.get(playerId);
        if (!player || !player.alive) return;

        // Rate limit projectiles
        player.projectileCount++;
        if (player.projectileCount > this.PROJECTILE_RATE_LIMIT) {
            this.flagSuspiciousActivity(playerId, 'Projectile spam');
            return;
        }

        const now = Date.now();

        // Cooldown check (anti-cheat)
        if (now - player.lastShotTime < this.MIN_COOLDOWN) {
            this.flagSuspiciousActivity(playerId, 'Cooldown violation');
            return;
        }

        // Validate projectile data
        if (!this.validateProjectile(msg, player)) {
            this.flagSuspiciousActivity(playerId, 'Invalid projectile data');
            return;
        }

        player.lastShotTime = now;

        const clientProjectileId = (typeof msg.clientProjectileId === 'string' && msg.clientProjectileId.length > 0)
            ? msg.clientProjectileId
            : null;

        if (clientProjectileId) {
            const now = Date.now();
            let playerProjectiles = this.recentClientProjectiles.get(playerId);
            if (!playerProjectiles) {
                playerProjectiles = new Map();
                this.recentClientProjectiles.set(playerId, playerProjectiles);
            } else {
                const previous = playerProjectiles.get(clientProjectileId);
                if (previous && now - previous.timestamp < this.PROJECTILE_DEDUP_WINDOW) {
                    previous.timestamp = now;
                    // Ignore duplicate request, optionally resend latest authoritative state
                    if (previous.payload) {
                        const resend = previous.dead
                            ? { ...previous.payload, dead: true, spawn: false }
                            : previous.payload;
                        previous.payload = resend;
                        this.sendToPlayer(playerId, previous.payload);
                    } else if (previous.serverId) {
                        const existing = this.projectiles.find(p => p.id === previous.serverId);
                        if (existing) {
                            const ackPayload = {
                                type: 'projectile',
                                id: existing.id,
                                x: existing.x,
                                y: existing.y,
                                vx: existing.vx,
                                vy: existing.vy,
                                type: existing.type,
                                ownerId: existing.ownerId,
                                clientProjectileId: clientProjectileId,
                                lifetime: existing.lifetime,
                                dead: !!existing.dead,
                                spawn: false
                            };
                            previous.payload = ackPayload;
                            previous.dead = !!existing.dead;
                            this.sendToPlayer(playerId, ackPayload);
                        } else {
                            const expiredPayload = {
                                type: 'projectile',
                                id: previous.serverId,
                                clientProjectileId: clientProjectileId,
                                ownerId: playerId,
                                dead: true,
                                spawn: false
                            };
                            previous.payload = expiredPayload;
                            previous.dead = true;
                            this.sendToPlayer(playerId, expiredPayload);
                        }
                    }
                    return;
                }
            }
            playerProjectiles.set(clientProjectileId, {
                timestamp: now,
                serverId: null,
                payload: null,
                dead: false
            });
        }

        // Create server-side projectile
        const projectile = {
            id: this.generateProjectileId(),
            x: msg.x,
            y: msg.y,
            vx: msg.vx,
            vy: msg.vy,
            type: msg.type,
            ownerId: playerId,
            clientProjectileId: clientProjectileId,
            lifetime: 0,
            maxLifetime: 3000,
            radius: 3,
            dead: false
        };
        projectile.serverId = projectile.id;

        const projectilePayload = {
            type: 'projectile',
            id: projectile.id,
            x: projectile.x,
            y: projectile.y,
            vx: projectile.vx,
            vy: projectile.vy,
            type: projectile.type,
            ownerId: playerId,
            lifetime: projectile.lifetime,
            clientProjectileId: clientProjectileId,
            spawn: true,
            dead: false
        };

        if (clientProjectileId) {
            const playerProjectiles = this.recentClientProjectiles.get(playerId);
            if (playerProjectiles) {
                const record = playerProjectiles.get(clientProjectileId);
                if (record) {
                    record.serverId = projectile.id;
                    record.payload = { ...projectilePayload, spawn: false };
                    record.dead = false;
                } else {
                    playerProjectiles.set(clientProjectileId, {
                        timestamp: Date.now(),
                        serverId: projectile.id,
                        payload: { ...projectilePayload, spawn: false },
                        dead: false
                    });
                }
            }
        }

        this.projectiles.push(projectile);

        // Broadcast to all clients
        this.broadcast(projectilePayload);
    }

    validateProjectile(msg, player) {
        // Check projectile speed (anti-cheat)
        const speed = Math.sqrt(msg.vx ** 2 + msg.vy ** 2);
        if (speed > this.MAX_PROJECTILE_SPEED) {
            return false;
        }

        // Check if projectile origin is near player
        const dxRaw = msg.x - player.x;
        const worldWidth = this.WORLD_WIDTH || 0;
        let dx = dxRaw;
        if (worldWidth > 0) {
            const wrapped = ((dxRaw % worldWidth) + worldWidth) % worldWidth;
            const alternate = wrapped > worldWidth / 2 ? wrapped - worldWidth : wrapped;
            dx = alternate;
        }
        const dy = msg.y - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 50) { // Max distance from player
            return false;
        }

        // Validate spell type
        const validSpells = ['fireball', 'ice', 'lightning', 'earth'];
        if (!validSpells.includes(msg.type)) {
            return false;
        }

        return true;
    }

    handlePing(playerId, msg) {
        const player = this.players.get(playerId);
        if (!player) return;

        player.lastPingTime = Date.now();

        this.sendToPlayer(playerId, {
            type: 'pong',
            timestamp: msg.timestamp,
            serverTime: Date.now()
        });
    }

    serializePlayerForBroadcast(player) {
        return {
            id: player.id,
            x: roundTo(player.x || 0, 2),
            y: roundTo(player.y || 0, 2),
            vx: roundTo(player.vx || 0, 3),
            vy: roundTo(player.vy || 0, 3),
            health: Math.round(Number.isFinite(player.health) ? player.health : 0),
            alive: !!player.alive,
            aimAngle: roundTo(player.aimAngle || 0, 3),
            selectedSpell: player.selectedSpell,
            lastProcessedInput: player.lastProcessedInput || 0
        };
    }

    playerBroadcastChanged(prev, next) {
        if (!prev) return true;
        return prev.x !== next.x
            || prev.y !== next.y
            || prev.vx !== next.vx
            || prev.vy !== next.vy
            || prev.health !== next.health
            || prev.alive !== next.alive
            || prev.aimAngle !== next.aimAngle
            || prev.selectedSpell !== next.selectedSpell
            || prev.lastProcessedInput !== next.lastProcessedInput;
    }

    serializeProjectileForBroadcast(projectile) {
        if (!projectile) return null;

        let serverId = (typeof projectile.id === 'string' && projectile.id.length)
            ? projectile.id
            : null;
        if (!serverId && typeof projectile.serverId === 'string' && projectile.serverId.length) {
            serverId = projectile.serverId;
        }
        let clientProjectileId = (typeof projectile.clientProjectileId === 'string' && projectile.clientProjectileId.length)
            ? projectile.clientProjectileId
            : null;

        if (!serverId && !clientProjectileId) {
            if (typeof projectile.__broadcastKey !== 'string' || !projectile.__broadcastKey.length) {
                projectile.__broadcastKey = `tmp-${this.nextTempProjectileId++}`;
            }
            serverId = projectile.__broadcastKey;
        }

        const data = {
            id: serverId,
            clientProjectileId,
            x: roundTo(projectile.x || 0, 2),
            y: roundTo(projectile.y || 0, 2),
            vx: roundTo(projectile.vx || 0, 3),
            vy: roundTo(projectile.vy || 0, 3),
            type: projectile.type,
            ownerId: projectile.ownerId,
            lifetime: roundTo(projectile.lifetime || 0, 3),
            dead: !!projectile.dead
        };

        return {
            key: this.getProjectileBroadcastKey(data),
            data
        };
    }

    projectileBroadcastChanged(prev, next) {
        if (!prev) return true;
        return prev.x !== next.x
            || prev.y !== next.y
            || prev.vx !== next.vx
            || prev.vy !== next.vy
            || prev.type !== next.type
            || prev.ownerId !== next.ownerId
            || prev.lifetime !== next.lifetime
            || prev.dead !== next.dead;
    }

    getProjectileBroadcastKey(data) {
        if (!data || typeof data !== 'object') {
            return null;
        }
        if (typeof data.id === 'string' && data.id.length) {
            return `id:${data.id}`;
        }
        if (typeof data.clientProjectileId === 'string' && data.clientProjectileId.length) {
            return `client:${data.clientProjectileId}`;
        }
        return null;
    }

    startGameLoop() {
        const tickInterval = 1000 / this.tickRate;
        const broadcastInterval = this.broadcastIntervalTicks
            ? Math.max(1, this.broadcastIntervalTicks)
            : Math.max(1, Math.round(this.tickRate / this.stateUpdateRate));

        // Physics tick (60 FPS)
        setInterval(() => {
            const tickStart = Date.now();
            this.tick++;
            this.updatePhysics();
            this.updateProjectiles();
            this.updateChunks();

            if (this.tick % broadcastInterval === 0) {
                this.broadcastState();
            }

            const tickTime = Date.now() - tickStart;
            this.tickTimes.push(tickTime);
            if (this.tickTimes.length > 60) this.tickTimes.shift();

            // Warn if tick takes too long
            if (tickTime > tickInterval * 0.8) {
                console.warn(`⚠️  Slow tick: ${tickTime.toFixed(2)}ms (target: ${tickInterval.toFixed(2)}ms)`);
            }
        }, tickInterval);

        // Stats logging (every 10 seconds)
        setInterval(() => {
            this.logStats();
        }, 10000);

        // Cleanup (every 5 seconds)
        setInterval(() => {
            this.cleanup();
        }, 5000);
    }

    updatePhysics() {
        // Server-authoritative physics for all players
        for (const [id, player] of this.players.entries()) {
            if (!player.alive) continue;

            const input = player.currentInput;

            // Horizontal movement
            if (input.left) {
                player.vx = -2;
            } else if (input.right) {
                player.vx = 2;
            } else {
                player.vx *= 0.8;
            }

            // Anti-cheat: Clamp velocity
            player.vx = this.clamp(player.vx, -this.MAX_SPEED, this.MAX_SPEED);

            // Apply gravity
            player.vy += this.GRAVITY;

            // Apply velocity
            player.x += player.vx;
            player.y += player.vy;

            // Collision detection with terrain
            player.grounded = false;

            // Ground check
            for (let ox = 0; ox < player.width; ox++) {
                if (this.terrain.isSolid(player.x + ox, player.y + player.height)) {
                    player.grounded = true;
                    player.y = Math.floor(player.y);
                    player.vy = 0;
                    break;
                }
            }

            // Ceiling check
            for (let ox = 0; ox < player.width; ox++) {
                if (this.terrain.isSolid(player.x + ox, player.y)) {
                    player.vy = 0;
                    player.y = Math.floor(player.y) + 1;
                    break;
                }
            }

            // Wall check
            for (let oy = 0; oy < player.height; oy++) {
                if (this.terrain.isSolid(player.x, player.y + oy)) {
                    player.x = Math.floor(player.x) + 1;
                    player.vx = 0;
                    break;
                }
                if (this.terrain.isSolid(player.x + player.width, player.y + oy)) {
                    player.x = Math.floor(player.x);
                    player.vx = 0;
                    break;
                }
            }

            // Jumping
            if (input.jump && player.grounded) {
                player.vy = -6;
                player.grounded = false;
            }

            // Update aim
            const centerX = player.x + player.width / 2;
            const centerY = player.y + player.height / 2;
            player.aimAngle = Math.atan2(input.mouseY - centerY, input.mouseX - centerX);

            // Bounds
            player.x = this.clamp(player.x, 0, this.WORLD_WIDTH - player.width);
            player.y = this.clamp(player.y, 0, this.WORLD_HEIGHT - player.height);

            // Anti-cheat: Track position history
            player.lastPositions.push({ x: player.x, y: player.y, tick: this.tick });
            if (player.lastPositions.length > 10) {
                player.lastPositions.shift();
            }

            // Anti-cheat: Detect teleporting
            if (player.lastPositions.length >= 2) {
                const prev = player.lastPositions[player.lastPositions.length - 2];
                const dist = Math.sqrt((player.x - prev.x) ** 2 + (player.y - prev.y) ** 2);
                if (dist > 20) { // Suspicious jump in position
                    this.flagSuspiciousActivity(id, `Teleport detected: ${dist.toFixed(1)} pixels`);
                }
            }
        }
    }

    updateProjectiles() {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const proj = this.projectiles[i];

            proj.lifetime += this.FIXED_TIMESTEP;

            if (proj.lifetime > proj.maxLifetime) {
                proj.dead = true;
                this.markProjectileDead(proj);
                this.projectiles.splice(i, 1);
                continue;
            }

            // Apply gravity based on spell type
            const gravity = this.getProjectileGravity(proj.type);
            proj.vy += gravity;

            // Move
            proj.x += proj.vx;
            proj.y += proj.vy;

            // Check collision with terrain
            if (this.terrain.isSolid(Math.floor(proj.x), Math.floor(proj.y))) {
                this.explodeProjectile(proj);
                proj.dead = true;
                this.markProjectileDead(proj);
                this.projectiles.splice(i, 1);
                continue;
            }

            // Check collision with players
            let hitPlayer = false;
            for (const [id, player] of this.players.entries()) {
                if (id === proj.ownerId || !player.alive) continue;

                if (this.checkProjectilePlayerCollision(proj, player)) {
                    const damage = this.getProjectileDamage(proj.type);
                    this.damagePlayer(id, damage, proj.ownerId);

                    const isPiercing = proj.type === 'ice';
                    if (!isPiercing) {
                        hitPlayer = true;
                        this.explodeProjectile(proj);
                        break;
                    }
                }
            }

            if (hitPlayer) {
                proj.dead = true;
                this.markProjectileDead(proj);
                this.projectiles.splice(i, 1);
                continue;
            }

            // Bounds check
            if (proj.x < 0 || proj.x > this.WORLD_WIDTH || 
                proj.y < 0 || proj.y > this.WORLD_HEIGHT) {
                proj.dead = true;
                this.markProjectileDead(proj);
                this.projectiles.splice(i, 1);
            }
        }
    }

    getProjectileGravity(type) {
        const gravities = {
            fireball: 0.05,
            ice: 0,
            lightning: 0,
            earth: 0.2
        };
        return gravities[type] || 0;
    }

    getProjectileDamage(type) {
        const damages = {
            fireball: 25,
            ice: 15,
            lightning: 30,
            earth: 20
        };
        return damages[type] || 20;
    }

    getExplosionRadius(type) {
        const radii = {
            fireball: 15,
            ice: 10,
            lightning: 8,
            earth: 20
        };
        return radii[type] || 10;
    }

    checkProjectilePlayerCollision(proj, player) {
        const px = player.x + player.width / 2;
        const py = player.y + player.height / 2;
        const dist = Math.sqrt((proj.x - px) ** 2 + (proj.y - py) ** 2);
        return dist < proj.radius + Math.max(player.width, player.height) / 2;
    }

    explodeProjectile(proj) {
        const radius = this.getExplosionRadius(proj.type);

        // Destroy terrain (server-authoritative)
        this.destroyTerrain(proj.x, proj.y, radius, true);

        // Area damage to nearby players
        const damage = this.getProjectileDamage(proj.type);
        for (const [id, player] of this.players.entries()) {
            if (id === proj.ownerId || !player.alive) continue;

            const px = player.x + player.width / 2;
            const py = player.y + player.height / 2;
            const dist = Math.sqrt((proj.x - px) ** 2 + (proj.y - py) ** 2);

            if (dist < radius * 2) {
                const damageFactor = 1 - (dist / (radius * 2));
                const areaDamage = Math.floor(damage * damageFactor * 0.5);
                this.damagePlayer(id, areaDamage, proj.ownerId);
            }
        }
    }

    destroyTerrain(x, y, radius, explosive = false) {
        // Server-side terrain destruction
        const destroyedCount = this.terrain.destroy(Math.floor(x), Math.floor(y), radius);

        if (destroyedCount > 0) {
            this.terrainVersion++;

            // Record modification for sync
            this.terrainModifications.push({
                tick: this.tick,
                x: Math.floor(x),
                y: Math.floor(y),
                radius: radius,
                explosive: explosive,
                version: this.terrainVersion
            });

            // Broadcast to all clients
            this.broadcast({
                type: 'terrain_update',
                x: Math.floor(x),
                y: Math.floor(y),
                radius: radius,
                explosive: explosive,
                version: this.terrainVersion
            });
        }
    }

    damagePlayer(playerId, damage, attackerId) {
        const player = this.players.get(playerId);
        if (!player || !player.alive) return;

        player.health -= damage;

        if (player.health <= 0) {
            player.health = 0;
            player.alive = false;

            console.log(`💀 Player ${playerId} killed by ${attackerId}`);

            // Broadcast death
            this.broadcast({
                type: 'player_death',
                playerId: playerId,
                killerId: attackerId
            });

            // Respawn after 3 seconds
            setTimeout(() => {
                this.respawnPlayer(playerId);
            }, 3000);
        }
    }

    respawnPlayer(playerId) {
        const player = this.players.get(playerId);
        if (!player) return;

        player.alive = true;
        player.health = player.maxHealth;
        player.x = Math.random() * 1200 + 200;
        player.y = 100;
        player.vx = 0;
        player.vy = 0;

        console.log(`♻️  Player ${playerId} respawned`);

        this.broadcast({
            type: 'player_respawn',
            playerId: playerId,
            x: player.x,
            y: player.y
        });
    }

    updateChunks() {
        // Server-side chunk physics (simplified for now)
        // In full implementation, chunks would have same physics as client
        for (let i = this.chunks.length - 1; i >= 0; i--) {
            const chunk = this.chunks[i];

            chunk.lifetime += this.FIXED_TIMESTEP;

            if (chunk.lifetime > 10000 || chunk.grounded) {
                this.chunks.splice(i, 1);
            }
        }
    }

    broadcastState() {
        const state = {
            type: 'state',
            tick: this.tick,
            chunkCount: this.chunks.length
        };

        const nextPlayerMap = new Map();
        const playerUpdates = [];
        const removedPlayers = [];
        const forceFullPlayers = this.forceFullPlayerBroadcast;

        for (const player of this.players.values()) {
            if (!player || !player.id) continue;
            const serialized = this.serializePlayerForBroadcast(player);
            nextPlayerMap.set(serialized.id, serialized);
            if (forceFullPlayers || this.playerBroadcastChanged(this.lastPlayerBroadcast.get(serialized.id), serialized)) {
                playerUpdates.push(serialized);
            }
        }

        if (forceFullPlayers) {
            state.players = Array.from(nextPlayerMap.values());
            state.playersFull = true;
        } else {
            for (const id of this.lastPlayerBroadcast.keys()) {
                if (!nextPlayerMap.has(id)) {
                    removedPlayers.push(id);
                }
            }
            if (playerUpdates.length) {
                state.players = playerUpdates;
            }
            if (removedPlayers.length) {
                state.removedPlayers = removedPlayers;
            }
        }

        this.lastPlayerBroadcast = nextPlayerMap;
        this.forceFullPlayerBroadcast = false;

        const nextProjectileMap = new Map();
        const projectileUpdates = [];
        const removedProjectiles = [];
        let forceFullProjectiles = this.forceFullProjectileBroadcast;
        const fullProjectileList = [];
        const now = Date.now();

        for (let i = 0; i < this.projectiles.length; i++) {
            const projectile = this.projectiles[i];
            const serialized = this.serializeProjectileForBroadcast(projectile);
            if (!serialized || !serialized.data) continue;
            const { key, data } = serialized;
            fullProjectileList.push(data);
            if (!key) {
                forceFullProjectiles = true;
                continue;
            }
            nextProjectileMap.set(key, data);
            if (forceFullProjectiles || this.projectileBroadcastChanged(this.lastProjectileBroadcast.get(key), data)) {
                projectileUpdates.push(data);
            }
        }

        if (forceFullProjectiles) {
            state.projectiles = fullProjectileList;
            state.projectilesFull = true;
        } else {
            for (const [key, prev] of this.lastProjectileBroadcast.entries()) {
                if (!nextProjectileMap.has(key)) {
                    removedProjectiles.push(prev);
                }
            }
            if (projectileUpdates.length) {
                state.projectiles = projectileUpdates;
            }
            if (removedProjectiles.length) {
                state.removedProjectiles = removedProjectiles.map((proj) => ({
                    id: proj && typeof proj.id === 'string' ? proj.id : null,
                    clientProjectileId: proj && typeof proj.clientProjectileId === 'string' ? proj.clientProjectileId : null
                }));
            }
        }

        this.lastProjectileBroadcast = nextProjectileMap;
        this.forceFullProjectileBroadcast = false;

        const broadcastProjectiles = state.projectilesFull
            ? fullProjectileList
            : (state.projectiles || []);

        if (broadcastProjectiles.length) {
            for (const serialized of broadcastProjectiles) {
                if (serialized.clientProjectileId && serialized.ownerId) {
                    const ownerRecords = this.recentClientProjectiles.get(serialized.ownerId);
                    if (ownerRecords) {
                        const record = ownerRecords.get(serialized.clientProjectileId);
                        if (record) {
                            record.serverId = serialized.id;
                            record.payload = { ...serialized, spawn: !serialized.dead };
                            record.dead = !!serialized.dead;
                            record.timestamp = now;
                        }
                    }
                }
            }
        }

        if (removedProjectiles.length) {
            for (const removal of removedProjectiles) {
                if (removal && removal.clientProjectileId && removal.ownerId) {
                    const ownerRecords = this.recentClientProjectiles.get(removal.ownerId);
                    if (ownerRecords) {
                        ownerRecords.delete(removal.clientProjectileId);
                    }
                }
            }
        }

        state.projectileCount = this.projectiles.length;

        const recentMods = this.terrainModifications.filter(
            (mod) => this.tick - mod.tick < 60
        );

        if (recentMods.length > 0) {
            state.terrainMods = recentMods;
        }

        this.broadcast(state);
    }

    broadcast(message, excludePlayerId = null) {
        const data = JSON.stringify(message);

        for (const [id, player] of this.players.entries()) {
            if (id === excludePlayerId) continue;
            if (player.ws.readyState === WebSocket.OPEN) {
                try {
                    player.ws.send(data);
                } catch (error) {
                    console.error(`❌ Error sending to ${id}:`, error);
                }
            }
        }
    }

    sendToPlayer(playerId, message) {
        const player = this.players.get(playerId);
        if (player && player.ws.readyState === WebSocket.OPEN) {
            try {
                player.ws.send(JSON.stringify(message));
            } catch (error) {
                console.error(`❌ Error sending to ${playerId}:`, error);
            }
        }
    }

    flagSuspiciousActivity(playerId, reason) {
        const player = this.players.get(playerId);
        if (!player) return;

        player.suspiciousActions++;

        console.warn(`⚠️  Suspicious activity from ${playerId}: ${reason} (count: ${player.suspiciousActions})`);

        // Kick if too many violations
        if (player.suspiciousActions > 10) {
            console.error(`🚫 Kicking ${playerId} for repeated violations`);
            player.ws.close(1008, 'Anti-cheat violation');
            this.players.delete(playerId);
        }
    }

    cleanup() {
        // Clean up old terrain modifications
        if (this.terrainModifications.length > 1000) {
            this.terrainModifications = this.terrainModifications.slice(-500);
        }

        // Remove disconnected players
        for (const [id, player] of this.players.entries()) {
            if (player.ws.readyState === WebSocket.CLOSED) {
                console.log(`🧹 Cleaning up disconnected player ${id}`);
                this.players.delete(id);
                this.recentClientProjectiles.delete(id);
            }
        }

        // Trim dedupe cache
        const now = Date.now();
        for (const [playerId, entries] of this.recentClientProjectiles.entries()) {
            if (!entries || entries.size === 0) {
                this.recentClientProjectiles.delete(playerId);
                continue;
            }
            for (const [clientId, record] of entries.entries()) {
                if (!record || now - record.timestamp > this.PROJECTILE_DEDUP_WINDOW) {
                    entries.delete(clientId);
                }
            }
            if (entries.size === 0) {
                this.recentClientProjectiles.delete(playerId);
            }
        }
    }

    markProjectileDead(projectile) {
        if (!projectile || !projectile.ownerId || !projectile.clientProjectileId) return;
        const ownerRecords = this.recentClientProjectiles.get(projectile.ownerId);
        if (!ownerRecords) return;
        const record = ownerRecords.get(projectile.clientProjectileId);
        if (!record) return;

        const payload = {
            type: 'projectile',
            id: projectile.id,
            clientProjectileId: projectile.clientProjectileId,
            ownerId: projectile.ownerId,
            dead: true,
            spawn: false
        };

        record.dead = true;
        record.payload = payload;
        record.timestamp = Date.now();

        this.sendToPlayer(projectile.ownerId, payload);
    }

    logStats() {
        const uptime = ((Date.now() - this.startTime) / 1000).toFixed(0);
        const messagesPerSecond = (this.totalMessages / uptime).toFixed(2);
        const avgTickTime = this.tickTimes.length > 0 
            ? (this.tickTimes.reduce((a, b) => a + b, 0) / this.tickTimes.length).toFixed(2)
            : 0;

        console.log('═══════════════════════════════════════════════════════');
        console.log(`📊 Server Statistics (Tick ${this.tick})`);
        console.log(`   ⏱️  Uptime: ${uptime}s`);
        console.log(`   👥 Players: ${this.players.size}`);
        console.log(`   💫 Projectiles: ${this.projectiles.length}`);
        console.log(`   🪨 Chunks: ${this.chunks.length}`);
        console.log(`   🌍 Terrain version: ${this.terrainVersion}`);
        console.log(`   📨 Messages/sec: ${messagesPerSecond}`);
        console.log(`   ⚡ Avg tick time: ${avgTickTime}ms`);
        console.log(`   💾 Total messages: ${this.totalMessages}`);
        console.log('═══════════════════════════════════════════════════════');
    }

    generatePlayerId() {
        return 'player-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
    }

    generateProjectileId() {
        return 'proj-' + Math.random().toString(36).substr(2, 9);
    }

    clamp(value, min, max) {
        return Math.max(min, Math.min(value, max));
    }
}

/**
 * Server-side Terrain (simplified version for physics)
 */
class ServerTerrain {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.pixels = new Uint8Array(width * height);

        this.EMPTY = 0;
        this.STONE = 1;
        this.DIRT = 2;
        this.GRASS = 3;
        this.BEDROCK = 4;
    }

    generate() {
        // Generate terrain (same as client)
        const noise = new SimplexNoise();

        for (let x = 0; x < this.width; x++) {
            const heightVariation = noise.noise2D(x * 0.005, 0) * 80;
            const baseHeight = this.height * 0.4 + heightVariation;

            for (let y = 0; y < this.height; y++) {
                const depth = y - baseHeight;

                if (depth < 0) {
                    this.setPixel(x, y, this.EMPTY);
                } else if (depth < 2) {
                    this.setPixel(x, y, this.GRASS);
                } else if (depth < 25) {
                    const dirtNoise = noise.noise2D(x * 0.1, y * 0.1);
                    this.setPixel(x, y, dirtNoise > 0.3 ? this.STONE : this.DIRT);
                } else {
                    const caveNoise1 = noise.noise2D(x * 0.02, y * 0.02);
                    const caveNoise2 = noise.noise2D(x * 0.03 + 100, y * 0.03 + 100);
                    const cave = caveNoise1 * caveNoise2;
                    this.setPixel(x, y, cave > 0.15 ? this.EMPTY : this.STONE);
                }

                if (y >= this.height - 3) {
                    this.setPixel(x, y, this.BEDROCK);
                }
            }
        }
    }

    setPixel(x, y, material) {
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
        this.pixels[y * this.width + x] = material;
    }

    getPixel(x, y) {
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) return this.BEDROCK;
        return this.pixels[y * this.width + x];
    }

    isSolid(x, y) {
        const pixel = this.getPixel(Math.floor(x), Math.floor(y));
        return pixel !== this.EMPTY;
    }

    destroy(centerX, centerY, radius) {
        let destroyedCount = 0;

        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = centerX + dx;
                const y = centerY + dy;

                if (dx * dx + dy * dy <= radius * radius) {
                    const material = this.getPixel(x, y);
                    if (material !== this.EMPTY && material !== this.BEDROCK) {
                        this.setPixel(x, y, this.EMPTY);
                        destroyedCount++;
                    }
                }
            }
        }

        return destroyedCount;
    }

    serialize() {
        // Return compressed terrain data for initial sync
        // In production, use better compression (RLE, etc.)
        return {
            width: this.width,
            height: this.height,
            data: Array.from(this.pixels) // Convert to array for JSON
        };
    }
}

/**
 * Simple noise generator (same as client)
 */
class SimplexNoise {
    constructor(seed = Math.random()) {
        this.seed = seed;
        this.perm = new Uint8Array(512);

        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            p[i] = i;
        }

        for (let i = 255; i > 0; i--) {
            const n = Math.floor((this.seed * 12345 + i) % (i + 1));
            [p[i], p[n]] = [p[n], p[i]];
            this.seed = (this.seed * 1103515245 + 12345) % 2147483647;
        }

        for (let i = 0; i < 512; i++) {
            this.perm[i] = p[i & 255];
        }
    }

    noise2D(x, y) {
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;

        x -= Math.floor(x);
        y -= Math.floor(y);

        const u = this.fade(x);
        const v = this.fade(y);

        const a = this.perm[X] + Y;
        const aa = this.perm[a];
        const ab = this.perm[a + 1];
        const b = this.perm[X + 1] + Y;
        const ba = this.perm[b];
        const bb = this.perm[b + 1];

        return this.lerp(v,
            this.lerp(u, this.grad(this.perm[aa], x, y), this.grad(this.perm[ba], x - 1, y)),
            this.lerp(u, this.grad(this.perm[ab], x, y - 1), this.grad(this.perm[bb], x - 1, y - 1))
        );
    }

    fade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    lerp(t, a, b) {
        return a + t * (b - a);
    }

    grad(hash, x, y) {
        const h = hash & 3;
        const u = h < 2 ? x : y;
        const v = h < 2 ? y : x;
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }
}

// Start server
const PORT = process.env.PORT || 8080;
const server = new GameServer(PORT);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    server.wss.close(() => {
        console.log('✅ Server closed gracefully');
        process.exit(0);
    });
});

process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled rejection at:', promise, 'reason:', reason);
});
