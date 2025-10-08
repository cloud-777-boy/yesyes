const { parentPort, workerData, Worker } = require('worker_threads');
const path = require('path');
const DeterministicRandom = require('./deterministic.js');
require('./terrain.js');
require('./physics.js');
require('./player.js');
require('./projectile.js');
const GameEngine = require('./engine.js');

class SimulationCore {
    constructor(config = {}) {
        this.config = config;
        this.tickRate = config.tickRate || 60;
        this.stateUpdateRate = config.stateUpdateRate || 20;
        this.sandUpdateRate = config.sandUpdateRate || 20;
        this.seed = config.seed ?? ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
        this.random = DeterministicRandom ? new DeterministicRandom(this.seed) : null;
        this.engine = null;

        this.players = new Map();
        this.playerActiveChunks = new Map();
        this.pendingChunkResync = new Map();
        this.chunkSubscribers = new Map();
        this.chunkVersions = new Map();
        this.playerChunkVersions = new Map();
        this.maxChunkSyncPerTick = config.maxChunkSyncPerTick || 4;
        this.chunkSyncRadius = config.chunkSyncRadius ?? 1;

        this.totalMessages = 0;
        this.startTime = Date.now();

        this.tickTimer = null;
        this.stateTimer = null;
        this.sandTimer = null;
        this.statsTimer = null;

        this.pendingTerrainBroadcasts = [];
        this.terrainModifications = [];
        this.maxTerrainModHistory = 1024;
        this.maxTerrainModBroadcast = 64;
        this.terrainChunkHistory = [];
        this.maxTerrainChunkHistory = 4096;
        this.pendingTerrainChunkDiffs = [];
        this.maxTerrainChunkBroadcast = 128;
        this.terrainChunkDiffCounter = 0;

        this.lastSandUpdateTime = 0;
        this.hasPendingSandUpdate = false;
        this.sandChunkRadius = config.sandChunkRadius || 0;

        this.terrainSnapshot = null;
        this.terrainSnapshotTick = 0;
        this.tick = 0;

        this.sandUpdateAccumulator = 0;

        this.sandWorker = null;
        this.sandWorkerRequests = new Map();
        this.nextSandRequestId = 1;
        this.sandReadyPromise = null;

        this.physicsRunning = false;
        this.staticTerrainStore = new Map();
        this.entityWorker = null;
        this.entityWorkerRequests = new Map();
        this.nextEntityRequestId = 1;
        this.entityReadyPromise = null;
        this.tickIntervalMs = 1000 / this.tickRate;
        this.dropParticlesUntil = 0;
        this.lastUpdateDuration = 0;
    }

    emit(event, data) {
        parentPort.postMessage({ type: 'event', event, data });
    }

    response(requestId, data) {
        parentPort.postMessage({ type: 'response', requestId, data });
    }

    initializeEngine() {
        this.engine = new GameEngine(null, true, { seed: this.seed });
        const serverComputeRadius = this.config.playerChunkComputeRadius ?? 1;
        const serverBufferRadius = this.config.playerChunkBufferRadius ?? 1;
        this.engine.playerChunkComputeRadius = serverComputeRadius;
        this.engine.playerChunkBufferRadius = serverBufferRadius;
        this.engine.sandChunkBroadcastRadius = Math.max(1, serverComputeRadius + serverBufferRadius);

        this.engine.init();
        this.sandChunkRadius = Math.max(1, serverComputeRadius + serverBufferRadius);

        if (this.staticTerrainStore) {
            this.staticTerrainStore.clear();
        }

        this.engine.onProjectileSpawn = (projectile) => this.handleServerProjectileSpawn(projectile);
        this.engine.onTerrainDestruction = ({ x, y, radius, explosive, broadcast }) => {
            if (broadcast === false) return;
            this.recordAndBroadcastTerrainModification(x, y, radius, explosive);
        };
        this.engine.onSandUpdate = (payload) => {
            if (!payload || !Array.isArray(payload.chunks) || payload.chunks.length === 0) return;
            const keys = payload.chunks
                .map((chunk) => (chunk && typeof chunk.key === 'string') ? chunk.key : null)
                .filter((key) => key);
            if (keys.length) {
                this.queueChunkResyncForKeys(keys, true);
            }
            this.emit('sand_update', {
                chunkSize: payload.chunkSize,
                chunks: payload.chunks,
                full: false
            });
        };

        this.terrainSnapshot = this.engine.getTerrainSnapshot();
        this.tick = this.engine.tick;
        this.terrainSnapshotTick = this.tick;

        this.setupSandWorker();
        this.setupEntityWorker();
    }

    startLoops() {
        const tickInterval = 1000 / this.tickRate;
        const stateInterval = 1000 / this.stateUpdateRate;

        if (this.tickTimer) clearInterval(this.tickTimer);
        if (this.stateTimer) clearInterval(this.stateTimer);

        this.tickTimer = setInterval(() => {
            this.updatePhysics().catch((err) => {
                this.emit('error', { scope: 'updatePhysics', message: err.message, stack: err.stack });
            });
        }, tickInterval);

        this.stateTimer = setInterval(() => {
            try {
                this.broadcastState();
            } catch (err) {
                this.emit('error', { scope: 'broadcastState', message: err.message, stack: err.stack });
            }
        }, stateInterval);

        this.statsTimer = setInterval(() => {
            this.logStats();
        }, 10000);
    }

