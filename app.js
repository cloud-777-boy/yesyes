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
        this.terrainSnapshotTick = 0;
        this.terrainChunkHistory = [];
        this.maxTerrainChunkHistory = 4096;
        this.pendingTerrainChunkDiffs = [];
        this.maxTerrainChunkBroadcast = 128;
        this.terrainChunkDiffCounter = 0;
        this.playerCounter = 0;
        this.projectileCounter = 0;
        this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
        this.random = DeterministicRandom ? new DeterministicRandom(this.seed) : null;
        this.engine = null;

        this.tickRate = 60;
        this.stateUpdateRate = 20;
        
        // Sand update throttling with spatial filtering
        this.sandUpdateRate = 20; // Increased to 20Hz since we only send nearby chunks
        this.sandChunkRadius = 0; // Radius recalculated once engine is initialized
        this.lastSandUpdateTime = 0;
        this.hasPendingSandUpdate = false;

        // Targeted chunk resynchronization
        this.chunkSyncRadius = 1; // Stream player chunk plus immediate neighbours
        this.playerActiveChunks = new Map();
        this.pendingChunkResync = new Map();
        this.chunkSubscribers = new Map();
        this.chunkVersions = new Map();
        this.playerChunkVersions = new Map();
        this.maxChunkSyncPerTick = 4;

        this.startTime = Date.now();
        this.totalMessages = 0;

        this.initializeEngine();
        this.setupServer();
        this.startGameLoop();
    }
    
    initializeEngine() {
        console.log(`[${new Date().toISOString()}] Generating server terrain with seed: ${this.seed}`);
        this.engine = new GameEngine(null, true, { seed: this.seed });

        const serverComputeRadius = 1;
        const serverBufferRadius = 1;
        this.engine.playerChunkComputeRadius = serverComputeRadius;
        this.engine.playerChunkBufferRadius = serverBufferRadius;
        this.engine.sandChunkBroadcastRadius = Math.max(1, serverComputeRadius + serverBufferRadius);

        this.engine.init();
        this.sandChunkRadius = Math.max(1, serverComputeRadius + serverBufferRadius);
        this.engine.onProjectileSpawn = (projectile) => this.handleServerProjectileSpawn(projectile);
        this.engine.onTerrainDestruction = ({ x, y, radius, explosive, broadcast }) => {
            if (broadcast === false) return;
            this.recordAndBroadcastTerrainModification(x, y, radius, explosive);
        };
        // IMMEDIATE REAL-TIME SAND BROADCAST - NO THROTTLING
        this.engine.onSandUpdate = (payload) => {
            if (payload && payload.chunks && payload.chunks.length > 0) {
                const keys = payload.chunks
                    .map((chunk) => (chunk && typeof chunk.key === 'string') ? chunk.key : null)
                    .filter((key) => key);
                if (keys.length) {
                    this.queueChunkResyncForKeys(keys, true);
                }
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
        this.terrainSnapshotTick = this.tick;
        const pixelLength = this.terrainSnapshot && this.terrainSnapshot.pixels
            ? this.terrainSnapshot.pixels.length
            : 0;
        console.log(`[${new Date().toISOString()}] Server terrain generated successfully (${pixelLength} chars base64)`);
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

        const terrainUpdate = {
            type: 'terrain_update',
            x,
            y,
            radius,
            explosive,
            tick: mod.tick
        };
        this.broadcast(terrainUpdate);

        const diff = this.captureTerrainChunkDiff(mod.tick);
        if (diff && Array.isArray(diff.chunks) && diff.chunks.length) {
            const diffPayload = {
                type: 'terrain_chunk_update',
                chunkDiff: diff
            };
            this.broadcast(diffPayload);

            const keys = diff.chunks
                .map((chunk) => (chunk && typeof chunk.key === 'string') ? chunk.key : null)
                .filter((key) => key);
            if (keys.length) {
                const terrainSnapshot = this.engine.serializeTerrainChunksForKeys(keys);
                if (terrainSnapshot && Array.isArray(terrainSnapshot.chunks) && terrainSnapshot.chunks.length > 0) {
                    this.broadcast({
                        type: 'chunk_sync',
                        terrain: terrainSnapshot
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

    ensurePlayerVersionMap(playerId) {
        let versionMap = this.playerChunkVersions.get(playerId);
        if (!versionMap) {
            versionMap = new Map();
            this.playerChunkVersions.set(playerId, versionMap);
        }
        return versionMap;
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

    markChunkVersion(key, bumpVersion) {
        const current = this.chunkVersions.get(key) || 0;
        if (bumpVersion) {
            this.chunkVersions.set(key, current > 0 ? current + 1 : 1);
        } else if (!this.chunkVersions.has(key)) {
            this.chunkVersions.set(key, 1);
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
            const chunkY = centerChunkY + dy;
            if (chunkY < 0 || chunkY >= totalChunksY) continue;
            for (let dx = -radius; dx <= radius; dx++) {
                let chunkX = centerChunkX + dx;
                chunkX = ((chunkX % totalChunksX) + totalChunksX) % totalChunksX;
                keys.add(`${chunkX}|${chunkY}`);
            }
        }

        return keys;
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

            const terrainSnapshot = this.engine.serializeTerrainChunksForKeys(keysToSend);
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

                this.sendToPlayer(playerId, payload);
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

            const welcomePayload = {
                type: 'welcome',
                playerId,
                tick: this.tick,
                spawnX: enginePlayer ? enginePlayer.x : spawnX,
                spawnY: enginePlayer ? enginePlayer.y : spawnY,
                selectedSpell: player.selectedSpell,
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
            welcomePayload.terrainMods = modsForWelcome;
            const terrainChunkDiffs = this.getTerrainChunkHistorySnapshot();
            if (terrainChunkDiffs && terrainChunkDiffs.length > 0) {
                welcomePayload.terrainChunkDiffs = terrainChunkDiffs;
            }
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

                const activeChunks = this.playerActiveChunks.get(playerId);
                if (activeChunks && activeChunks.size) {
                    for (const key of activeChunks) {
                        this.unsubscribePlayerFromChunk(key, playerId);
                    }
                }
                this.playerActiveChunks.delete(playerId);
                this.pendingChunkResync.delete(playerId);
                this.playerChunkVersions.delete(playerId);

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
            if (!projectile.serverId) {
                projectile.serverId = this.generateProjectileId();
            }
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
            type: 'state',
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

        // Sand updates are now handled separately with throttling
        // to prevent memory leaks

        this.broadcast(state);

        this.flushPendingChunkResyncs();

        if (this.terrainModifications.length > this.maxTerrainModHistory) {
            this.terrainModifications = this.terrainModifications.slice(-this.maxTerrainModHistory);
        }
    }

    generateProjectileId() {
        this.projectileCounter = (this.projectileCounter + 1) >>> 0;
        const suffix = this.projectileCounter.toString(36).padStart(4, '0');
        return `proj-${Date.now().toString(36)}-${suffix}`;
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
                const keys = sandUpdate.chunks
                    .map((chunk) => (chunk && typeof chunk.key === 'string') ? chunk.key : null)
                    .filter((key) => key);
                if (keys.length) {
                    this.queueChunkResyncForKeys(keys, true);
                }
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
