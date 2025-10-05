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

            case 'projectile':
                if (!this.engineReady) break;
                this.engine.spawnProjectile(
                    msg.x, msg.y, msg.vx, msg.vy, msg.type, msg.ownerId
                );
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
        this.applyTerrainMods([msg]);
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

        input.sequence = this.inputSequence++;
        input.tick = tick;

        this.currentTick = Math.max(this.currentTick, tick);

        this.pendingInputs.push({ ...input });

        this.send({ type: 'input', input });
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

        const history = this.stateHistory;
        let predictedState = null;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].tick === effectiveTick) {
                predictedState = history[i];
                break;
            }
        }

        const worldWidth = engine && Number.isFinite(engine.width) ? engine.width : null;
        const dx = (typeof shortestWrappedDelta === 'function' && worldWidth)
            ? shortestWrappedDelta(serverState.x, localPlayer.x, worldWidth)
            : (serverState.x - localPlayer.x);
        const dy = serverState.y - localPlayer.y;
        const distanceSq = dx * dx + dy * dy;
        const catastrophicThresholdSq = 250000; // ~500px error: treat as teleport and snap

        let correctedX = localPlayer.x;
        let correctedY = localPlayer.y;
        let correctedVx = localPlayer.vx;
        let correctedVy = localPlayer.vy;

        if (distanceSq > catastrophicThresholdSq) {
            correctedX = serverState.x;
            correctedY = serverState.y;
            correctedVx = serverState.vx;
            correctedVy = serverState.vy;
        } else {
            const distance = Math.sqrt(distanceSq);
            const baseFactor = 0.18;
            const latencyFactor = Math.min(0.3, (this.latency || 0) / 600);
            const pendingFactor = Math.min(0.25, this.pendingInputs.length * 0.04);
            const predictionMissFactor = predictedState
                ? Math.min(0.2, Math.abs(predictedState.y - serverState.y) / 200)
                : 0;
            const distanceCatchup = Math.min(0.35, distance / 480);
            const alpha = Math.min(
                0.75,
                Math.max(0.1, baseFactor + latencyFactor + pendingFactor + predictionMissFactor + distanceCatchup)
            );

            if (distance > 0.01) {
                correctedX = localPlayer.x + dx * alpha;
                correctedY = localPlayer.y + dy * alpha;
            } else {
                correctedX = serverState.x;
                correctedY = serverState.y;
            }

            correctedVx = localPlayer.vx + (serverState.vx - localPlayer.vx) * alpha;
            correctedVy = localPlayer.vy + (serverState.vy - localPlayer.vy) * alpha;
        }

        if (worldWidth && typeof wrapHorizontal === 'function') {
            correctedX = wrapHorizontal(correctedX, worldWidth);
        }

        localPlayer.x = correctedX;
        localPlayer.y = correctedY;
        localPlayer.vx = correctedVx;
        localPlayer.vy = correctedVy;

        if (typeof serverState.health === 'number') {
            localPlayer.health = serverState.health;
        }
        if (typeof serverState.alive === 'boolean') {
            localPlayer.alive = serverState.alive;
        }
        if (typeof serverState.selectedSpell !== 'undefined') {
            localPlayer.selectedSpell = (typeof localPlayer.normalizeSpellIndex === 'function')
                ? localPlayer.normalizeSpellIndex(serverState.selectedSpell)
                : serverState.selectedSpell;
        }

        if (typeof serverState.aimAngle === 'number') {
            localPlayer.aimAngle = this.lerpAngle(localPlayer.aimAngle, serverState.aimAngle, 0.25);
        }

        const baseX = Number.isFinite(predictedState?.x)
            ? predictedState.x
            : Number.isFinite(serverState.x) ? serverState.x : correctedX;
        const baseY = Number.isFinite(predictedState?.y)
            ? predictedState.y
            : Number.isFinite(serverState.y) ? serverState.y : correctedY;
        const baseVx = Number.isFinite(predictedState?.vx)
            ? predictedState.vx
            : Number.isFinite(serverState.vx) ? serverState.vx : correctedVx;
        const baseVy = Number.isFinite(predictedState?.vy)
            ? predictedState.vy
            : Number.isFinite(serverState.vy) ? serverState.vy : correctedVy;

        const clampDelta = (value, limit) => {
            if (!Number.isFinite(value)) return 0;
            return Math.max(-limit, Math.min(limit, value));
        };

        const deltaX = clampDelta(correctedX - baseX, 96);
        const deltaY = clampDelta(correctedY - baseY, 96);
        const deltaVx = clampDelta(correctedVx - baseVx, 12);
        const deltaVy = clampDelta(correctedVy - baseVy, 12);

        const reconciledSnapshot = {
            tick: effectiveTick,
            x: correctedX,
            y: correctedY,
            vx: correctedVx,
            vy: correctedVy,
            aimAngle: localPlayer.aimAngle
        };

        const futureHistory = [];
        for (let i = 0; i < history.length; i++) {
            const entry = history[i];
            if (!entry || !Number.isFinite(entry.tick)) continue;
            if (Number.isFinite(effectiveTick) && entry.tick <= effectiveTick) continue;
            futureHistory.push({
                tick: entry.tick,
                x: (Number.isFinite(entry.x) ? entry.x : correctedX) + deltaX,
                y: (Number.isFinite(entry.y) ? entry.y : correctedY) + deltaY,
                vx: (Number.isFinite(entry.vx) ? entry.vx : correctedVx) + deltaVx,
                vy: (Number.isFinite(entry.vy) ? entry.vy : correctedVy) + deltaVy,
                aimAngle: Number.isFinite(entry.aimAngle)
                    ? this.normalizeAngle(entry.aimAngle)
                    : localPlayer.aimAngle
            });
        }

        const newHistory = [reconciledSnapshot, ...futureHistory].slice(0, this.maxHistorySize);
        this.stateHistory = newHistory;

        let latestPrediction = null;
        for (let i = newHistory.length - 1; i >= 0; i--) {
            const entry = newHistory[i];
            if (!entry || !Number.isFinite(entry.tick)) continue;
            if (!Number.isFinite(effectiveTick) || entry.tick > effectiveTick) {
                latestPrediction = entry;
                break;
            }
        }

        if (latestPrediction) {
            localPlayer.x = latestPrediction.x;
            localPlayer.y = latestPrediction.y;
            localPlayer.vx = latestPrediction.vx;
            localPlayer.vy = latestPrediction.vy;
            if (Number.isFinite(latestPrediction.aimAngle)) {
                localPlayer.aimAngle = this.normalizeAngle(latestPrediction.aimAngle);
            }
        }

        if (Number.isFinite(effectiveTick)) {
            this.pendingInputs = this.pendingInputs.filter(input => input && Number.isFinite(input.tick) && input.tick > effectiveTick);
        }
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

    lerpAngle(current, target, alpha) {
        if (!Number.isFinite(target)) return current;
        if (!Number.isFinite(current)) return this.normalizeAngle(target);
        const clampedAlpha = Math.max(0, Math.min(1, alpha));
        const start = this.normalizeAngle(current);
        const end = this.normalizeAngle(target);
        let delta = end - start;
        if (delta > Math.PI) {
            delta -= Math.PI * 2;
        } else if (delta < -Math.PI) {
            delta += Math.PI * 2;
        }
        return this.normalizeAngle(start + delta * clampedAlpha);
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