    setupSandWorker() {
        if (this.sandWorker || !this.engine) {
            return;
        }

        const sandConfig = {
            seed: this.seed,
            width: this.engine.width,
            height: this.engine.height,
            chunkSize: this.engine.chunkSize,
            terrainSnapshot: this.terrainSnapshot
        };

        const workerPath = path.resolve(__dirname, 'sandWorker.js');
        this.sandWorker = new Worker(workerPath, { workerData: sandConfig });

        this.sandWorker.on('message', (msg) => this.handleSandWorkerMessage(msg));
        this.sandWorker.on('error', (error) => {
            this.emit('error', { scope: 'sandWorker', message: error.message, stack: error.stack });
        });
        this.sandWorker.on('exit', (code) => {
            if (code !== 0) {
                this.emit('error', { scope: 'sandWorker', message: `sand worker exited with code ${code}` });
            }
            this.sandWorker = null;
        });

        this.sandReadyPromise = this.postToSandWorker('init', sandConfig)
            .catch((error) => {
                this.emit('error', { scope: 'sandWorker', message: error.message, stack: error.stack });
                throw error;
            });
    }

    handleSandWorkerMessage(msg) {
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'response') {
            const pending = this.sandWorkerRequests.get(msg.requestId);
            if (!pending) return;
            this.sandWorkerRequests.delete(msg.requestId);
            clearTimeout(pending.timeout);
            pending.resolve(msg.data);
            return;
        }

