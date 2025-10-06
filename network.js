/**
 * NetworkManager - Handles multiplayer synchronization
 * Uses deterministic lockstep for physics sync
 */

class NetworkManager {
    constructor(engine = null, options = {}) {
        this.engine = engine;
        this.options = options || {};
        this.engineReady = !!engine;
        this._invokedEngineReady = !!engine;

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

        this.localProjectiles = new Map();
        this.projectileSequence = 0;

        // Server reconciliation
        this.stateHistory = [];
        this.maxHistorySize = 60; // 1 second at 60fps

        // Connection diagnostics
        this.latency = 0;
        this.serverUrl = null;
        this.appliedTerrainMods = new Map();
    }

    attachEngine(engine) {
        this.engine = engine;
        this.engineReady = !!engine;
        if (!engine) {
            this._invokedEngineReady = false;
        } else {
            engine.network = this;
        }
    }

    connect(url) {
        this.serverUrl = url;
        console.log(`[NetworkManager] Attempting to connect to: ${url}`);

        try {
            this.socket = new WebSocket(url);

            this.socket.onopen = () => {
                console.log('[NetworkManager] ✅ Connected to server successfully');
                this.connected = true;
                if (typeof this.options.onConnected === 'function') {
                    this.options.onConnected();
                }
                this.send({ type: 'join' });
            };

            this.socket.onclose = (event) => {
                console.log(`[NetworkManager] Disconnected from server (code: ${event.code}, reason: ${event.reason || 'none'})`);
                this.connected = false;
                if (typeof this.options.onDisconnected === 'function') {
                    this.options.onDisconnected(event);
                }
            };

            this.socket.onerror = (error) => {
                console.error('[NetworkManager] ❌ WebSocket error:', error);
                console.error('[NetworkManager] URL attempted:', this.serverUrl);
                if (typeof this.options.onError === 'function') {
                    this.options.onError(error);
                }
            };

            this.socket.onmessage = (event) => {
                this.handleMessage(JSON.parse(event.data));
            };
        } catch (error) {
            console.error('[NetworkManager] ❌ Failed to create WebSocket:', error);
            throw error;
        }
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
                this.handleWelcome(msg);
                break;

            case 'state':
                this.handleStateUpdate(msg);
                break;

            case 'player_joined':
                if (!this.engineReady) break;
                if (msg.playerId !== this.playerId) {
                    this.engine.addPlayer(msg.playerId, msg.x, msg.y, msg.selectedSpell);
                }
                break;

            case 'player_left':
                if (this.engineReady) {
                    this.engine.removePlayer(msg.playerId);
                }
                break;

            case 'input_ack':
                this.handleInputAck(msg);
                break;

            case 'terrain_update':
                this.handleTerrainUpdate(msg);
                break;

            case 'sand_update':
                this.handleSandUpdate(msg);
                break;

            case 'projectile':
                if (!this.engineReady) break;
                this.handleProjectileMessage(msg);
                break;

            case 'terrain_snapshot':
                this.applyTerrainSnapshot(msg.snapshot);
                this.appliedTerrainMods.clear();
                break;

            case 'pong':
                if (msg.timestamp) {
                    this.latency = Math.max(0, Date.now() - msg.timestamp);
                    if (typeof this.options.onLatency === 'function') {
                        this.options.onLatency(this.latency);
                    }
                }
                break;
        }
    }

    ensureEngineFromWelcome(msg) {
        if (this.engineReady) return this.engine;
        if (typeof this.options.createEngine === 'function') {
            const engineInstance = this.options.createEngine(msg);
            if (engineInstance) {
                this.attachEngine(engineInstance);
            }
        }
        return this.engine;
    }

    handleWelcome(msg) {
        const engineInstance = this.ensureEngineFromWelcome(msg);
        if (!this.engineReady) {
            console.warn('[NetworkManager] No engine available to process welcome packet');
            return;
        }

        this.playerId = msg.playerId;
        this.engine.playerId = msg.playerId;
        this.currentTick = msg.tick;
        this.confirmedTick = msg.tick;
        this.engine.tick = msg.tick;
        if (typeof msg.seed === 'number') {
            this.engine.setSeed(msg.seed);
        }

        if (msg.terrainSnapshot) {
            this.applyTerrainSnapshot(msg.terrainSnapshot);
        }
        if (Array.isArray(msg.terrainMods)) {
            this.applyTerrainMods(msg.terrainMods);
        }
        if (msg.terrain && this.engine && this.engine.terrain && typeof this.engine.terrain.applyModifications === 'function') {
            this.engine.terrain.applyModifications(msg.terrain);
        }
        if (typeof msg.chunkSize === 'number' && msg.chunkSize > 0 && msg.chunkSize !== this.engine.chunkSize) {
            this.engine.chunkSize = msg.chunkSize;
            if (this.engine.terrain && typeof this.engine.terrain.setChunkSize === 'function') {
                this.engine.terrain.setChunkSize(msg.chunkSize);
            }
        }
        if (msg.sandChunks && typeof this.engine.loadSandChunks === 'function') {
            if (msg.sandChunks.full) {
                this.engine.loadSandChunks(msg.sandChunks);
            } else if (typeof this.engine.updateSandChunks === 'function') {
                this.engine.updateSandChunks(msg.sandChunks);
            } else {
                this.engine.loadSandChunks(msg.sandChunks);
            }
        }

        if (!this.engine.players.has(this.playerId)) {
            this.engine.addPlayer(this.playerId, msg.spawnX, msg.spawnY, msg.selectedSpell);
        } else {
            const player = this.engine.players.get(this.playerId);
            player.x = msg.spawnX;
            player.y = msg.spawnY;
            if (typeof player.normalizeSpellIndex === 'function') {
                player.selectedSpell = player.normalizeSpellIndex(msg.selectedSpell);
            } else {
                player.selectedSpell = msg.selectedSpell;
            }
        }

        if (this.engineReady && !this._invokedEngineReady && typeof this.options.onEngineReady === 'function') {
            this.options.onEngineReady(this.engine, msg);
            this._invokedEngineReady = true;
        }

        if (typeof this.options.onWelcome === 'function') {
            this.options.onWelcome(msg);
        }
    }

    handleStateUpdate(msg) {
        if (!this.engineReady) return;

        if (typeof msg.seed === 'number') {
            this.engine.setSeed(msg.seed);
        }

        if (typeof msg.chunkSize === 'number' && msg.chunkSize > 0 && msg.chunkSize !== this.engine.chunkSize) {
            this.engine.chunkSize = msg.chunkSize;
            if (this.engine.terrain && typeof this.engine.terrain.setChunkSize === 'function') {
                this.engine.terrain.setChunkSize(msg.chunkSize);
            }
        }

        if (msg.sandChunks && typeof this.engine.loadSandChunks === 'function') {
            if (msg.sandChunks.full) {
                this.engine.loadSandChunks(msg.sandChunks);
            } else if (typeof this.engine.updateSandChunks === 'function') {
                this.engine.updateSandChunks(msg.sandChunks);
            } else {
                this.engine.loadSandChunks(msg.sandChunks);
            }
        }

        if (msg.terrain && this.engine && this.engine.terrain && typeof this.engine.terrain.applyModifications === 'function') {
            this.engine.terrain.applyModifications(msg.terrain);
        }

        const serverTick = Number.isFinite(msg.tick) ? msg.tick : this.confirmedTick;
        this.confirmedTick = serverTick;
        if (Number.isFinite(serverTick)) {
            this.engine.tick = serverTick;
            this.currentTick = Math.max(this.currentTick, serverTick);
        }

        const playersData = Array.isArray(msg.players)
            ? msg.players.slice().sort((a, b) => a.id.localeCompare(b.id))
            : [];

        for (const pData of playersData) {
            if (pData.id === this.playerId) continue;
            let player = this.engine.players.get(pData.id);
            if (!player) {
                player = this.engine.addPlayer(pData.id, pData.x, pData.y, pData.selectedSpell);
            }
            if (!player) continue;

            player.x = pData.x;
            player.y = pData.y;
            player.vx = pData.vx;
            player.vy = pData.vy;
            player.health = pData.health;
            player.alive = pData.alive;
            player.aimAngle = pData.aimAngle;
            if (typeof player.normalizeSpellIndex === 'function') {
                player.selectedSpell = player.normalizeSpellIndex(pData.selectedSpell);
            } else {
                player.selectedSpell = pData.selectedSpell;
            }
            player.serverStateTime = Date.now();
        }

        if (this.playerId) {
            const serverPlayer = playersData.find(p => p.id === this.playerId);
            if (serverPlayer) {
                serverPlayer.tick = serverTick;
                this.reconcileState(serverPlayer);
            }
        }

        if (Array.isArray(msg.terrainMods) && this.engine) {
            this.applyTerrainMods(msg.terrainMods);
        }

        if (Array.isArray(msg.projectiles) && this.engine) {
            this.syncProjectiles(msg.projectiles);
        }
    }

    handleInputAck(msg) {
        this.pendingInputs = this.pendingInputs.filter(
            i => i.sequence > msg.sequence
        );
    }

    handleTerrainUpdate(msg) {
        if (!this.engineReady) return;
        console.log(`[DEBUG] Client received terrain_update: x=${msg.x}, y=${msg.y}, radius=${msg.radius}`);
        this.applyTerrainMods([msg]);
    }

    handleSandUpdate(msg) {
        if (!this.engineReady || !msg) return;
        console.log(`[DEBUG] Client received sand_update: ${msg.chunks?.length || 0} chunks, full=${msg.full}`);
        if (msg.full) {
            if (typeof this.engine.loadSandChunks === 'function') {
                this.engine.loadSandChunks(msg);
            }
            return;
        }

        if (typeof this.engine.updateSandChunks === 'function') {
            this.engine.updateSandChunks(msg);
        } else if (typeof this.engine.loadSandChunks === 'function') {
            this.engine.loadSandChunks(msg);
        }
    }

    handleProjectileMessage(msg) {
        if (!this.engineReady || !this.engine) return;

        const clientId = (typeof msg.clientProjectileId === 'string' && msg.clientProjectileId.length)
            ? msg.clientProjectileId
            : null;

        let projectile = null;
        if (clientId) {
            const entry = this.localProjectiles.get(clientId);
            if (entry) {
                projectile = entry.projectile || null;
                this.localProjectiles.delete(clientId);
            }
            if (!projectile && this.engine.projectiles && this.engine.projectiles.length) {
                projectile = this.engine.projectiles.find(p => p && p.clientProjectileId === clientId) || null;
            }
        }

        const normalizedX = typeof msg.x === 'number' ? msg.x : 0;
        const normalizedY = typeof msg.y === 'number' ? msg.y : 0;
        const normalizedVx = typeof msg.vx === 'number' ? msg.vx : 0;
        const normalizedVy = typeof msg.vy === 'number' ? msg.vy : 0;
        const type = typeof msg.type === 'string' ? msg.type : 'fireball';
        const ownerId = typeof msg.ownerId === 'string' ? msg.ownerId : null;

        if (!projectile) {
            projectile = this.engine.spawnProjectile(
                normalizedX,
                normalizedY,
                normalizedVx,
                normalizedVy,
                type,
                ownerId,
                {
                    clientProjectileId: clientId,
                    pending: false
                }
            );
        } else {
            projectile.x = wrapHorizontal(normalizedX, this.engine.width);
            projectile.y = normalizedY;
            projectile.vx = normalizedVx;
            projectile.vy = normalizedVy;
            projectile.ownerId = ownerId;
            projectile.type = type;
            projectile.clientProjectileId = clientId;
            if (typeof msg.lifetime === 'number') {
                projectile.lifetime = msg.lifetime;
            }
        }

        if (projectile && typeof msg.lifetime === 'number') {
            projectile.lifetime = msg.lifetime;
        }

        if (projectile) {
            projectile.pending = false;
        }
    }

    pruneTerrainHistory() {
        while (this.appliedTerrainMods.size > 512) {
            const first = this.appliedTerrainMods.keys().next();
            if (first.done) break;
            this.appliedTerrainMods.delete(first.value);
        }
    }

    applyTerrainMods(mods) {
        if (!Array.isArray(mods) || !this.engine) return;
        const sortedMods = mods.slice().sort((a, b) => {
            const ta = typeof a.tick === 'number' ? a.tick : this.confirmedTick;
            const tb = typeof b.tick === 'number' ? b.tick : this.confirmedTick;
            if (ta !== tb) return ta - tb;
            const keyA = `${a.x}:${a.y}:${a.radius}:${a.explosive ? 1 : 0}`;
            const keyB = `${b.x}:${b.y}:${b.radius}:${b.explosive ? 1 : 0}`;
            return keyA.localeCompare(keyB);
        });

        const SENTINEL_TICK = Number.MAX_SAFE_INTEGER;

        for (const mod of sortedMods) {
            const key = `${mod.x}:${mod.y}:${mod.radius}:${mod.explosive ? 1 : 0}`;
            const newTick = Number.isFinite(mod.tick) ? mod.tick : this.confirmedTick;
            const previousTick = this.appliedTerrainMods.get(key);

            if (previousTick === SENTINEL_TICK) {
                this.appliedTerrainMods.set(key, newTick);
                this.pruneTerrainHistory();
                continue;
            }

            if (previousTick !== undefined && newTick <= previousTick) {
                continue;
            }

            this.appliedTerrainMods.set(key, newTick);
            this.pruneTerrainHistory();
            this.engine.destroyTerrain(mod.x, mod.y, mod.radius, mod.explosive, false);
        }
    }

    syncProjectiles(projectiles) {
        if (!Array.isArray(projectiles) || !this.engine) return;
        const synchronized = [];
        for (const data of projectiles) {
            if (!data) continue;
            const type = data.type || 'fireball';
            const ownerId = data.ownerId;
            const clientId = (typeof data.clientProjectileId === 'string' && data.clientProjectileId.length)
                ? data.clientProjectileId
                : null;
            const wrappedX = typeof wrapHorizontal === 'function'
                ? wrapHorizontal(data.x ?? 0, this.engine.width)
                : (data.x ?? 0);
            const proj = new Projectile(
                wrappedX,
                data.y ?? 0,
                data.vx ?? 0,
                data.vy ?? 0,
                type,
                ownerId
            );
            if (typeof data.lifetime === 'number') {
                proj.lifetime = data.lifetime;
            }
            if (clientId) {
                proj.clientProjectileId = clientId;
                proj.pending = false;
                this.localProjectiles.delete(clientId);
            }
            synchronized.push(proj);
        }
        this.engine.projectiles = synchronized;
    }

    applyTerrainSnapshot(snapshot) {
        if (!this.engineReady || !snapshot) return;
        this.engine.loadTerrainSnapshot(snapshot);
        this.appliedTerrainMods.clear();
        if (typeof this.options.onTerrainSnapshot === 'function') {
            this.options.onTerrainSnapshot(snapshot);
        }
    }

    sendInput(input) {
        if (!this.connected || !this.playerId || !this.engineReady) return;

        const tick = (this.engine && typeof this.engine.tick === 'number')
            ? this.engine.tick
            : this.currentTick;

        const sequence = this.inputSequence++;
        const dt = this.engine && Number.isFinite(this.engine.fixedTimeStep)
            ? this.engine.fixedTimeStep
            : (1000 / 60);

        const transmit = {
            sequence,
            tick,
            left: !!input.left,
            right: !!input.right,
            jump: !!input.jump,
            shoot: !!input.shoot,
            mouseX: typeof input.mouseX === 'number' ? input.mouseX : 0,
            mouseY: typeof input.mouseY === 'number' ? input.mouseY : 0
        };

        this.currentTick = Math.max(this.currentTick, tick);

        this.pendingInputs.push({ ...transmit, dt });

        this.send({ type: 'input', input: transmit });
    }

    recordLocalState(tick, player) {
        if (!this.engineReady || !player || !Number.isFinite(tick)) return;

        this.currentTick = Math.max(this.currentTick, tick);

        const snapshot = {
            tick,
            x: player.x,
            y: player.y,
            vx: player.vx,
            vy: player.vy,
            aimAngle: player.aimAngle
        };

        const history = this.stateHistory;
        const last = history[history.length - 1];
        if (last && last.tick === tick) {
            history[history.length - 1] = snapshot;
            return;
        }

        history.push(snapshot);
        if (history.length > this.maxHistorySize) {
            history.splice(0, history.length - this.maxHistorySize);
        }
    }

    applyInput(player, input) {
        if (!player) return;
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
        const localId = proj && proj.clientProjectileId
            ? String(proj.clientProjectileId)
            : `${this.playerId || 'local'}:${this.projectileSequence++}`;

        if (proj) {
            proj.clientProjectileId = localId;
            proj.pending = true;
        }

        this.localProjectiles.set(localId, {
            id: localId,
            projectile: proj || null,
            type: proj ? proj.type : null,
            ownerId: proj ? proj.ownerId : this.playerId,
            spawnTick: this.currentTick,
            pending: true
        });

        this.send({
            type: 'projectile',
            x: proj.x,
            y: proj.y,
            vx: proj.vx,
            vy: proj.vy,
            type: proj.type,
            ownerId: proj.ownerId,
            clientProjectileId: localId
        });
    }

    sendTerrainDestruction(x, y, radius, explosive) {
        if (!this.connected) return;
        if (this.engineReady) {
            const key = `${x}:${y}:${radius}:${explosive ? 1 : 0}`;
            this.appliedTerrainMods.set(key, Number.MAX_SAFE_INTEGER);
            this.pruneTerrainHistory();
        }
        this.send({
            type: 'terrain_destroy',
            x,
            y,
            radius,
            explosive
        });
    }

    update() {
        this.currentTick++;
        this.pruneLocalProjectiles();
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

    interpolateRemotePlayers() {
        // State is streamed directly from the server; no client-side interpolation required.
    }

    pruneLocalProjectiles() {
        if (!this.localProjectiles || this.localProjectiles.size === 0) return;
        for (const [id, entry] of this.localProjectiles.entries()) {
            const proj = entry && entry.projectile;
            if (!proj || proj.dead) {
                this.localProjectiles.delete(id);
            }
        }
    }

    reconcileState(serverState) {
        if (!this.engineReady) return;
        const engine = this.engine;
        const localPlayer = engine && engine.players ? engine.players.get(this.playerId) : null;
        if (!localPlayer) return;

        const serverTick = Number.isFinite(serverState.tick) ? serverState.tick : this.confirmedTick;
        const effectiveTick = Number.isFinite(serverTick) ? serverTick : this.currentTick;
        if (Number.isFinite(effectiveTick)) {
            this.currentTick = Math.max(this.currentTick, effectiveTick);
        }

        const lastProcessedSequence = Number.isFinite(serverState.lastProcessedInput)
            ? serverState.lastProcessedInput
            : null;
        if (lastProcessedSequence !== null) {
            this.pendingInputs = this.pendingInputs.filter(input => input.sequence > lastProcessedSequence);
        }

        if (typeof serverState.health === 'number') {
            localPlayer.health = serverState.health;
        }
        if (typeof serverState.alive === 'boolean') {
            localPlayer.alive = serverState.alive;
        }

        const resolvedSpell = (typeof serverState.selectedSpell !== 'undefined')
            ? serverState.selectedSpell
            : localPlayer.selectedSpell;
        if (typeof localPlayer.normalizeSpellIndex === 'function') {
            localPlayer.selectedSpell = localPlayer.normalizeSpellIndex(resolvedSpell);
        } else {
            localPlayer.selectedSpell = resolvedSpell;
        }

        const aimAngle = typeof serverState.aimAngle === 'number'
            ? this.normalizeAngle(serverState.aimAngle)
            : localPlayer.aimAngle;

        localPlayer.x = Number.isFinite(serverState.x) ? serverState.x : localPlayer.x;
        localPlayer.y = Number.isFinite(serverState.y) ? serverState.y : localPlayer.y;
        localPlayer.vx = Number.isFinite(serverState.vx) ? serverState.vx : localPlayer.vx;
        localPlayer.vy = Number.isFinite(serverState.vy) ? serverState.vy : localPlayer.vy;
        localPlayer.aimAngle = aimAngle;
        localPlayer.serverStateTime = Date.now();

        const baseSnapshot = {
            tick: effectiveTick,
            x: localPlayer.x,
            y: localPlayer.y,
            vx: localPlayer.vx,
            vy: localPlayer.vy,
            aimAngle: localPlayer.aimAngle
        };

        const replay = this.replayPendingInputs(localPlayer, serverState, effectiveTick);
        const historyEntries = [baseSnapshot];

        if (replay && replay.player) {
            const simPlayer = replay.player;
            localPlayer.x = simPlayer.x;
            localPlayer.y = simPlayer.y;
            localPlayer.vx = simPlayer.vx;
            localPlayer.vy = simPlayer.vy;
            localPlayer.aimAngle = this.normalizeAngle(simPlayer.aimAngle);
            localPlayer.cooldown = simPlayer.cooldown;

            if (Array.isArray(replay.history) && replay.history.length) {
                for (const entry of replay.history) {
                    historyEntries.push({
                        tick: entry.tick,
                        x: entry.x,
                        y: entry.y,
                        vx: entry.vx,
                        vy: entry.vy,
                        aimAngle: this.normalizeAngle(entry.aimAngle)
                    });
                }
                const lastEntry = replay.history[replay.history.length - 1];
                if (lastEntry && Number.isFinite(lastEntry.tick)) {
                    this.currentTick = Math.max(this.currentTick, lastEntry.tick);
                }
            }
        }

        if (historyEntries.length > this.maxHistorySize) {
            historyEntries.splice(0, historyEntries.length - this.maxHistorySize);
        }
        this.stateHistory = historyEntries;

        if (!this.pendingInputs.length && Number.isFinite(effectiveTick)) {
            this.currentTick = Math.max(this.currentTick, effectiveTick);
        }
    }

    replayPendingInputs(localPlayer, serverState, startTick) {
        if (!this.engineReady || !localPlayer || !Array.isArray(this.pendingInputs) || this.pendingInputs.length === 0) {
            return null;
        }

        if (typeof Player !== 'function') {
            return null;
        }

        const engine = this.engine;
        const baseSpell = typeof serverState.selectedSpell === 'number'
            ? serverState.selectedSpell
            : localPlayer.selectedSpell;
        const normalizedSpell = (typeof localPlayer.normalizeSpellIndex === 'function')
            ? localPlayer.normalizeSpellIndex(baseSpell)
            : baseSpell;

        const simPlayer = new Player(localPlayer.id, serverState.x ?? localPlayer.x, serverState.y ?? localPlayer.y, normalizedSpell, localPlayer.random);
        simPlayer.random = localPlayer.random;
        simPlayer.deserialize({
            id: localPlayer.id,
            x: Number.isFinite(serverState.x) ? serverState.x : localPlayer.x,
            y: Number.isFinite(serverState.y) ? serverState.y : localPlayer.y,
            vx: Number.isFinite(serverState.vx) ? serverState.vx : localPlayer.vx,
            vy: Number.isFinite(serverState.vy) ? serverState.vy : localPlayer.vy,
            aimAngle: typeof serverState.aimAngle === 'number' ? serverState.aimAngle : localPlayer.aimAngle,
            health: typeof serverState.health === 'number' ? serverState.health : localPlayer.health,
            alive: typeof serverState.alive === 'boolean' ? serverState.alive : localPlayer.alive,
            selectedSpell: normalizedSpell
        });
        simPlayer.health = typeof serverState.health === 'number' ? serverState.health : localPlayer.health;
        simPlayer.alive = typeof serverState.alive === 'boolean' ? serverState.alive : localPlayer.alive;
        simPlayer.cooldown = localPlayer.cooldown;
        simPlayer.input = { ...localPlayer.input };

        const dtDefault = engine && Number.isFinite(engine.fixedTimeStep)
            ? engine.fixedTimeStep
            : (1000 / 60);

        const originalSpawnProjectile = engine && typeof engine.spawnProjectile === 'function'
            ? engine.spawnProjectile
            : null;
        const originalSpawnParticles = engine && typeof engine.spawnParticles === 'function'
            ? engine.spawnParticles
            : null;

        if (engine && originalSpawnProjectile) {
            engine.spawnProjectile = () => {};
        }
        if (engine && originalSpawnParticles) {
            engine.spawnParticles = () => {};
        }

        const history = [];
        let simTick = Number.isFinite(startTick) ? startTick : (engine ? engine.tick : 0);

        try {
            for (const pending of this.pendingInputs) {
                if (!pending) continue;
                const dt = Number.isFinite(pending.dt) ? pending.dt : dtDefault;
                this.applyInput(simPlayer, pending);
                simPlayer.update(dt, engine);
                simTick = Number.isFinite(pending.tick) ? pending.tick : (simTick + 1);
                history.push({
                    tick: simTick,
                    x: simPlayer.x,
                    y: simPlayer.y,
                    vx: simPlayer.vx,
                    vy: simPlayer.vy,
                    aimAngle: simPlayer.aimAngle
                });
            }
        } finally {
            if (engine && originalSpawnProjectile) {
                engine.spawnProjectile = originalSpawnProjectile;
            }
            if (engine && originalSpawnParticles) {
                engine.spawnParticles = originalSpawnParticles;
            }
        }

        return {
            player: simPlayer,
            history
        };
    }

    normalizeAngle(angle) {
        if (!Number.isFinite(angle)) return 0;
        const twoPi = Math.PI * 2;
        let normalized = angle % twoPi;
        if (normalized > Math.PI) {
            normalized -= twoPi;
        } else if (normalized < -Math.PI) {
            normalized += twoPi;
        }
        return normalized;
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
                players: Array.from(this.players.values())
            });
        }, 1000 / 20);
    }
    
    broadcast(message) {
        console.warn('MockServer.broadcast not implemented in this mock', message);
    }
}

if (typeof window !== 'undefined') {
    window.NetworkManager = NetworkManager;
    window.MockServer = MockServer;
}