        if (msg.type === 'event') {
            // No event types defined yet, reserve for future instrumentation
            if (msg.event === 'error' && msg.data) {
                this.emit('error', { scope: 'sandWorker', ...msg.data });
            }
        }
    }

    postToSandWorker(type, payload = {}, expectResponse = true) {
        if (!this.sandWorker) {
            return Promise.reject(new Error('Sand worker not ready'));
        }

        if (!expectResponse) {
            this.sandWorker.postMessage({ type, payload });
            return Promise.resolve();
        }

        const requestId = this.nextSandRequestId++;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.sandWorkerRequests.delete(requestId);
                reject(new Error(`Sand worker request "${type}" timed out`));
            }, 5000);

            this.sandWorkerRequests.set(requestId, { resolve, reject, timeout });
            this.sandWorker.postMessage({ type, payload, requestId });
        });
    }

    async ensureSandWorkerReady() {
        if (this.sandReadyPromise) {
            await this.sandReadyPromise;
            this.sandReadyPromise = null;
        }
    }

    setupEntityWorker() {
        if (this.entityWorker || !this.engine) {
            return;
        }

        const entityConfig = {
            seed: this.seed,
            width: this.engine.width,
            height: this.engine.height,
            chunkSize: this.engine.chunkSize,
            terrainSnapshot: this.terrainSnapshot
        };

        const workerPath = path.resolve(__dirname, 'entityWorker.js');
        this.entityWorker = new Worker(workerPath, { workerData: entityConfig });

        this.entityWorker.on('message', (msg) => this.handleEntityWorkerMessage(msg));
        this.entityWorker.on('error', (error) => {
            this.emit('error', { scope: 'entityWorker', message: error.message, stack: error.stack });
        });
        this.entityWorker.on('exit', (code) => {
            if (code !== 0) {
                this.emit('error', { scope: 'entityWorker', message: `entity worker exited with code ${code}` });
            }
            this.entityWorker = null;
        });

        this.entityReadyPromise = this.postToEntityWorker('init', entityConfig)
            .catch((error) => {
                this.emit('error', { scope: 'entityWorker', message: error.message, stack: error.stack });
                throw error;
            });
    }

    handleEntityWorkerMessage(msg) {
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'response') {
            const pending = this.entityWorkerRequests.get(msg.requestId);
            if (!pending) return;
            this.entityWorkerRequests.delete(msg.requestId);
            clearTimeout(pending.timeout);
            pending.resolve(msg.data);
            return;
        }

        if (msg.type === 'event') {
            if (msg.event === 'error' && msg.data) {
                this.emit('error', { scope: 'entityWorker', ...msg.data });
            }
        }
    }

    postToEntityWorker(type, payload = {}, expectResponse = true) {
        if (!this.entityWorker) {
            return Promise.reject(new Error('Entity worker not ready'));
        }

        if (!expectResponse) {
            this.entityWorker.postMessage({ type, payload });
            return Promise.resolve();
        }

        const requestId = this.nextEntityRequestId++;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.entityWorkerRequests.delete(requestId);
                reject(new Error(`Entity worker request "${type}" timed out`));
            }, 5000);

            this.entityWorkerRequests.set(requestId, { resolve, reject, timeout });
            this.entityWorker.postMessage({ type, payload, requestId });
        });
    }

    async ensureEntityWorkerReady() {
        if (this.entityReadyPromise) {
            await this.entityReadyPromise;
            this.entityReadyPromise = null;
        }
    }

    async offloadSandUpdate(dt) {
        if (!this.sandWorker || !this.engine) {
            return;
        }

        const activeKeys = this.engine.activeSandChunkKeys && this.engine.activeSandChunkKeys.length
            ? Array.from(this.engine.activeSandChunkKeys)
            : [];

        if (activeKeys.length === 0) {
            return;
        }

        const sandSnapshot = activeKeys.length
            ? this.engine.serializeSandChunksForKeys(activeKeys, { includeState: true })
            : this.engine.serializeSandChunks(true, { includeState: true });

        if (!sandSnapshot || !Array.isArray(sandSnapshot.chunks)) {
            return;
        }

        const terrainSnapshot = this.engine.serializeTerrainChunksForKeys(activeKeys);

        try {
            const response = await this.postToSandWorker('update', {
                dt,
                tick: this.tick,
                keys: activeKeys,
                sandSnapshot,
                terrainSnapshot
            });

            if (!response) {
                return;
            }

            const dirtySet = new Set(Array.isArray(response.dirtyKeys) ? response.dirtyKeys : []);

            if (response.sandSnapshot && Array.isArray(response.sandSnapshot.chunks)) {
                this.engine.applySandSnapshot(response.sandSnapshot, false);
                for (const chunk of response.sandSnapshot.chunks) {
                    if (chunk && typeof chunk.key === 'string') {
                        dirtySet.add(chunk.key);
                    }
                }
            }

            if (dirtySet.size) {
                this.engine.flushDirtySandChunks(Array.from(dirtySet));
            }

            if (Number.isFinite(response.sandCount)) {
                this.engine.sandParticleCount = response.sandCount;
            }
        } catch (error) {
            this.emit('error', { scope: 'sandWorker', message: error.message, stack: error.stack });
            // Fallback to local sand update if worker fails
            this.engine.updateSand(dt);
        }
    }

    async offloadEntityUpdate(dt) {
        if (!this.entityWorker || !this.engine) {
            return false;
        }

        await this.ensureEntityWorkerReady();

        const activeKeys = this.engine.activeChunkKeys && this.engine.activeChunkKeys.length
            ? Array.from(this.engine.activeChunkKeys)
            : null;

        const entities = this.engine.serializeEntities(activeKeys);
        if ((!entities.players.length) && (!entities.projectiles.length)) {
            return false;
        }

        const terrainSnapshot = activeKeys && activeKeys.length
            ? this.engine.serializeTerrainChunksForKeys(activeKeys)
            : null;

        try {
            const response = await this.postToEntityWorker('update', {
                dt,
                tick: this.tick,
                keys: activeKeys,
                entities,
                terrainSnapshot
            });

            if (response && response.entities) {
                this.engine.applyEntitySnapshot(response.entities);
            }
            const dirtyKeys = new Set(Array.isArray(response?.dirtyChunks) ? response.dirtyChunks : []);

            if (response && response.terrainModifications) {
                this.engine.terrain.applyModifications(response.terrainModifications);
                if (Array.isArray(response.terrainModifications.chunks)) {
                    for (const chunk of response.terrainModifications.chunks) {
                        if (chunk && typeof chunk.key === 'string') {
                            dirtyKeys.add(chunk.key);
                            this.engine.terrain.unmarkChunkStatic(chunk.key);
                        }
                    }
                }
            }

            if (response && Array.isArray(response.terrainMods)) {
                for (const mod of response.terrainMods) {
                    if (!mod) continue;
                    this.recordAndBroadcastTerrainModification(mod.x, mod.y, mod.radius, mod.explosive);
                }
            }

            if (dirtyKeys.size) {
                this.queueChunkResyncForKeys(Array.from(dirtyKeys), true);
            }
            return true;
        } catch (error) {
            this.emit('error', { scope: 'entityWorker', message: error.message, stack: error.stack });
            this.engine.updateEntities(dt, activeKeys);
            return false;
        }
    }

    async updatePhysics() {
        if (!this.engine || this.physicsRunning) return;
        this.physicsRunning = true;
        const startTime = Date.now();
        try {
            const dt = this.engine.fixedTimeStep || (1000 / this.tickRate);

            await this.ensureEntityWorkerReady();
            const { width: viewWidth, height: viewHeight } = this.engine.getViewDimensions();
            this.engine.updateActiveChunks(viewWidth, viewHeight);

            let entityUpdated = false;
            if (this.entityWorker) {
                entityUpdated = await this.offloadEntityUpdate(dt);
            }
            if (!entityUpdated) {
                const activeKeys = this.engine.activeChunkKeys && this.engine.activeChunkKeys.length
                    ? Array.from(this.engine.activeChunkKeys)
                    : null;
                this.engine.updateEntities(dt, activeKeys);
            }

            await this.ensureSandWorkerReady();
            const skipParticles = this.dropParticlesUntil > this.tick;
            const activeKeys = this.engine.activeChunkKeys && this.engine.activeChunkKeys.length
                ? Array.from(this.engine.activeChunkKeys)
                : null;

            this.engine.update(dt, {
                skipSand: !!this.sandWorker,
                skipEntities: !!this.entityWorker,
                skipParticles,
                entityKeys: activeKeys
            });

            this.engine.tick += 1;
            this.tick = this.engine.tick;

            if (this.sandWorker) {
                await this.offloadSandUpdate(dt);
            }

            this.broadcastPendingSandUpdate();
        } finally {
            const duration = Date.now() - startTime;
            this.lastUpdateDuration = duration;
            if (duration > this.tickIntervalMs) {
                const overTicks = Math.ceil(duration / this.tickIntervalMs);
                this.dropParticlesUntil = this.tick + overTicks;
            } else if (this.dropParticlesUntil > this.tick) {
                this.dropParticlesUntil = Math.max(this.dropParticlesUntil - 1, 0);
            }
            this.physicsRunning = false;
        }
    }

    broadcastState() {
        if (!this.engine) return;

        this.updatePlayerChunkTracking();

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
            lastProcessedInput: this.players.get(player.id)?.lastInputSequence || 0,
            chunkKey: this.getChunkKeyForPosition(player.x, player.y)
        }));

        const projectiles = this.engine.projectiles.map((proj) => ({
            id: proj.serverId || null,
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

        const terrainChunkDiffs = this.pendingTerrainChunkDiffs.length
            ? this.pendingTerrainChunkDiffs.splice(0, this.pendingTerrainChunkDiffs.length)
            : [];

        const state = {
            tick: this.tick,
            seed: this.seed,
            players,
            projectiles,
            terrainMods,
            terrainSnapshotTick: this.terrainSnapshotTick,
            serverStats: this.getServerStats()
        };

        if (terrainChunkDiffs.length) {
            state.terrainChunkDiffs = terrainChunkDiffs;
        }

        this.emit('state', state);

        this.flushPendingChunkResyncs();

        if (this.terrainModifications.length > this.maxTerrainModHistory) {
            this.terrainModifications = this.terrainModifications.slice(-this.maxTerrainModHistory);
        }

        const staticUpdate = this.engine.pullStaticTerrainUpdates(8);
        if (staticUpdate) {
            if (staticUpdate.static && staticUpdate.static.chunks && staticUpdate.static.chunks.length) {
                const chunkSize = staticUpdate.static.chunkSize || this.engine.chunkSize;
                for (const chunk of staticUpdate.static.chunks) {
                    if (!chunk || !chunk.key) continue;
                    const stored = {
                        key: chunk.key,
                        data: chunk.data
                    };
                    if (chunk.pixels) {
                        stored.pixels = chunk.pixels.map((px) => ({ ...px }));
                    }
                    this.staticTerrainStore.set(chunk.key, stored);
                }
                this.emit('terrain_static', {
                    chunkSize,
                    chunks: staticUpdate.static.chunks,
                    static: true
                });
            }

            if (Array.isArray(staticUpdate.invalidate) && staticUpdate.invalidate.length) {
                for (const key of staticUpdate.invalidate) {
                    this.staticTerrainStore.delete(key);
                }
                this.emit('terrain_static_clear', { keys: staticUpdate.invalidate });
                this.queueChunkResyncForKeys(staticUpdate.invalidate, true);
            }
        }
    }

    logStats() {
        const uptime = ((Date.now() - this.startTime) / 1000).toFixed(0);
        const messagesPerSecond = uptime > 0 ? (this.totalMessages / uptime).toFixed(2) : '0.00';
        this.emit('log', {
            uptime: Number(uptime),
            players: this.players.size,
            tick: this.tick,
            messagesPerSecond,
            totalMessages: this.totalMessages
        });
    }

    broadcastPendingSandUpdate() {
        if (!this.engine) return;

        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastSandUpdateTime;
        if (timeSinceLastUpdate < (1000 / this.sandUpdateRate)) {
            return;
        }

        if (this.engine.sandParticleCount > 0 && this.engine.players.size > 0) {
            const sandUpdate = this.engine.serializeSandChunksNearPlayers(this.sandChunkRadius);
            if (sandUpdate && sandUpdate.chunks && sandUpdate.chunks.length > 0) {
                const keys = sandUpdate.chunks
                    .map((chunk) => (chunk && typeof chunk.key === 'string') ? chunk.key : null)
                    .filter((key) => key);
                if (keys.length) {
                    this.queueChunkResyncForKeys(keys, true);
                }
                this.emit('sand_update', {
                    chunkSize: sandUpdate.chunkSize,
                    chunks: sandUpdate.chunks,
                    full: false
                });
                this.lastSandUpdateTime = now;
                this.hasPendingSandUpdate = false;
            }
        } else {
            this.hasPendingSandUpdate = false;
        }
    }

    getServerStats() {
        if (!this.engine) {
            return {
                players: this.players.size,
                sand: 0,
                projectiles: 0,
                tick: this.tick
            };
        }

        const sandCount = Number.isFinite(this.engine.sandParticleCount)
            ? this.engine.sandParticleCount
            : 0;
        const projectileCount = Array.isArray(this.engine.projectiles)
            ? this.engine.projectiles.length
            : 0;

        return {
            players: this.players.size,
            sand: sandCount,
            projectiles: projectileCount,
            tick: this.tick
        };
    }

    addPlayer(playerId, selectedSpell = 0) {
        const spawnX = this.random ? this.random.nextRange(400, 1200) : Math.random() * 1200 + 200;
        const spawnY = 100;

        const player = {
            id: playerId,
            selectedSpell,
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

        const referenceX = enginePlayer ? enginePlayer.x : spawnX;
        const referenceY = enginePlayer ? enginePlayer.y : spawnY;
        const initialChunks = this.getChunkKeysAround(referenceX, referenceY, this.chunkSyncRadius);
        if (initialChunks && initialChunks.size) {
            this.playerActiveChunks.set(playerId, initialChunks);
            this.ensurePlayerVersionMap(playerId);
            for (const key of initialChunks) {
                this.subscribePlayerToChunk(key, playerId);
            }
            this.queueChunksForPlayer(playerId, initialChunks);
        }

        const welcomePayload = this.buildWelcomePayload(playerId, enginePlayer ?? { x: spawnX, y: spawnY, selectedSpell });

        const existingPlayers = [];
        for (const [id, p] of this.players.entries()) {
            if (id === playerId) continue;
            const existingEngine = this.engine ? this.engine.players.get(id) : null;
            existingPlayers.push({
                playerId: id,
                x: existingEngine ? existingEngine.x : 0,
                y: existingEngine ? existingEngine.y : 0,
                selectedSpell: p.selectedSpell
            });
        }

        return {
            spawnX: enginePlayer ? enginePlayer.x : spawnX,
            spawnY: enginePlayer ? enginePlayer.y : spawnY,
            welcome: welcomePayload,
            existingPlayers
        };
    }

    buildWelcomePayload(playerId, enginePlayer) {
        const payload = {
            type: 'welcome',
            playerId,
            tick: this.tick,
            spawnX: enginePlayer.x,
            spawnY: enginePlayer.y,
            selectedSpell: enginePlayer.selectedSpell,
            seed: this.seed,
            terrainSnapshot: this.terrainSnapshot,
            terrainSnapshotTick: this.terrainSnapshotTick
        };

        const modsForWelcome = this.terrainModifications
            .filter((entry) => {
                if (!entry || typeof entry.tick !== 'number') return true;
                return entry.tick > this.terrainSnapshotTick;
            })
            .slice(-this.maxTerrainModBroadcast);
        payload.terrainMods = modsForWelcome;
        const terrainChunkDiffs = this.getTerrainChunkHistorySnapshot();
        if (terrainChunkDiffs && terrainChunkDiffs.length > 0) {
            payload.terrainChunkDiffs = terrainChunkDiffs;
        }
        if (this.engine) {
            if (typeof this.engine.chunkSize === 'number') {
                payload.chunkSize = this.engine.chunkSize;
            }
            const sandSnapshot = this.engine.serializeSandChunks(false);
            if (sandSnapshot) {
                payload.sandChunks = sandSnapshot;
            }
        }

        if (this.staticTerrainStore && this.staticTerrainStore.size) {
            payload.staticTerrain = {
                chunkSize: this.engine ? this.engine.chunkSize : (payload.chunkSize || this.config.chunkSize || 64),
                chunks: Array.from(this.staticTerrainStore.values())
            };
        }
        return payload;
    }

    removePlayer(playerId) {
        const player = this.players.get(playerId);
        if (!player) return;
        this.players.delete(playerId);
        if (this.engine && typeof this.engine.removePlayer === 'function') {
            this.engine.removePlayer(playerId);
        }
        const activeChunks = this.playerActiveChunks.get(playerId);
        if (activeChunks && activeChunks.size) {
            for (const key of activeChunks) {
                this.unsubscribePlayerFromChunk(key, playerId);
            }
        }
        this.playerActiveChunks.delete(playerId);
        this.pendingChunkResync.delete(playerId);
        this.playerChunkVersions.delete(playerId);
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
            this.emit('send_to_player', {
                playerId,
                message: {
                    type: 'input_ack',
                    sequence: input.sequence
                }
            });
        }
    }

    handleServerProjectileSpawn(projectile) {
        if (!projectile) return;
        if (!projectile.serverId) {
            projectile.serverId = this.generateProjectileId();
        }
        const payload = {
            type: 'projectile',
            id: projectile.serverId,
            x: projectile.x,
            y: projectile.y,
            vx: projectile.vx,
            vy: projectile.vy,
            type: projectile.type,
            ownerId: projectile.ownerId,
            clientProjectileId: projectile.clientProjectileId || null,
            lifetime: projectile.lifetime
        };
        this.emit('broadcast', { message: payload });
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
            if (!projectile.serverId) {
                projectile.serverId = this.generateProjectileId();
            }
            const dt = this.engine.fixedTimeStep || (1000 / this.tickRate);
            projectile.update(dt, this.engine);
        }
    }

    handleTerrainDestruction(playerId, msg) {
        if (!this.engine) return;
        this.engine.destroyTerrain(msg.x, msg.y, msg.radius, !!msg.explosive);
    }

    generateProjectileId() {
        if (!this.projectileCounter) {
            this.projectileCounter = 0;
        }
        this.projectileCounter = (this.projectileCounter + 1) >>> 0;
        const suffix = this.projectileCounter.toString(36).padStart(4, '0');
        return `proj-${Date.now().toString(36)}-${suffix}`;
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

        this.emit('broadcast', {
            message: {
                type: 'terrain_update',
                x,
                y,
                radius,
                explosive,
                tick: mod.tick
            }
        });

        const diff = this.captureTerrainChunkDiff(mod.tick);
        if (diff && Array.isArray(diff.chunks) && diff.chunks.length) {
            this.emit('broadcast', {
                message: {
                    type: 'terrain_chunk_update',
                    chunkDiff: diff
                }
            });

            const keys = diff.chunks
                .map((chunk) => (chunk && typeof chunk.key === 'string') ? chunk.key : null)
                .filter((key) => key);
            if (keys.length) {
                const terrainSnapshot = this.engine.serializeTerrainChunksForKeys(keys, {
                    keyChunkSize: diff.chunkSize || this.engine.chunkSize
                });
                if (terrainSnapshot && Array.isArray(terrainSnapshot.chunks) && terrainSnapshot.chunks.length > 0) {
                    this.emit('broadcast', {
                        message: {
                            type: 'chunk_sync',
                            terrain: terrainSnapshot
                        }
                    });
                }
                this.queueChunkResyncForKeys(keys, true);
            }
        }
    }

    captureTerrainChunkDiff(tick = this.tick) {
        if (!this.engine || !this.engine.terrain || typeof this.engine.terrain.getModifications !== 'function') {
            return null;
        }

        const diff = this.engine.terrain.getModifications();
        if (!diff || !Array.isArray(diff.chunks) || diff.chunks.length === 0) {
            return null;
        }

        const sanitized = this.sanitizeTerrainChunkDiff(diff, tick);
        if (!sanitized || sanitized.chunks.length === 0) {
            return null;
        }

        this.pendingTerrainChunkDiffs.push(sanitized);
        if (this.pendingTerrainChunkDiffs.length > this.maxTerrainChunkBroadcast) {
            this.pendingTerrainChunkDiffs.splice(0, this.pendingTerrainChunkDiffs.length - this.maxTerrainChunkBroadcast);
        }

        this.terrainChunkHistory.push(sanitized);
        if (this.terrainChunkHistory.length > this.maxTerrainChunkHistory) {
            this.refreshTerrainSnapshot(true);
        }

        return sanitized;
    }

    sanitizeTerrainChunkDiff(diff, tick) {
        const chunkSize = typeof diff.chunkSize === 'number' && diff.chunkSize > 0
            ? diff.chunkSize
            : (this.engine && typeof this.engine.chunkSize === 'number' ? this.engine.chunkSize : 0);
        const normalizedTick = Number.isFinite(tick) ? tick : this.tick;

        const sanitized = {
            id: ++this.terrainChunkDiffCounter,
            tick: normalizedTick,
            chunkSize,
            chunks: []
        };

        for (const entry of diff.chunks) {
            if (!entry || !entry.key) continue;
            const pixels = Array.isArray(entry.pixels)
                ? entry.pixels
                    .filter((px) => px && typeof px.localIndex === 'number' && typeof px.material === 'number')
                    .map((px) => ({ localIndex: px.localIndex, material: px.material }))
                : [];
            if (pixels.length === 0) continue;
            sanitized.chunks.push({
                key: entry.key,
                pixels
            });
        }

        return sanitized;
    }

    getTerrainChunkHistorySnapshot() {
        if (!this.terrainChunkHistory || this.terrainChunkHistory.length === 0) {
            return null;
        }
        return this.terrainChunkHistory.map((entry) => ({
            id: entry.id,
            tick: entry.tick,
            chunkSize: entry.chunkSize,
            chunks: entry.chunks.map((chunk) => ({
                key: chunk.key,
                pixels: chunk.pixels.map((pixel) => ({
                    localIndex: pixel.localIndex,
                    material: pixel.material
                }))
            }))
        }));
    }

    refreshTerrainSnapshot(preservePendingDiffs = false) {
        if (!this.engine || typeof this.engine.getTerrainSnapshot !== 'function') {
            return;
        }
        const snapshot = this.engine.getTerrainSnapshot();
        if (snapshot) {
            this.terrainSnapshot = snapshot;
        }
        this.terrainSnapshotTick = this.tick;
        this.terrainChunkHistory.length = 0;
        if (!preservePendingDiffs) {
            this.pendingTerrainChunkDiffs.length = 0;
        }
        if (Array.isArray(this.terrainModifications) && this.terrainModifications.length > 0) {
            this.terrainModifications = this.terrainModifications.filter((entry) => {
                if (!entry || typeof entry.tick !== 'number') return false;
                return entry.tick > this.terrainSnapshotTick;
            });
        }
    }

    getChunkKeysAround(x, y, radius = this.chunkSyncRadius) {
        const keys = new Set();
        if (!this.engine || !Number.isFinite(x) || !Number.isFinite(y)) {
            return keys;
        }

        const chunkSize = Math.max(1, this.engine.chunkSize || 1);
        const width = Math.max(1, this.engine.width || 0);
        const height = Math.max(1, this.engine.height || 0);
        const totalChunksX = Math.max(1, Math.ceil(width / chunkSize));
        const totalChunksY = Math.max(1, Math.ceil(height / chunkSize));

        const normalizedX = typeof wrapHorizontal === 'function'
            ? wrapHorizontal(x, width)
            : (((x % width) + width) % width);
        const clampedY = Math.max(0, Math.min(height - 1, y));
        const centerChunkX = Math.floor(normalizedX / chunkSize);
        const centerChunkY = Math.max(0, Math.min(totalChunksY - 1, Math.floor(clampedY / chunkSize)));

        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const chunkX = ((centerChunkX + dx) % totalChunksX + totalChunksX) % totalChunksX;
                const chunkY = Math.max(0, Math.min(totalChunksY - 1, centerChunkY + dy));
                keys.add(`${chunkX}|${chunkY}`);
            }
        }

        return keys;
    }

    getChunkKeyForPosition(x, y) {
        if (!this.engine || !Number.isFinite(x) || !Number.isFinite(y)) {
            return null;
        }

        const chunkSize = Math.max(1, this.engine.chunkSize || 1);
        const width = Math.max(1, this.engine.width || 0);
        const height = Math.max(1, this.engine.height || 0);
        if (!width || !height) {
            return null;
        }

        const normalizedX = typeof wrapHorizontal === 'function'
            ? wrapHorizontal(x, width)
            : (((x % width) + width) % width);
        const clampedY = Math.max(0, Math.min(height - 1, y));

        const chunkX = Math.floor(normalizedX / chunkSize);
        const chunkY = Math.floor(clampedY / chunkSize);

        return `${chunkX}|${chunkY}`;
    }

    ensurePlayerVersionMap(playerId) {
        let versionMap = this.playerChunkVersions.get(playerId);
        if (!versionMap) {
            versionMap = new Map();
            this.playerChunkVersions.set(playerId, versionMap);
        }
        return versionMap;
    }

    queueChunksForPlayer(playerId, keys) {
        if (!playerId || !keys) return;
        const versionMap = this.ensurePlayerVersionMap(playerId);
        let queue = this.pendingChunkResync.get(playerId);
        if (!queue) {
            queue = new Set();
            this.pendingChunkResync.set(playerId, queue);
        }
        const iterable = (keys instanceof Set || Array.isArray(keys)) ? keys : [keys];
        for (const key of iterable) {
            if (!key) continue;
            const normalizedKey = String(key);
            queue.add(normalizedKey);
            if (!versionMap.has(normalizedKey)) {
                versionMap.set(normalizedKey, 0);
            }
            if (!this.chunkVersions.has(normalizedKey)) {
                this.chunkVersions.set(normalizedKey, 1);
            }
        }
    }

    queueChunkResyncForKeys(keys, bumpVersion = false) {
        if (!keys) return;
        const keyList = Array.isArray(keys) ? keys : Array.from(keys);
        if (!keyList.length) return;

        for (let i = 0; i < keyList.length; i++) {
            const rawKey = keyList[i];
            if (!rawKey) continue;
            const key = String(rawKey);
            this.markChunkVersion(key, bumpVersion);
            const subscribers = this.chunkSubscribers.get(key);
            if (!subscribers || subscribers.size === 0) continue;
            for (const playerId of subscribers) {
                this.queueChunksForPlayer(playerId, [key]);
            }
        }
    }

    markChunkVersion(key, bumpVersion) {
        const current = this.chunkVersions.get(key) || 0;
        if (bumpVersion) {
            this.chunkVersions.set(key, current > 0 ? current + 1 : 1);
        } else if (!this.chunkVersions.has(key)) {
            this.chunkVersions.set(key, 1);
        }
    }

    subscribePlayerToChunk(key, playerId) {
        if (!key || !playerId) return;
        const normalizedKey = String(key);
        this.ensurePlayerVersionMap(playerId);
        let subscribers = this.chunkSubscribers.get(normalizedKey);
        if (!subscribers) {
            subscribers = new Set();
            this.chunkSubscribers.set(normalizedKey, subscribers);
        }
        subscribers.add(playerId);
        if (!this.chunkVersions.has(normalizedKey)) {
            this.chunkVersions.set(normalizedKey, 1);
        }
    }

    unsubscribePlayerFromChunk(key, playerId) {
        if (!key || !playerId) return;
        const normalizedKey = String(key);
        const subscribers = this.chunkSubscribers.get(normalizedKey);
        if (!subscribers) return;
        subscribers.delete(playerId);
        if (subscribers.size === 0) {
            this.chunkSubscribers.delete(normalizedKey);
        }
        const queue = this.pendingChunkResync.get(playerId);
        if (queue) {
            queue.delete(normalizedKey);
            if (queue.size === 0) {
                this.pendingChunkResync.delete(playerId);
            }
        }
        const versionMap = this.playerChunkVersions.get(playerId);
        if (versionMap) {
            versionMap.delete(normalizedKey);
        }
    }

    updatePlayerChunkTracking() {
        if (!this.engine) return;
        for (const playerId of this.players.keys()) {
            const enginePlayer = this.engine.players ? this.engine.players.get(playerId) : null;
            if (!enginePlayer) continue;
            const keys = this.getChunkKeysAround(enginePlayer.x, enginePlayer.y, this.chunkSyncRadius);
            const prev = this.playerActiveChunks.get(playerId) || new Set();

            if (!keys.size) {
                if (prev.size) {
                    for (const key of prev) {
                        this.unsubscribePlayerFromChunk(key, playerId);
                    }
                }
                this.playerActiveChunks.set(playerId, new Set());
                continue;
            }

            for (const key of prev) {
                if (!keys.has(key)) {
                    this.unsubscribePlayerFromChunk(key, playerId);
                }
            }

            for (const key of keys) {
                if (!prev.has(key)) {
                    this.subscribePlayerToChunk(key, playerId);
                    this.queueChunksForPlayer(playerId, [key]);
                }
            }

            this.playerActiveChunks.set(playerId, keys);
        }
    }

    flushPendingChunkResyncs() {
        if (!this.engine || this.pendingChunkResync.size === 0) return;

        for (const [playerId, keySet] of this.pendingChunkResync.entries()) {
            if (!keySet || keySet.size === 0) continue;
            const versionMap = this.ensurePlayerVersionMap(playerId);
            const keysToSend = [];

            for (const key of keySet) {
                const version = this.chunkVersions.get(key) || 0;
                if (version <= 0) {
                    keySet.delete(key);
                    continue;
                }
                const playerVersion = versionMap.get(key) || 0;
                if (playerVersion >= version) {
                    keySet.delete(key);
                    continue;
                }
                keysToSend.push(key);
                if (keysToSend.length >= this.maxChunkSyncPerTick) {
                    break;
                }
            }

            if (!keysToSend.length) continue;

            const terrainSnapshot = this.engine.serializeTerrainChunksForKeys(keysToSend, {
                keyChunkSize: this.engine.chunkSize
            });
            const sandSnapshot = this.engine.serializeSandChunksForKeys(keysToSend);
            const hasTerrain = terrainSnapshot && Array.isArray(terrainSnapshot.chunks) && terrainSnapshot.chunks.length > 0;
            const hasSand = sandSnapshot && Array.isArray(sandSnapshot.chunks) && sandSnapshot.chunks.length > 0;

            if (hasTerrain || hasSand) {
                const payload = { type: 'chunk_sync' };

                if (hasTerrain) {
                    payload.terrain = terrainSnapshot;
                }
                if (hasSand) {
                    payload.sandChunks = sandSnapshot;
                }

                this.emit('send_to_player', {
                    playerId,
                    message: payload
                });
            }

            for (const key of keysToSend) {
                const version = this.chunkVersions.get(key) || 0;
                versionMap.set(key, version);
                keySet.delete(key);
            }

            if (keySet.size === 0) {
                this.pendingChunkResync.delete(playerId);
            }
        }
    }
}

const simulation = new SimulationCore(workerData || {});

if (!parentPort) {
    module.exports = SimulationCore;
} else {
parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const { type, requestId, payload } = msg;
    switch (type) {
        case 'init': {
            try {
                simulation.initializeEngine();
                simulation.response(requestId, {
                    seed: simulation.seed,
                    chunkSize: simulation.engine ? simulation.engine.chunkSize : null,
                    width: simulation.engine ? simulation.engine.width : null,
                    height: simulation.engine ? simulation.engine.height : null
                });
            } catch (error) {
                simulation.response(requestId, { error: error.message });
            }
            break;
        }
        case 'start': {
            simulation.startLoops();
            simulation.response(requestId, { ok: true });
            break;
        }
        case 'add_player': {
            const { playerId, selectedSpell } = payload || {};
            const result = simulation.addPlayer(playerId, selectedSpell);
            simulation.response(requestId, result);
            simulation.emit('broadcast', {
                exclude: playerId,
                message: {
                    type: 'player_joined',
                    playerId,
                    x: result.spawnX,
                    y: result.spawnY,
                    selectedSpell: selectedSpell
                }
            });
            break;
        }
        case 'remove_player': {
            const { playerId } = payload || {};
            simulation.removePlayer(playerId);
            simulation.response(requestId, { ok: true });
            simulation.emit('broadcast', {
                message: {
                    type: 'player_left',
                    playerId
                }
            });
            break;
        }
        case 'player_input': {
            const { playerId, input } = payload || {};
            simulation.handlePlayerInput(playerId, input || {});
            simulation.response(requestId, { ok: true });
            break;
        }
        case 'projectile': {
            const { playerId, message } = payload || {};
            simulation.handleProjectile(playerId, message || {});
            simulation.response(requestId, { ok: true });
            break;
        }
        case 'terrain_destroy': {
            const { playerId, message } = payload || {};
            simulation.handleTerrainDestruction(playerId, message || {});
            simulation.response(requestId, { ok: true });
            break;
        }
        case 'get_state': {
            const state = {
                tick: simulation.tick,
                players: Array.from(simulation.players.keys()),
                enginePlayers: simulation.engine ? simulation.engine.playerList.length : 0
            };
            simulation.response(requestId, state);
            break;
        }
        default:
            break;
    }
});
}
