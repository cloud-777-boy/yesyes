/**
 * Pixel Physics Engine - Main Engine
 * Optimized for 64-player multiplayer with deterministic physics
 */

class GameEngine {
    constructor(canvas, isServer = false, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null;
        this.isServer = isServer;
        const seed = (options && typeof options.seed === 'number')
            ? options.seed >>> 0
            : 0x1f2e3d4c;
        this.seed = seed;
        const fallbackRandom = {
            nextFloat: () => Math.random(),
            nextInt: (max) => Math.floor(Math.random() * max),
            nextBool: () => Math.random() < 0.5,
            nextRange: (min, max) => min + Math.random() * (max - min),
            fork: () => fallbackRandom
        };
        this.random = typeof DeterministicRandom === 'function'
            ? new DeterministicRandom(this.seed)
            : fallbackRandom;

        const configuredWidth = options && Number.isFinite(options.width) ? Math.floor(options.width) : null;
        const configuredHeight = options && Number.isFinite(options.height) ? Math.floor(options.height) : null;

        // Core systems
        this.width = configuredWidth && configuredWidth > 0 ? configuredWidth : 11200;
        this.height = configuredHeight && configuredHeight > 0 ? configuredHeight : 900;
        this.pixelSize = 6; // Render scale (zoomed-in view)
        
        this.terrain = null;
        this.chunkSize = 64;
        this.sandChunks = new Map();
        this.dirtySandChunkKeys = new Set();
        this.sandParticleCount = 0;
        this.sandPool = [];
        this.sandOccupancy = new Set();
        this.sandOccupancyMap = new Map();
        this.activeChunkSet = new Set();
        this.activeChunkKeys = [];
        this.activeSandLists = [];
        this.activeSandChunkKeys = [];
        this.activeSandLookup = [];
        this.activeSandChunkPriority = new Map();
        this.absoluteSandCap = 10000;
        this.baseSandCapacity = this.absoluteSandCap;
        this.maxSandParticles = this.baseSandCapacity;
        this.sandPoolLimit = this.absoluteSandCap;
        this.maxSandUpdatesPerFrame = isServer ? 450 : 900;
        this.maxSandSpawnPerDestroy = isServer ? 250 : 500;
        this.sandAdaptiveCursor = 0;
        this.sandChunkBroadcastRadius = 6;
        this.players = new Map();
        this.playerList = [];
        this.projectiles = [];
        this.particles = [];
        this.inputManager = null;
        this.onSandUpdate = null;
        this.playerChunkComputeRadius = 1;
        this.playerChunkBufferRadius = 2;
        this.projectileChunkRadius = 1;
        this.maxComputedSandPriority = 1;
        this.network = null;
        this.serverStats = {
            players: 0,
            sand: 0,
            projectiles: 0,
            tick: 0,
            chunk: null,
            lastTerrainUpdate: null,
            lastSandUpdate: null
        };
        this.chunkSyncStatus = new Map();
        // Adaptive sand scheduling keeps multiplayer deterministic while throttling
        // interior blob updates. Intervals are tuned so edge particles update every
        // frame, shell layers follow shortly after, and dense cores are revisited
        // infrequently to minimize cost without breaking bulk motion.
        this.sandBlobConfig = {
            solidIntervals: [1, 3, 8],
            liquidIntervals: [1, 2, 5],
            solidRestBoost: [1, 1, 1.5],
            liquidRestBoost: [1, 1, 1.2],
            liquidBlobMin: 24,
            liquidBlobBulkThreshold: 0.4,
            liquidBlobInterval: 16,
            liquidBlobPressure: 0.045
        };
        this.liquidBlobCache = new Map();
        this.nextLiquidBlobId = 1;
        this.eigenSand = typeof EigenSandManager === 'function'
            ? new EigenSandManager(this)
            : null;
        this.terrainChunkRemapCache = new Map();
        this.activeTerrainChunkCache = {
            tick: -1,
            chunkSize: 0,
            keys: null
        };

        // Physics settings (deterministic)
        this.gravity = 0.3;
        this.fixedTimeStep = 1000 / 60; // 60 FPS fixed timestep
        this.accumulator = 0;
        this.lastTime = 0;
        this.maxSubSteps = 5;
        this.maxDelta = this.fixedTimeStep * this.maxSubSteps;

        // Multiplayer
        this.tick = 0;
        this.playerId = null;

        // Performance
        this.sandViewRadiusMultiplier = 2.5;
        const baseViewWidth = canvas ? Math.max(1, Math.floor(canvas.width / this.pixelSize)) : 800;
        const baseViewHeight = canvas ? Math.max(1, Math.floor(canvas.height / this.pixelSize)) : 600;
        this.defaultViewWidth = baseViewWidth;
        this.defaultViewHeight = baseViewHeight;
        this.particlePool = [];
        this.pendingFluidChunks = new Map();
        this.pendingFluidCount = 0;
        this.maxFluidSpawnPerTick = isServer ? 120 : 360;
        this.maxFluidSpawnPerChunk = isServer ? 36 : 120;
        this.lastFluidSpawnTick = -1;

        // Camera
        this.cameraX = 0;
        this.cameraY = 0;
        
        this.running = false;
        this._boundLoop = this.loop.bind(this);
    }
    
    init(skipTerrainGeneration = false) {
        // Initialize terrain
        console.log(`[Engine] init() called, skipTerrainGeneration=${skipTerrainGeneration}`);
        const terrainRng = this.random && typeof this.random.fork === 'function'
            ? this.random.fork('terrain')
            : null;
        this.terrain = new Terrain(this.width, this.height, terrainRng);
        if (!skipTerrainGeneration) {
            console.log('[Engine] Generating terrain locally...');
            this.terrain.generate();
        } else {
            console.log('[Engine] Skipping local terrain generation (will load from server)');
            // Initialize terrain state even when skipping generation
            this.terrain.dirty = true;
            this.terrain.fullRedrawNeeded = true;
            this.terrain.dirtyBounds = {
                minX: 0,
                minY: 0,
                maxX: this.terrain.width - 1,
                maxY: this.terrain.height - 1
            };
        }
        this.sandChunks.clear();
        this.dirtySandChunkKeys.clear();
        this.sandParticleCount = 0;
        this.sandAdaptiveCursor = 0;
        this.sandPool.length = 0;
        this.activeChunkSet.clear();
        this.activeChunkKeys.length = 0;
        this.activeSandLists.length = 0;
        this.activeSandChunkKeys.length = 0;
        this.activeSandLookup.length = 0;
        this.activeSandChunkPriority.clear();
        this.sandOccupancy.clear();
        this.pendingFluidChunks.clear();
        this.pendingFluidCount = 0;
        this.lastFluidSpawnTick = -1;
        this.liquidBlobCache.clear();
        this.nextLiquidBlobId = 1;
        if (this.terrainChunkRemapCache) {
            this.terrainChunkRemapCache.clear();
        }
        if (this.activeTerrainChunkCache) {
            this.activeTerrainChunkCache.tick = -1;
            this.activeTerrainChunkCache.chunkSize = 0;
            this.activeTerrainChunkCache.keys = null;
        }
        if (this.eigenSand) {
            this.eigenSand.reset();
        }

        // Only spawn initial fluids if we generated terrain locally
        // If skipping generation, fluids will be spawned after loading snapshot
        if (!skipTerrainGeneration) {
            const fluids = this.terrain.consumeInitialFluids();
            this.spawnInitialFluids(fluids);
        }

        // Setup camera
        this.cameraX = this.width / 2;
        this.cameraY = this.height / 2;

        const { width, height } = this.getViewDimensions();
        this.updateActiveChunks(width, height);
        if (this.eigenSand) {
            this.eigenSand.updateChunks(this.activeSandChunkPriority);
        }
        this.spawnPendingFluids(true);
    }

    setInputManager(manager) {
        this.inputManager = manager || null;
    }

    getTerrainSnapshot() {
        if (!this.terrain || typeof this.terrain.serializeSnapshot !== 'function') return null;
        const snapshot = this.terrain.serializeSnapshot();
        if (snapshot) {
            snapshot.seed = this.seed;
        }
        return snapshot;
    }

    loadTerrainSnapshot(snapshot) {
        console.log('[Engine] loadTerrainSnapshot called', snapshot ? `(${snapshot.width}x${snapshot.height})` : '(null)');
        if (!snapshot || !this.terrain || typeof this.terrain.applySnapshot !== 'function') {
            console.warn('[Engine] Cannot load terrain snapshot - missing data or terrain');
            return;
        }
        const success = this.terrain.applySnapshot(snapshot);
        if (!success) {
            console.error('[Engine] Failed to apply terrain snapshot');
            return;
        }
        console.log('[Engine] Terrain snapshot loaded successfully');
        this.clearSandChunks();
        this.sandParticleCount = 0;
        this.pendingFluidChunks.clear();
        this.pendingFluidCount = 0;
        this.liquidBlobCache.clear();
        this.nextLiquidBlobId = 1;
        if (this.terrainChunkRemapCache) {
            this.terrainChunkRemapCache.clear();
        }
        if (this.activeTerrainChunkCache) {
            this.activeTerrainChunkCache.tick = -1;
            this.activeTerrainChunkCache.chunkSize = 0;
            this.activeTerrainChunkCache.keys = null;
        }
        
        // Spawn initial fluids from the loaded terrain
        const fluids = this.terrain.consumeInitialFluids();
        this.spawnInitialFluids(fluids);
        
        const { width, height } = this.getViewDimensions();
        this.updateActiveChunks(width, height);
        this.spawnPendingFluids(true);
    }
    
    addPlayer(id, x, y, selectedSpell = null) {
        const playerRng = this.random && typeof this.random.fork === 'function'
            ? this.random.fork(`player:${id}`)
            : null;
        const player = new Player(id, x, y, selectedSpell, playerRng);
        this.players.set(id, player);
        this.playerList.push(player);
        return player;
    }
    
    removePlayer(id) {
        const player = this.players.get(id);
        if (!player) return;
        this.players.delete(id);
        const list = this.playerList;
        const index = list.indexOf(player);
        if (index !== -1) {
            const last = list.length - 1;
            if (index !== last) {
                list[index] = list[last];
            }
            list.length = last;
        }
    }
    
    start() {
        this.running = true;
        this.lastTime = performance.now();
        this.accumulator = 0;
        requestAnimationFrame(this._boundLoop);
    }
    
    stop() {
        this.running = false;
    }
    
    loop() {
        if (!this.running) return;
        
        const currentTime = performance.now();
        let deltaTime = currentTime - this.lastTime;
        if (deltaTime < 0) deltaTime = 0;
        if (deltaTime > this.maxDelta) deltaTime = this.maxDelta;
        this.lastTime = currentTime;

        this.accumulator += deltaTime;
        if (this.accumulator > this.maxDelta) {
            this.accumulator = this.maxDelta;
        }

        // Fixed timestep updates for deterministic physics
        let subSteps = 0;
        while (this.accumulator >= this.fixedTimeStep && subSteps < this.maxSubSteps) {
            this.update(this.fixedTimeStep);
            this.accumulator -= this.fixedTimeStep;
            this.tick++;
            subSteps++;
        }

        if (subSteps === this.maxSubSteps) {
            this.accumulator = 0;
        }

        if (!this.isServer) {
            this.render();
        }

        if (this.running) {
            requestAnimationFrame(this._boundLoop);
        }
    }
    
    getViewDimensions() {
        if (this.canvas) {
            return {
                width: this.canvas.width / this.pixelSize,
                height: this.canvas.height / this.pixelSize
            };
        }
        return {
            width: this.defaultViewWidth,
            height: this.defaultViewHeight
        };
    }

    onCanvasResized() {
        if (!this.canvas) return;
        this.defaultViewWidth = Math.max(1, Math.floor(this.canvas.width / this.pixelSize));
        this.defaultViewHeight = Math.max(1, Math.floor(this.canvas.height / this.pixelSize));

        if (this.terrain) {
            const { width, height } = this.getViewDimensions();
            this.updateActiveChunks(width, height);
        }
    }

    updateActiveChunks(viewWidth, viewHeight) {
        const chunkSize = this.chunkSize;
        const totalChunksX = Math.ceil(this.width / chunkSize);
        const totalChunksY = Math.ceil(this.height / chunkSize);
        const computeRadius = Math.max(0, Math.floor(this.playerChunkComputeRadius));
        const bufferRadius = Math.max(0, Math.floor(this.playerChunkBufferRadius));
        const maxActiveDist = Math.max(1, computeRadius + bufferRadius);

        let chunkRadiusX;
        let chunkRadiusY;

        if (this.isServer) {
            chunkRadiusX = maxActiveDist;
            chunkRadiusY = maxActiveDist;
        } else {
            const radiusX = Math.max(chunkSize, viewWidth * this.sandViewRadiusMultiplier);
            const radiusY = Math.max(chunkSize, viewHeight * this.sandViewRadiusMultiplier);
            chunkRadiusX = Math.max(maxActiveDist, Math.ceil(radiusX / chunkSize));
            chunkRadiusY = Math.max(maxActiveDist, Math.ceil(radiusY / chunkSize));
        }

        this.activeChunkSet.clear();
        this.activeSandChunkPriority.clear();

        const setChunkPriority = (key, priority) => {
            const current = this.activeSandChunkPriority.get(key);
            if (current === undefined || priority < current) {
                this.activeSandChunkPriority.set(key, priority);
            }
            this.activeChunkSet.add(key);
        };

        const players = this.playerList.length ? this.playerList : Array.from(this.players.values());
        if (players.length === 0) {
            this.activeChunkKeys.length = 0;
            this.activeSandLists.length = 0;
            this.activeSandChunkKeys.length = 0;
            this.activeSandLookup.length = 0;
            return;
        }

        const sortedPlayers = players.slice().sort((a, b) => a.id.localeCompare(b.id));
        for (let i = 0; i < sortedPlayers.length; i++) {
            const player = sortedPlayers[i];
            const chunkX = Math.floor(player.x / chunkSize);
            const chunkY = Math.floor(player.y / chunkSize);
            for (let dx = -chunkRadiusX; dx <= chunkRadiusX; dx++) {
                for (let dy = -chunkRadiusY; dy <= chunkRadiusY; dy++) {
                    const wrappedChunkX = ((chunkX + dx) % totalChunksX + totalChunksX) % totalChunksX;
                    const clampedChunkY = Math.max(0, Math.min(totalChunksY - 1, chunkY + dy));
                    const key = `${wrappedChunkX}|${clampedChunkY}`;
                    const dist = Math.max(Math.abs(dx), Math.abs(dy));
                    if (this.isServer && dist > maxActiveDist) {
                        continue;
                    }
                    let priority = 3;
                    if (dist <= this.playerChunkComputeRadius) {
                        priority = 0;
                    } else if (dist <= this.playerChunkComputeRadius + this.playerChunkBufferRadius) {
                        priority = 1;
                    } else {
                        priority = this.isServer ? maxActiveDist + 1 : 2;
                    }
                    setChunkPriority(key, priority);
                }
            }
        }

        this.activeChunkKeys = Array.from(this.activeChunkSet).sort((a, b) => a.localeCompare(b));

        const projectiles = this.projectiles;
        if (this.isServer && Array.isArray(projectiles) && projectiles.length) {
            const projRadius = Math.max(0, Math.floor(this.projectileChunkRadius));
            for (let i = 0; i < projectiles.length; i++) {
                const proj = projectiles[i];
                if (!proj || proj.dead) continue;
                const baseX = proj.x;
                const baseY = proj.y;
                const futureX = baseX + (proj.vx || 0) * 0.5;
                const futureY = baseY + (proj.vy || 0) * 0.5;
                this._addProjectileChunks(baseX, baseY, projRadius, totalChunksX, totalChunksY, chunkSize, maxActiveDist, setChunkPriority);
                this._addProjectileChunks(futureX, futureY, projRadius, totalChunksX, totalChunksY, chunkSize, maxActiveDist, setChunkPriority);
            }
            this.activeChunkKeys = Array.from(this.activeChunkSet).sort((a, b) => a.localeCompare(b));
        }

        this.activeSandLists.length = 0;
        this.activeSandChunkKeys.length = 0;
        this.activeSandLookup.length = 0;

        const warmThreshold = this.playerChunkComputeRadius + this.playerChunkBufferRadius;
        for (let i = 0; i < this.activeChunkKeys.length; i++) {
            const key = this.activeChunkKeys[i];
            const list = this.sandChunks.get(key);
            if (list && list.length) {
                const priority = this.activeSandChunkPriority.get(key);
                if (priority !== undefined && priority > warmThreshold) {
                    continue;
                }
                this.activeSandChunkKeys.push(key);
                this.activeSandLists.push(list);
                for (let j = 0; j < list.length; j++) {
                    const sand = list[j];
                    sand.chunkIndex = j;
                    sand.chunkPriority = typeof priority === 'number' ? priority : 3;
                    this.activeSandLookup.push(sand);
                }
            }
        }

        if (this.isServer && this.terrain && typeof this.terrain.updateLoadedChunks === 'function') {
            const terrainChunkSize = this.terrain && typeof this.terrain.chunkSize === 'number'
                ? this.terrain.chunkSize
                : 64;
            const activeTerrainChunks = this.getActiveTerrainChunkSet(terrainChunkSize);
            this.terrain.updateLoadedChunks(activeTerrainChunks, this.tick);
        }
    }

    update(dt, options = {}) {
        const skipSand = !!options.skipSand;
        const skipEntities = !!options.skipEntities;
        const skipParticles = !!options.skipParticles;
        const entityKeys = options.entityKeys || null;
        const { width: viewWidth, height: viewHeight } = this.getViewDimensions();
        this.updateActiveChunks(viewWidth, viewHeight);
        this.spawnPendingFluids(false);

        if (!this.isServer) {
            if (!skipEntities && this.inputManager && typeof this.inputManager.update === 'function') {
                this.inputManager.update();
            }
            if (!skipEntities) {
                const localPlayer = this.playerId ? this.players.get(this.playerId) : null;
                if (localPlayer) {
                    localPlayer.update(dt, this);
                    if (this.network && typeof this.network.recordLocalState === 'function') {
                        this.network.recordLocalState(this.tick, localPlayer);
                    }
                } else if (!this.network) {
                    const players = this.playerList;
                    for (let i = 0; i < players.length; i++) {
                        players[i].update(dt, this);
                    }
                }
            }

            if (!skipEntities) {
                for (let i = this.projectiles.length - 1; i >= 0; i--) {
                    const proj = this.projectiles[i];
                    proj.update(dt, this);
                    if (proj.dead) {
                        this.projectiles.splice(i, 1);
                    }
                }
            }

            if (!skipParticles) {
                for (let i = this.particles.length - 1; i >= 0; i--) {
                    const particle = this.particles[i];
                    particle.update(dt, this.width);
                    if (particle.dead) {
                        this.returnParticleToPool(particle);
                        this.particles.splice(i, 1);
                    }
                }
            }
            return;
        }

        if (this.eigenSand) {
            this.eigenSand.updateChunks(this.activeSandChunkPriority);
        }

        if (!skipEntities) {
            this.updateEntities(dt, entityKeys);
        }

        // Update falling sand (server-authoritative)
        if (this.isServer) {
            if (!skipSand) {
                this.updateSand(dt);
            }
        } else {
            // Client-side: extrapolate sand positions using velocity for smooth rendering
            for (let i = 0; i < this.activeSandLookup.length; i++) {
                const sand = this.activeSandLookup[i];
                if (!sand.dead && (sand.vx !== 0 || sand.vy !== 0)) {
                    sand.x += sand.vx * dt / 16.666;
                    sand.y += sand.vy * dt / 16.666;
                }
            }
        }

        if (!skipParticles) {
            for (let i = this.particles.length - 1; i >= 0; i--) {
                const particle = this.particles[i];
                particle.update(dt, this.width);

                if (particle.dead) {
                    this.returnParticleToPool(particle);
                    this.particles.splice(i, 1);
                }
            }
        }
    }

    addSandToChunk(sand, chunkX, chunkY) {
        if (chunkY < 0) chunkY = 0;
        const maxChunkY = Math.ceil(this.height / this.chunkSize) - 1;
        if (chunkY > maxChunkY) chunkY = maxChunkY;
        const totalChunksX = Math.ceil(this.width / this.chunkSize);
        chunkX = ((chunkX % totalChunksX) + totalChunksX) % totalChunksX;
        const chunkKey = `${chunkX}|${chunkY}`;
        let list = this.sandChunks.get(chunkKey);
        if (!list) {
            list = [];
            this.sandChunks.set(chunkKey, list);
        }
        sand.chunkX = chunkX;
        sand.chunkY = chunkY;
        sand.chunkKey = chunkKey;
        sand.chunkIndex = list.length;
        list.push(sand);
        sand.chunkIndex = list.length - 1;
        this.markSandChunkDirty(chunkKey);
        return list;
    }

    removeSandFromChunk(sand) {
        if (!sand.chunkKey) return;
        const chunkKey = sand.chunkKey;
        const list = this.sandChunks.get(chunkKey);
        if (!list || list.length === 0) {
            sand.chunkKey = null;
            sand.chunkIndex = -1;
            return;
        }
        const index = sand.chunkIndex;
        const last = list.pop();
        if (index < list.length) {
            list[index] = last;
            last.chunkIndex = index;
        }
        if (list.length === 0) {
            this.sandChunks.delete(chunkKey);
        }
        sand.chunkX = -1;
        sand.chunkY = -1;
        sand.chunkKey = null;
        sand.chunkIndex = -1;
        this.markSandChunkDirty(chunkKey);
    }

    moveSandToChunk(sand, newChunkX, newChunkY) {
        const oldKey = sand.chunkKey;
        if (oldKey) {
            this.removeSandFromChunk(sand);
        }
        this.addSandToChunk(sand, newChunkX, newChunkY);
    }

    spawnInitialFluids(fluids) {
        if (!Array.isArray(fluids) || fluids.length === 0) return;
        this.queuePendingFluids(fluids);
    }

    queuePendingFluids(fluids) {
        if (!Array.isArray(fluids) || fluids.length === 0) return;

        const chunkSize = this.chunkSize;
        const totalChunksX = Math.ceil(this.width / chunkSize);
        const maxChunkY = Math.ceil(this.height / chunkSize) - 1;
        const pendingAfterQueue = this.pendingFluidCount + fluids.length;
        this.ensureSandCapacity(pendingAfterQueue);

        for (let i = 0; i < fluids.length; i++) {
            const entry = fluids[i];
            if (!entry) continue;
            const material = entry.material;
            const y = Math.floor(entry.y);
            if (y < 0 || y >= this.height) continue;
            const wrappedX = wrapHorizontal(entry.x, this.width) | 0;
            let chunkX = Math.floor(wrappedX / chunkSize);
            let chunkY = Math.floor(y / chunkSize);
            chunkY = Math.max(0, Math.min(maxChunkY, chunkY));
            chunkX = ((chunkX % totalChunksX) + totalChunksX) % totalChunksX;
            const key = `${chunkX}|${chunkY}`;

            let list = this.pendingFluidChunks.get(key);
            if (!list) {
                list = [];
                this.pendingFluidChunks.set(key, list);
            }

            list.push({ x: wrappedX, y, material });
            this.pendingFluidCount++;
        }
    }

    spawnFluidParticle(entry) {
        if (!entry) return false;
        if (this.sandParticleCount >= this.maxSandParticles) {
            return false;
        }

        const { x, y, material } = entry;
        if (y < 0 || y >= this.height) return false;
        const sand = this.getSandParticleFromPool();
        const colorObj = this.terrain.getMaterialColor(material, x, y);
        const color = colorObj ? colorObj.hex : '#ffffff';
        const props = this.terrain.substances[material] || {};
        const mass = typeof props.density === 'number' ? props.density : 1;
        const isLiquid = props.type === 'liquid';
        if (this.terrain.getPixel(x, y) !== this.terrain.EMPTY) {
            this.terrain.setPixel(x, y, this.terrain.EMPTY);
            this.terrain.markDirty(x, y);
        }
        sand.init(x, y, material, color, 0, mass, isLiquid);
        const chunkX = Math.floor(x / this.chunkSize);
        let chunkY = Math.floor(y / this.chunkSize);
        const maxChunkY = Math.ceil(this.height / this.chunkSize) - 1;
        if (chunkY < 0) chunkY = 0;
        if (chunkY > maxChunkY) chunkY = maxChunkY;
        this.addSandToChunk(sand, chunkX, chunkY);
        this.sandParticleCount++;
        return true;
    }

    spawnPendingFluids(forceImmediate = false) {
        if (this.pendingFluidCount === 0) return;
        if (!forceImmediate && this.tick === this.lastFluidSpawnTick) return;

        this.ensureSandCapacity(this.pendingFluidCount);

        const chunkKeys = this.activeChunkKeys.length ? this.activeChunkKeys : [];
        if (!forceImmediate && chunkKeys.length === 0) return;

        const globalBudget = forceImmediate
            ? Math.min(this.pendingFluidCount, this.maxFluidSpawnPerTick * 4)
            : Math.min(this.pendingFluidCount, this.maxFluidSpawnPerTick);
        if (globalBudget <= 0) return;

        const perChunkBudget = forceImmediate ? Number.POSITIVE_INFINITY : this.maxFluidSpawnPerChunk;
        let spawned = 0;
        let aborted = false;

        const keysToProcess = chunkKeys.length ? chunkKeys : Array.from(this.pendingFluidChunks.keys());
        if (keysToProcess.length === 0) return;

        const startIndex = forceImmediate ? 0 : (this.tick % keysToProcess.length);

        for (let offset = 0; offset < keysToProcess.length && spawned < globalBudget; offset++) {
            const index = (startIndex + offset) % keysToProcess.length;
            const key = keysToProcess[index];
            const list = this.pendingFluidChunks.get(key);
            if (!list || list.length === 0) continue;

            const limit = Math.min(list.length, perChunkBudget, globalBudget - spawned);
            let produced = 0;

            while (list.length > 0 && produced < limit && spawned < globalBudget) {
                const data = list.pop();
                if (!this.spawnFluidParticle(data)) {
                    list.push(data);
                    aborted = true;
                    break;
                }
                this.pendingFluidCount--;
                produced++;
                spawned++;
            }

            if (list.length === 0) {
                this.pendingFluidChunks.delete(key);
            }

            if (aborted) {
                break;
            }
        }

        if (spawned > 0) {
            this.lastFluidSpawnTick = this.tick;
        }
    }

    ensureSandCapacity(pendingFluids = 0) {
        const area = this.width * this.height;
        const areaDrivenTarget = Math.min(this.absoluteSandCap, Math.floor(area * 0.004));
        const currentNeed = this.sandParticleCount + Math.max(0, pendingFluids);
        const fluidPadding = pendingFluids > 0 ? Math.max(250, Math.ceil(pendingFluids * 0.1)) : 0;
        const requested = Math.max(
            this.baseSandCapacity,
            areaDrivenTarget,
            Math.min(this.absoluteSandCap, currentNeed + fluidPadding)
        );
        const boundedTarget = Math.min(this.absoluteSandCap, requested);
        if (boundedTarget > this.maxSandParticles) {
            this.maxSandParticles = boundedTarget;
        } else {
            this.maxSandParticles = Math.min(this.maxSandParticles, this.absoluteSandCap);
        }

        this.sandPoolLimit = Math.min(this.sandPoolLimit, this.absoluteSandCap);
        const desiredPoolLimit = Math.min(this.absoluteSandCap, Math.max(1000, Math.floor(this.maxSandParticles * 0.6)));
        const boundedPool = Math.min(this.maxSandParticles, desiredPoolLimit);
        this.sandPoolLimit = Math.min(this.absoluteSandCap, Math.max(this.sandPoolLimit, boundedPool));
    }

    findSandParticleAt(x, y) {
        const chunkSize = this.chunkSize;
        const totalChunksX = Math.ceil(this.width / chunkSize);
        const maxChunkY = Math.ceil(this.height / chunkSize) - 1;
        let chunkX = Math.floor(x / chunkSize);
        let chunkY = Math.floor(y / chunkSize);
        chunkY = Math.max(0, Math.min(maxChunkY, chunkY));
        chunkX = ((chunkX % totalChunksX) + totalChunksX) % totalChunksX;
        const key = `${chunkX}|${chunkY}`;
        const list = this.sandChunks.get(key);
        if (!list) return null;
        const wrappedX = wrapHorizontal(x, this.width) | 0;
        for (let i = 0; i < list.length; i++) {
            const sand = list[i];
            if (!sand.dead && sand.x === wrappedX && sand.y === y) {
                return sand;
            }
        }
        return null;
    }

    markSandParticleAsConverted(sand, material) {
        if (!sand) return;
        const x = wrapHorizontal(sand.x, this.width) | 0;
        const y = sand.y;
        this.terrain.setPixel(x, y, material);
        sand.dead = true;
    }

    updateSand(dt) {
        const total = this.activeSandLookup.length;
        if (total === 0) {
            this.sandAdaptiveCursor = 0;
            this.liquidBlobCache.clear();
            return;
        }

        const occupancy = this.sandOccupancy;
        const occupancyMap = this.sandOccupancyMap;
        occupancy.clear();
        occupancyMap.clear();

        for (let i = 0; i < total; i++) {
            const sand = this.activeSandLookup[i];
            if (!sand.dead) {
                const key = sand.key();
                occupancy.add(key);
                occupancyMap.set(key, sand);
            }
        }

        const tick = this.tick;
        const dtStep = dt || this.fixedTimeStep || 16.666;

        const chunkSize = this.chunkSize;
        const totalChunksX = Math.ceil(this.width / chunkSize);
        const totalChunksY = Math.ceil(this.height / chunkSize);

        const chunkStats = new Map();
        const previousBlobState = new Map();
        const maxPriority = typeof this.maxComputedSandPriority === 'number'
            ? Math.max(0, this.maxComputedSandPriority)
            : 1;
        const warmPriority = maxPriority + 1;

        for (let i = 0; i < total; i++) {
            const sand = this.activeSandLookup[i];
            if (sand.dead) continue;
            const previousId = typeof sand.lastBlobId === 'number' ? sand.lastBlobId : -1;
            previousBlobState.set(sand, previousId);
            const priority = typeof sand.chunkPriority === 'number' ? sand.chunkPriority : 3;

            if (priority > warmPriority) {
                sand.blobId = -1;
                sand.lastBlobId = -1;
                continue;
            }

            const computeActive = priority <= maxPriority;
            sand.blobId = -1;

            if (!computeActive) {
                sand.lastBlobId = -1;
                sand.restTime = Math.min(sand.restTime + dtStep * 0.25, sand.settleDelay);
                sand.nextUpdateTick = Math.max(sand.nextUpdateTick, tick + 20);
                continue;
            }

            sand.classifyActivity(this, occupancy, occupancyMap, tick);

            if (sand.isLiquid) {
                let chunkX = Math.floor(sand.x / chunkSize);
                let chunkY = Math.floor(sand.y / chunkSize);
                chunkY = Math.max(0, Math.min(totalChunksY - 1, chunkY));
                chunkX = ((chunkX % totalChunksX) + totalChunksX) % totalChunksX;
                const chunkKey = `${chunkX}|${chunkY}`;
                let stats = chunkStats.get(chunkKey);
                if (!stats) {
                    stats = {
                        chunkKey,
                        chunkX,
                        chunkY,
                        members: [],
                        total: 0,
                        bulk: 0,
                        sumY: 0,
                        minY: sand.y,
                        maxY: sand.y
                    };
                    chunkStats.set(chunkKey, stats);
                }
                stats.members.push(sand);
                stats.total++;
                stats.sumY += sand.y;
                if (sand.y < stats.minY) stats.minY = sand.y;
                if (sand.y > stats.maxY) stats.maxY = sand.y;
                if (sand.activityLevel === SandActivityLevel.BULK) {
                    stats.bulk++;
                }
            }
        }

        this.liquidBlobCache.clear();
        const blobConfig = this.sandBlobConfig;
        for (const [chunkKey, stats] of chunkStats) {
            const minCount = blobConfig.liquidBlobMin || 48;
            const minRatio = blobConfig.liquidBlobBulkThreshold || 0.6;
            if (stats.total < minCount) {
                continue;
            }
            if (stats.bulk / stats.total < minRatio) {
                continue;
            }
            const blobId = this.nextLiquidBlobId++;
            const avgY = stats.sumY / stats.total;
            const depth = stats.maxY - stats.minY + 1;
            const pressure = stats.total * (blobConfig.liquidBlobPressure || 0.04);
            this.liquidBlobCache.set(chunkKey, {
                id: blobId,
                chunkKey,
                chunkX: stats.chunkX,
                chunkY: stats.chunkY,
                avgY,
                minY: stats.minY,
                maxY: stats.maxY,
                depth,
                count: stats.total,
                pressure
            });
            for (let i = 0; i < stats.members.length; i++) {
                const sand = stats.members[i];
                if (sand.activityLevel === SandActivityLevel.BULK) {
                    sand.blobId = blobId;
                }
            }
        }

        const candidateBuckets = [];
        for (let p = 0; p <= maxPriority; p++) {
            candidateBuckets.push([]);
        }

        for (let i = 0; i < total; i++) {
            const sand = this.activeSandLookup[i];
            if (sand.dead) continue;
            const prevBlobId = previousBlobState.get(sand) ?? -1;
            const priority = typeof sand.chunkPriority === 'number' ? sand.chunkPriority : 3;
            if (priority > maxPriority) {
                sand.lastBlobId = -1;
                continue;
            }
            sand.resolveUpdateInterval(this);

            if (sand.blobId !== -1 && sand.activityLevel === SandActivityLevel.BULK) {
                const blobInterval = Math.max(sand.updateInterval, blobConfig.liquidBlobInterval || 12);
                if (sand.nextUpdateTick <= tick) {
                    sand.nextUpdateTick = tick + blobInterval;
                }
                sand.restTime = Math.min(sand.restTime + dtStep * 0.5, sand.settleDelay);
                sand.lastBlobId = sand.blobId;
                continue;
            }

            if (prevBlobId !== sand.blobId && prevBlobId !== -1 && sand.blobId === -1) {
                sand.nextUpdateTick = Math.min(sand.nextUpdateTick, tick);
            }

            if (sand.nextUpdateTick <= tick) {
                const bucketIndex = Math.max(0, Math.min(priority, candidateBuckets.length - 1));
                candidateBuckets[bucketIndex].push(sand);
            } else {
                const terrain = this.terrain;
                const substances = terrain ? terrain.substances : null;
                const props = substances ? substances[sand.material] : null;
                const restTable = props && props.type === 'liquid'
                    ? this.sandBlobConfig.liquidRestBoost
                    : this.sandBlobConfig.solidRestBoost;
                const restIndex = Math.min(restTable.length - 1, sand.activityLevel);
                const boost = restTable[restIndex] || 1;
                sand.restTime = Math.min(sand.restTime + dtStep * boost, sand.settleDelay);
            }

            sand.lastBlobId = sand.blobId;
        }

        const candidates = [];
        for (let p = 0; p < candidateBuckets.length; p++) {
            const bucket = candidateBuckets[p];
            for (let i = 0; i < bucket.length; i++) {
                candidates.push(bucket[i]);
            }
        }

        const candidateCount = candidates.length;
        if (candidateCount === 0) {
            this.sandAdaptiveCursor = 0;
            this.pruneDeadSand();
            this.flushDirtySandChunks();
            return;
        }

        const updates = Math.min(candidateCount, this.maxSandUpdatesPerFrame);
        if (updates === 0) {
            this.pruneDeadSand();
            this.flushDirtySandChunks();
            return;
        }

        this.sandAdaptiveCursor %= candidateCount;
        let processed = 0;

        while (processed < updates) {
            const idx = (this.sandAdaptiveCursor + processed) % candidateCount;
            const sand = candidates[idx];
            if (!sand.dead) {
                const prevX = sand.x;
                const prevY = sand.y;
                const prevChunkKey = sand.chunkKey;
                sand.update(this, occupancy, dt, occupancyMap);
                sand.nextUpdateTick = tick + sand.updateInterval;
                if (sand.dead) {
                    if (prevChunkKey) {
                        this.markSandChunkDirty(prevChunkKey);
                    }
                } else {
                    const newChunkX = Math.floor(sand.x / chunkSize);
                    let newChunkY = Math.floor(sand.y / chunkSize);
                    newChunkY = Math.max(0, Math.min(totalChunksY - 1, newChunkY));
                    const wrappedChunkX = ((newChunkX % totalChunksX) + totalChunksX) % totalChunksX;
                    if (sand.chunkX !== wrappedChunkX || sand.chunkY !== newChunkY) {
                        this.moveSandToChunk(sand, wrappedChunkX, newChunkY);
                    } else if ((sand.x !== prevX || sand.y !== prevY) && prevChunkKey) {
                        this.markSandChunkDirty(prevChunkKey);
                    }
                }
            }
            processed++;
        }

        this.sandAdaptiveCursor = (this.sandAdaptiveCursor + updates) % candidateCount;

        this.pruneDeadSand();
        this.flushDirtySandChunks();
    }

    pruneDeadSand() {
        for (let i = this.activeSandLists.length - 1; i >= 0; i--) {
            const list = this.activeSandLists[i];
            let j = list.length;
            while (j--) {
                const sand = list[j];
                if (!sand.dead) continue;
                this.removeSandFromChunk(sand);
                this.returnSandParticleToPool(sand);
                this.sandParticleCount--;
            }
            if (!list.length) {
                const key = this.activeSandChunkKeys[i];
                this.sandChunks.delete(key);
                this.markSandChunkDirty(key);
            }
        }

        if (this.sandParticleCount < 0) {
            this.sandParticleCount = 0;
        }

        this.activeSandLookup.length = 0;
        this.activeSandLists.length = 0;
        this.activeSandChunkKeys.length = 0;
        this.sandOccupancy.clear();
        this.sandOccupancyMap.clear();
    }

    render() {
        const ctx = this.ctx;
        const scale = this.pixelSize;

        // Clear
        ctx.fillStyle = '#0a0a1a';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        ctx.save();

        // Camera transform
        const viewWidth = this.canvas.width / scale;
        const viewHeight = this.canvas.height / scale;
        const camX = Math.floor(this.cameraX - viewWidth / 2);
        const camY = Math.floor(this.cameraY - viewHeight / 2);
        ctx.translate(-camX * scale, -camY * scale);

        const { width: renderViewWidth, height: renderViewHeight } = this.getViewDimensions();
        this.updateActiveChunks(renderViewWidth, renderViewHeight);

        if (this.terrain && typeof this.terrain.processSurfaceDirty === 'function') {
            this.terrain.processSurfaceDirty();
        }

        // Background layers
        const voidColor = '#2d043d';
        const worldLeft = Math.floor(camX) - 2;
        const worldRight = Math.ceil(camX + viewWidth) + 2;
        const worldTop = camY - 2;
        const worldBottom = camY + viewHeight + 2;

        // Void region (below world height)
        const voidTop = Math.max(this.height, worldTop);
        if (voidTop < worldBottom) {
            ctx.fillStyle = voidColor;
            ctx.fillRect(worldLeft * scale, voidTop * scale, (worldRight - worldLeft) * scale, (worldBottom - voidTop) * scale);
        }

        const skyTopColor = '#1a4c9c';
        const skyBottomColor = '#3c7bd9';

        // Sky columns above the terrain surface
        if (this.terrain) {
            const surfaceCache = this.terrain.surfaceCache;
            for (let col = worldLeft; col < worldRight; col++) {
                const wrappedX = ((col % this.width) + this.width) % this.width;
                let surfaceY = surfaceCache ? surfaceCache[wrappedX] : this.height;
                if (surfaceY === undefined) surfaceY = this.height;
                surfaceY = Math.max(0, Math.min(this.height, surfaceY));

                const columnBottom = Math.min(surfaceY, worldBottom);
                const columnTop = Math.min(worldTop, columnBottom);
                if (columnBottom > columnTop) {
                    const gradient = ctx.createLinearGradient(
                        col * scale,
                        columnTop * scale,
                        col * scale,
                        columnBottom * scale
                    );
                    gradient.addColorStop(0, skyTopColor);
                    gradient.addColorStop(1, skyBottomColor);
                    ctx.fillStyle = gradient;
                    ctx.fillRect(col * scale, columnTop * scale, scale, (columnBottom - columnTop) * scale);
                }
            }
        }

        // Render terrain
        if (this.terrain) {
            this.terrain.render(ctx, camX, camY, viewWidth, viewHeight, scale);
        }
        
        const wrapOffsets = [0];
        if (camX < 0) wrapOffsets.push(-this.width);
        if (camX + viewWidth > this.width) wrapOffsets.push(this.width);
        
        // Debug sand rendering
        if (this.tick % 60 === 0 && this.sandParticleCount > 0) {
            const totalSand = this.activeSandLists.reduce((sum, list) => sum + list.length, 0);
            console.log('[RENDER] tick:', this.tick, 'sandCount:', this.sandParticleCount, 'activeSandLists:', this.activeSandLists.length, 'drawing', totalSand, 'sand particles');
        }
        
        for (const offset of wrapOffsets) {
            if (offset !== 0) {
                ctx.save();
                ctx.translate(offset * scale, 0);
            }

            for (const list of this.activeSandLists) {
                for (let i = 0; i < list.length; i++) {
                    list[i].render(ctx, scale);
                }
            }

            for (const proj of this.projectiles) {
                proj.render(ctx, scale);
            }
            
            for (const particle of this.particles) {
                particle.render(ctx, scale);
            }
            
            const players = this.playerList;
            for (let i = 0; i < players.length; i++) {
                players[i].render(ctx, scale);
            }

            if (offset !== 0) {
                ctx.restore();
            }
        }

        ctx.restore();
        
        // UI
        this.renderUI(ctx);
    }
    
    renderUI(ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.font = '14px monospace';
        const stats = this.serverStats || {};

        const playerCount = Number.isFinite(stats.players)
            ? stats.players
            : this.players.size;
        const sandCount = Number.isFinite(stats.sand)
            ? stats.sand
            : this.getLocalSandCount();
        const projectileCount = Number.isFinite(stats.projectiles)
            ? stats.projectiles
            : this.projectiles.length;
        const tickValue = Number.isFinite(stats.tick)
            ? stats.tick
            : this.tick;

        let chunkKey = (typeof stats.chunk === 'string' && stats.chunk.length > 0)
            ? stats.chunk
            : null;
        if (!chunkKey) {
            const referencePlayer = (this.playerId && this.players.has(this.playerId))
                ? this.players.get(this.playerId)
                : (this.playerList.length > 0
                    ? this.playerList[0]
                    : (this.players.size > 0 ? Array.from(this.players.values())[0] : null));
            if (referencePlayer) {
                chunkKey = this.getChunkKeyForPosition(referencePlayer.x, referencePlayer.y) || null;
            }
        }

        const now = Date.now();
        const terrainAge = Number.isFinite(stats.lastTerrainUpdate)
            ? ((now - stats.lastTerrainUpdate) / 1000).toFixed(1) + 's'
            : '—';
        const sandAge = Number.isFinite(stats.lastSandUpdate)
            ? ((now - stats.lastSandUpdate) / 1000).toFixed(1) + 's'
            : '—';

        const chunkInfo = chunkKey ? this.getChunkSyncInfo(chunkKey) : null;
        const chunkTerrainAge = chunkInfo && Number.isFinite(chunkInfo.lastTerrain)
            ? ((now - chunkInfo.lastTerrain) / 1000).toFixed(1) + 's'
            : '—';
        const chunkSandAge = chunkInfo && Number.isFinite(chunkInfo.lastSand)
            ? ((now - chunkInfo.lastSand) / 1000).toFixed(1) + 's'
            : '—';

        ctx.fillText(`Players: ${playerCount}`, 10, 20);
        ctx.fillText(`Sand: ${sandCount}`, 10, 40);
        ctx.fillText(`Projectiles: ${projectileCount}`, 10, 60);
        ctx.fillText(`Tick: ${tickValue}`, 10, 80);
        ctx.fillText(`Chunk: ${chunkKey || '—'} [T ${chunkTerrainAge} | S ${chunkSandAge}]`, 10, 100);
        ctx.fillText(`Terrain Δ: ${terrainAge}`, 10, 120);
        ctx.fillText(`Sand Δ: ${sandAge}`, 10, 140);
    }

    getLocalSandCount() {
        const chunkSize = this.chunkSize;
        if (!(chunkSize > 0)) {
            return 0;
        }

        let referencePlayer = null;
        if (this.playerId && this.players.has(this.playerId)) {
            referencePlayer = this.players.get(this.playerId);
        } else if (this.playerList.length > 0) {
            referencePlayer = this.playerList[0];
        } else if (this.players.size > 0) {
            referencePlayer = Array.from(this.players.values())[0];
        }

        if (!referencePlayer) {
            return 0;
        }

        const totalChunksX = Math.ceil(this.width / chunkSize);
        const totalChunksY = Math.ceil(this.height / chunkSize);
        const chunkX = ((Math.floor(referencePlayer.x / chunkSize) % totalChunksX) + totalChunksX) % totalChunksX;
        const chunkY = Math.max(0, Math.min(totalChunksY - 1, Math.floor(referencePlayer.y / chunkSize)));
        const key = `${chunkX}|${chunkY}`;
        const list = this.sandChunks.get(key);
        if (!list || list.length === 0) {
            return 0;
        }

        let count = 0;
        for (let i = 0; i < list.length; i++) {
            if (!list[i].dead) {
                count++;
            }
        }
        return count;
    }

    getChunkKeyForPosition(x, y) {
        const chunkSize = this.chunkSize;
        const totalChunksX = Math.ceil(this.width / chunkSize);
        const totalChunksY = Math.ceil(this.height / chunkSize);
        const chunkX = ((Math.floor(x / chunkSize) % totalChunksX) + totalChunksX) % totalChunksX;
        const chunkY = Math.max(0, Math.min(totalChunksY - 1, Math.floor(y / chunkSize)));
        return `${chunkX}|${chunkY}`;
    }

    getChunkSyncInfo(key) {
        if (!key) return null;
        return this.chunkSyncStatus.get(key) || null;
    }

    markChunkSync(keys, { terrain = false, sand = false, full = false, tick = null } = {}) {
        const timestamp = Date.now();
        if (!keys) {
            if (terrain) {
                this.serverStats.lastTerrainUpdate = timestamp;
            }
            if (sand) {
                this.serverStats.lastSandUpdate = timestamp;
            }
            return;
        }

        const list = Array.isArray(keys)
            ? keys
            : (keys instanceof Set ? Array.from(keys) : [keys]);
        if (!list.length) {
            if (terrain) {
                this.serverStats.lastTerrainUpdate = timestamp;
            }
            if (sand) {
                this.serverStats.lastSandUpdate = timestamp;
            }
            return;
        }

        for (const rawKey of list) {
            if (!rawKey) continue;
            const key = String(rawKey);
            const status = this.chunkSyncStatus.get(key) || {
                lastTerrain: null,
                lastSand: null,
                lastFull: null,
                lastTick: null
            };

            if (terrain) {
                status.lastTerrain = timestamp;
            }
            if (sand) {
                status.lastSand = timestamp;
            }
            if (full) {
                status.lastFull = timestamp;
            }
            if (Number.isFinite(tick)) {
                status.lastTick = tick;
            }

            this.chunkSyncStatus.set(key, status);
        }

        if (terrain) {
            this.serverStats.lastTerrainUpdate = timestamp;
        }
        if (sand) {
            this.serverStats.lastSandUpdate = timestamp;
        }
        if (full && this.serverStats.chunk && !this.chunkSyncStatus.has(this.serverStats.chunk)) {
            this.serverStats.lastTerrainUpdate = this.serverStats.lastTerrainUpdate ?? timestamp;
            this.serverStats.lastSandUpdate = this.serverStats.lastSandUpdate ?? timestamp;
        }
    }

    getLiquidBlobAt(x, y) {
        if (!this.liquidBlobCache || this.liquidBlobCache.size === 0) {
            return null;
        }
        const key = this.getChunkKeyForPosition(x, y);
        return this.liquidBlobCache.get(key) || null;
    }
    
    spawnProjectile(x, y, vx, vy, type, ownerId, options = null) {
        const proj = new Projectile(wrapHorizontal(x, this.width), y, vx, vy, type, ownerId);
        if (options && typeof options === 'object') {
            if (options.clientProjectileId) {
                proj.clientProjectileId = options.clientProjectileId;
            }
            if (options.pending) {
                proj.pending = true;
            }
            if (options.serverId) {
                proj.serverId = options.serverId;
            }
        }
        this.projectiles.push(proj);
        if (typeof this.onProjectileSpawn === 'function') {
            this.onProjectileSpawn(proj);
        }
        return proj;
    }

    destroyTerrain(x, y, radius, explosive = false, broadcast = true) {
        const wrappedX = wrapHorizontal(x, this.width);

        if (!this.isServer && broadcast) {
            if (typeof this.onTerrainDestruction === 'function') {
                this.onTerrainDestruction({ x: wrappedX, y, radius, explosive, broadcast });
            }
            return [];
        }

        const affectedSandChunks = new Set();
        const chunks = this.terrain.destroy(wrappedX, y, radius);

        for (const chunkData of chunks) {
            this.spawnSandFromPixels(chunkData, wrappedX, y, explosive, affectedSandChunks);
        }

        if (broadcast && this.network && typeof this.network.sendTerrainDestruction === 'function') {
            this.network.sendTerrainDestruction(wrappedX, y, radius, explosive);
        }

        if (typeof this.onTerrainDestruction === 'function') {
            this.onTerrainDestruction({ x: wrappedX, y, radius, explosive, broadcast });
        }

        if (affectedSandChunks.size > 0) {
            this.flushDirtySandChunks(affectedSandChunks);
        }

        return chunks;
    }

    spawnSandFromPixels(chunkData, originX, originY, explosive, affectedChunks = null) {
        if (!chunkData || !chunkData.pixels || chunkData.pixels.length === 0) {
            return;
        }

        const pixels = chunkData.pixels;
        const explosionFalloff = explosive ? 1 : 0;

        this.ensureSandCapacity(pixels.length);
        if (this.sandParticleCount >= this.maxSandParticles) {
            return;
        }

        const availableSlots = this.maxSandParticles - this.sandParticleCount;
        const spawnCap = Math.min(this.maxSandSpawnPerDestroy, availableSlots);
        const spawnRatio = pixels.length > spawnCap ? spawnCap / pixels.length : 1;
        const rng = this.random;
        let spawned = 0;

        if (spawnCap <= 0) {
            return;
        }

        for (let i = 0; i < pixels.length; i++) {
            if (spawned >= spawnCap) break;
            const roll = rng ? rng.nextFloat() : Math.random();
            if (roll > spawnRatio) continue;

            const px = pixels[i];
            if (px.y < 0 || px.y >= this.height) continue;
            const wrappedX = wrapHorizontal(px.x, this.width) | 0;
            const sand = this.getSandParticleFromPool();
            const colorObj = this.terrain.getMaterialColor(px.material, wrappedX, px.y);
            const color = colorObj ? colorObj.hex : '#ffffff';

            let drift = 0;
            if (explosive) {
                const delta = shortestWrappedDelta(px.x, originX, this.width);
                drift = delta === 0 ? 0 : Math.sign(delta);
            } else {
                const driftRoll = rng ? rng.nextFloat() : Math.random();
                if (driftRoll < 0.2) {
                    drift = (rng ? rng.nextBool() : Math.random() < 0.5) ? -1 : 1;
                }
            }

            const props = this.terrain.substances[px.material] || {};
            const mass = typeof props.density === 'number' ? props.density : 1;
            const isLiquid = props.type === 'liquid';
            const driftValue = explosionFalloff ? drift * explosionFalloff : drift;
            sand.init(wrappedX, px.y, px.material, color, driftValue, mass, isLiquid);
            const chunkX = Math.floor(wrappedX / this.chunkSize);
            const chunkY = Math.floor(px.y / this.chunkSize);
            this.addSandToChunk(sand, chunkX, chunkY);
            if (affectedChunks) {
                affectedChunks.add(`${chunkX}|${chunkY}`);
            }
            this.sandParticleCount++;
            spawned++;
        }
    }

    spawnParticles(x, y, count, color) {
        const rng = this.random;
        for (let i = 0; i < count; i++) {
            const particle = this.getParticleFromPool();
            const angle = (rng ? rng.nextFloat() : Math.random()) * Math.PI * 2;
            const speed = (rng ? rng.nextFloat() : Math.random()) * 3 + 1;
            const px = wrapHorizontal(x, this.width);
            const decay = 0.02 + (rng ? rng.nextFloat() : Math.random()) * 0.02;
            particle.init(px, y, Math.cos(angle) * speed, Math.sin(angle) * speed, color, decay, 0.15);
            this.particles.push(particle);
        }
    }
    
    // Object pooling
    getSandParticleFromPool() {
        return this.sandPool.length > 0 ? this.sandPool.pop() : new SandParticle();
    }

    returnSandParticleToPool(sand) {
        sand.reset();
        if (this.sandPool.length < this.sandPoolLimit) {
            this.sandPool.push(sand);
        }
    }

    markSandChunkDirty(key) {
        if (key === null || key === undefined) return;
        const normalizedKey = typeof key === 'string' ? key : String(key);
        if (!normalizedKey || normalizedKey.length === 0) return;
        this.dirtySandChunkKeys.add(normalizedKey);
    }

    clearDirtySandChunks(keys = null) {
        if (!keys) {
            this.dirtySandChunkKeys.clear();
            return;
        }
        if (typeof keys[Symbol.iterator] !== 'function') {
            const normalizedKey = typeof keys === 'string' ? keys : String(keys);
            this.dirtySandChunkKeys.delete(normalizedKey);
            return;
        }
        for (const key of keys) {
            if (key === null || key === undefined) continue;
            const normalizedKey = typeof key === 'string' ? key : String(key);
            this.dirtySandChunkKeys.delete(normalizedKey);
        }
    }

    flushDirtySandChunks(additionalKeys = null) {
        if (additionalKeys && typeof additionalKeys[Symbol.iterator] === 'function') {
            for (const key of additionalKeys) {
                this.markSandChunkDirty(key);
            }
        }

        if (this.dirtySandChunkKeys.size === 0) {
            return;
        }

        const broadcastKeys = this.filterSandChunkKeysForBroadcast(this.dirtySandChunkKeys);
        if (!broadcastKeys || broadcastKeys.length === 0) {
            return;
        }

        if (typeof this.onSandUpdate === 'function') {
            const payload = this.serializeSandChunksForKeys(broadcastKeys);
            if (payload) {
                this.onSandUpdate(payload);
            }
        }

        this.clearDirtySandChunks(broadcastKeys);
    }

    filterSandChunkKeysForBroadcast(keys) {
        if (!keys || typeof keys[Symbol.iterator] !== 'function') {
            return [];
        }

        if (this.players.size === 0) {
            return Array.from(keys);
        }

        const chunkSize = this.chunkSize;
        const totalChunksX = Math.ceil(this.width / chunkSize);
        const maxChunkY = Math.ceil(this.height / chunkSize) - 1;
        const configuredRadius = typeof this.sandChunkBroadcastRadius === 'number'
            ? Math.floor(this.sandChunkBroadcastRadius)
            : NaN;
        const fallbackRadius = this.playerChunkBufferRadius + this.playerChunkComputeRadius + 2;
        const radius = Math.max(1, Number.isFinite(configuredRadius) ? configuredRadius : fallbackRadius);

        const players = [];
        for (const player of this.players.values()) {
            if (!player) continue;
            let chunkX = Math.floor(player.x / chunkSize);
            let chunkY = Math.floor(player.y / chunkSize);
            if (!Number.isFinite(chunkX) || !Number.isFinite(chunkY)) continue;
            chunkY = Math.max(0, Math.min(maxChunkY, chunkY));
            chunkX = ((chunkX % totalChunksX) + totalChunksX) % totalChunksX;
            players.push({ x: chunkX, y: chunkY });
        }

        if (players.length === 0) {
            return Array.from(keys);
        }

        const broadcast = [];

        for (const key of keys) {
            if (key === null || key === undefined) continue;
            const parts = typeof key === 'string' ? key.split('|') : String(key).split('|');
            if (parts.length !== 2) continue;
            let chunkX = parseInt(parts[0], 10);
            let chunkY = parseInt(parts[1], 10);
            if (Number.isNaN(chunkX) || Number.isNaN(chunkY)) continue;
            chunkY = Math.max(0, Math.min(maxChunkY, chunkY));
            chunkX = ((chunkX % totalChunksX) + totalChunksX) % totalChunksX;
            for (let i = 0; i < players.length; i++) {
                const playerChunk = players[i];
                const wrappedDeltaX = this.getWrappedChunkDelta(chunkX, playerChunk.x, totalChunksX);
                const deltaY = chunkY - playerChunk.y;
                if (Math.abs(wrappedDeltaX) <= radius && Math.abs(deltaY) <= radius) {
                    broadcast.push(`${chunkX}|${chunkY}`);
                    break;
                }
            }
        }

        if (broadcast.length <= 1) {
            return broadcast;
        }

        const unique = new Set(broadcast);
        return Array.from(unique);
    }

    getWrappedChunkDelta(a, b, total) {
        if (typeof shortestWrappedDelta === 'function') {
            return shortestWrappedDelta(a, b, total);
        }
        if (!Number.isFinite(total) || total <= 0) {
            return a - b;
        }
        let delta = a - b;
        if (delta > total / 2) {
            delta -= total;
        } else if (delta < -total / 2) {
            delta += total;
        }
        return delta;
    }

    serializeSandChunksNearPlayers(chunkRadius = 15) {
        const payload = {
            chunkSize: this.chunkSize,
            chunks: [],
            full: false
        };

        if (this.players.size === 0) {
            return null;
        }

        const computeRadius = Math.max(0, Math.floor(this.playerChunkComputeRadius));
        const bufferRadius = Math.max(0, Math.floor(this.playerChunkBufferRadius));
        const maxActiveRadius = Math.max(1, computeRadius + bufferRadius);

        const activeKeys = Array.isArray(this.activeSandChunkKeys) && this.activeSandChunkKeys.length
            ? this.activeSandChunkKeys
            : null;

        if (this.isServer && activeKeys) {
            for (let i = 0; i < activeKeys.length; i++) {
                const key = activeKeys[i];
                if (!key) continue;
                const list = this.sandChunks.get(key);
                if (!list || list.length === 0) continue;
                payload.chunks.push({
                    key,
                    particles: list.map((p) => ({
                        x: p.x,
                        y: p.y,
                        vx: p.vx,
                        vy: p.vy,
                        material: p.material,
                        color: p.color
                    }))
                });
            }
            return payload.chunks.length > 0 ? payload : null;
        }

        let effectiveRadius = Number.isFinite(chunkRadius) ? Math.max(0, Math.floor(chunkRadius)) : maxActiveRadius;
        if (this.isServer) {
            effectiveRadius = Math.min(effectiveRadius, maxActiveRadius);
        } else {
            effectiveRadius = Math.max(effectiveRadius, maxActiveRadius);
        }

        const totalChunksX = Math.ceil(this.width / this.chunkSize);
        const totalChunksY = Math.ceil(this.height / this.chunkSize);
        const relevantChunks = new Set();

        for (const player of this.players.values()) {
            const playerChunkX = Math.floor(player.x / this.chunkSize);
            const playerChunkY = Math.floor(player.y / this.chunkSize);

            for (let dy = -effectiveRadius; dy <= effectiveRadius; dy++) {
                for (let dx = -effectiveRadius; dx <= effectiveRadius; dx++) {
                    const chunkX = playerChunkX + dx;
                    const chunkY = playerChunkY + dy;
                    if (chunkY < 0 || chunkY >= totalChunksY) continue;
                    const wrappedChunkX = ((chunkX % totalChunksX) + totalChunksX) % totalChunksX;
                    relevantChunks.add(`${wrappedChunkX}|${chunkY}`);
                }
            }
        }

        for (const key of relevantChunks) {
            const list = this.sandChunks.get(key);
            if (!list || list.length === 0) continue;
            payload.chunks.push({
                key,
                particles: list.map((p) => ({
                    x: p.x,
                    y: p.y,
                    vx: p.vx,
                    vy: p.vy,
                    material: p.material,
                    color: p.color
                }))
            });
        }

        return payload.chunks.length > 0 ? payload : null;
    }

    serializeSandChunks(activeOnly = false, options = {}) {
        const includeState = !!options.includeState;
        const payload = {
            chunkSize: this.chunkSize,
            chunks: [],
            full: !activeOnly
        };

        if (activeOnly) {
            if (this.activeSandLists.length === 0) {
                for (const [key, list] of this.sandChunks.entries()) {
                    if (!list.length) continue;
                    payload.chunks.push({
                        key,
                        particles: list.map((p) => this.serializeSandParticle(p, includeState))
                    });
                }
            } else {
                for (let i = 0; i < this.activeSandLists.length; i++) {
                    const key = this.activeSandChunkKeys[i];
                    const list = this.activeSandLists[i];
                    if (!list.length) continue;
                    payload.chunks.push({
                        key,
                        particles: list.map((p) => this.serializeSandParticle(p, includeState))
                    });
                }
            }
        } else {
            for (const [key, list] of this.sandChunks.entries()) {
                if (!list.length) continue;
                payload.chunks.push({
                    key,
                    particles: list.map((p) => this.serializeSandParticle(p, includeState))
                });
            }
        }

        if (includeState && payload.chunks.length) {
            payload.includeState = true;
        }

        return payload.chunks.length ? payload : null;
    }

    serializeSandChunksForKeys(keys, options = {}) {
        if (!keys || typeof keys[Symbol.iterator] !== 'function') return null;
        const includeState = !!options.includeState;
        const chunks = [];
        for (const key of keys) {
            if (key === null || key === undefined) continue;
            const normalizedKey = typeof key === 'string' ? key : String(key);
            const list = this.sandChunks.get(normalizedKey);
            if (!list || list.length === 0) {
                chunks.push({
                    key: normalizedKey,
                    particles: []
                });
                continue;
            }
            chunks.push({
                key: normalizedKey,
                particles: list.map((p) => this.serializeSandParticle(p, includeState))
            });
        }
        if (chunks.length === 0) return null;
        const payload = {
            chunkSize: this.chunkSize,
            chunks,
            full: false
        };
        if (includeState) {
            payload.includeState = true;
        }
        return payload;
    }

    serializeSandParticle(particle, includeState = false) {
        const base = {
            x: particle.x,
            y: particle.y,
            vx: particle.vx || 0,
            vy: particle.vy || 0,
            material: particle.material,
            color: particle.color
        };
        if (includeState) {
            base.restTime = particle.restTime || 0;
            base.settleDelay = particle.settleDelay || 0;
            base.drift = particle.drift || 0;
            base.mass = particle.mass || 1;
            base.isLiquid = !!particle.isLiquid;
            base.dead = !!particle.dead;
            base.updateInterval = particle.updateInterval || 1;
            base.nextUpdateTick = particle.nextUpdateTick || 0;
            base.activityLevel = particle.activityLevel || 0;
            base.chunkPriority = particle.chunkPriority || 3;
            base.blobId = particle.blobId ?? -1;
            base.lastBlobId = particle.lastBlobId ?? -1;
        }
        return base;
    }

    _addProjectileChunks(x, y, radius, totalChunksX, totalChunksY, chunkSize, maxActiveDist, setChunkPriority) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        let chunkX = Math.floor(x / chunkSize);
        let chunkY = Math.floor(y / chunkSize);
        chunkY = Math.max(0, Math.min(totalChunksY - 1, chunkY));
        chunkX = ((chunkX % totalChunksX) + totalChunksX) % totalChunksX;

        const extent = Math.max(0, radius);
        for (let dx = -extent; dx <= extent; dx++) {
            for (let dy = -extent; dy <= extent; dy++) {
                const px = ((chunkX + dx) % totalChunksX + totalChunksX) % totalChunksX;
                const py = Math.max(0, Math.min(totalChunksY - 1, chunkY + dy));
                const key = `${px}|${py}`;
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                let priority = dist <= this.playerChunkComputeRadius ? 1 : 3;
                if (dist === 0) {
                    priority = 1;
                } else if (dist <= this.playerChunkBufferRadius) {
                    priority = 2;
                }
                if (priority > maxActiveDist) {
                    priority = maxActiveDist;
                }
                setChunkPriority(key, priority);
            }
        }
    }

    updateEntities(dt, entityKeys = null) {
        const filter = entityKeys ? new Set(entityKeys) : null;

        const shouldProcessPlayer = (player) => {
            if (!filter) return true;
            const key = this.getChunkKeyForPosition(player.x, player.y);
            return key ? filter.has(key) : false;
        };

        const players = this.playerList;
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            if (!player) continue;
            if (filter && !shouldProcessPlayer(player)) {
                continue;
            }
            player.update(dt, this);
        }

        const shouldProcessProjectile = (proj) => {
            if (!filter) return true;
            const key = this.getChunkKeyForPosition(proj.x, proj.y);
            return key ? filter.has(key) : false;
        };

        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const proj = this.projectiles[i];
            if (!proj) continue;
            if (filter && !shouldProcessProjectile(proj)) {
                continue;
            }
            proj.update(dt, this);
            if (proj.dead) {
                this.projectiles.splice(i, 1);
            }
        }
    }

    serializeEntities(entityKeys = null, includeInputs = true) {
        const filter = entityKeys ? new Set(entityKeys) : null;
        const payload = {
            players: [],
            projectiles: []
        };

        const shouldInclude = (key) => {
            if (!filter) return true;
            return key ? filter.has(key) : false;
        };

        for (let i = 0; i < this.playerList.length; i++) {
            const player = this.playerList[i];
            if (!player) continue;
            const chunkKey = this.getChunkKeyForPosition(player.x, player.y);
            if (!shouldInclude(chunkKey)) continue;
            const data = {
                id: player.id,
                chunkKey,
                x: player.x,
                y: player.y,
                vx: player.vx || 0,
                vy: player.vy || 0,
                alive: !!player.alive,
                health: player.health,
                maxHealth: player.maxHealth,
                grounded: !!player.grounded,
                aimAngle: player.aimAngle,
                selectedSpell: player.selectedSpell,
                width: player.width,
                height: player.height,
                facing: player.facing || 1
            };
            if (includeInputs && player.input) {
                data.input = {
                    left: !!player.input.left,
                    right: !!player.input.right,
                    jump: !!player.input.jump,
                    shoot: !!player.input.shoot,
                    mouseX: player.input.mouseX ?? player.x,
                    mouseY: player.input.mouseY ?? player.y,
                    selectedSpell: player.input.selectedSpell ?? player.selectedSpell
                };
            }
            payload.players.push(data);
        }

        for (let i = 0; i < this.projectiles.length; i++) {
            const proj = this.projectiles[i];
            if (!proj) continue;
            const chunkKey = this.getChunkKeyForPosition(proj.x, proj.y);
            if (!shouldInclude(chunkKey)) continue;
            payload.projectiles.push({
                id: proj.serverId || null,
                chunkKey,
                x: proj.x,
                y: proj.y,
                vx: proj.vx,
                vy: proj.vy,
                type: proj.type,
                ownerId: proj.ownerId,
                lifetime: proj.lifetime,
                maxLifetime: proj.maxLifetime,
                dead: !!proj.dead,
                radius: proj.radius,
                mass: proj.mass
            });
        }

        return payload;
    }

    applyEntitySnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return;
        const playersData = Array.isArray(snapshot.players) ? snapshot.players : [];
        const projectilesData = Array.isArray(snapshot.projectiles) ? snapshot.projectiles : [];

        const playerMap = this.players;

        for (let i = 0; i < playersData.length; i++) {
            const data = playersData[i];
            if (!data || typeof data.id !== 'string') continue;
            let player = playerMap.get(data.id);
            if (!player) {
                player = this.addPlayer(data.id, data.x || 0, data.y || 0, data.selectedSpell || 0);
            }
            if (!player) continue;

            player.x = data.x;
            player.y = data.y;
            player.vx = data.vx || 0;
            player.vy = data.vy || 0;
            player.alive = data.alive !== undefined ? !!data.alive : player.alive;
            if (typeof data.health === 'number') player.health = data.health;
            if (typeof data.maxHealth === 'number') player.maxHealth = data.maxHealth;
            player.grounded = data.grounded !== undefined ? !!data.grounded : player.grounded;
            if (typeof data.aimAngle === 'number') player.aimAngle = data.aimAngle;
            if (data.selectedSpell !== undefined) player.selectedSpell = data.selectedSpell;
            if (typeof data.width === 'number') player.width = data.width;
            if (typeof data.height === 'number') player.height = data.height;
            if (data.facing !== undefined) player.facing = data.facing;

            if (data.input) {
                player.input = {
                    left: !!data.input.left,
                    right: !!data.input.right,
                    jump: !!data.input.jump,
                    shoot: !!data.input.shoot,
                    mouseX: typeof data.input.mouseX === 'number' ? data.input.mouseX : player.x,
                    mouseY: typeof data.input.mouseY === 'number' ? data.input.mouseY : player.y,
                    selectedSpell: typeof data.input.selectedSpell === 'number'
                        ? data.input.selectedSpell
                        : player.selectedSpell
                };
            }
        }

        const projectileById = new Map();
        for (let i = 0; i < this.projectiles.length; i++) {
            const proj = this.projectiles[i];
            if (proj && proj.serverId) {
                projectileById.set(proj.serverId, proj);
            }
        }

        for (let i = 0; i < projectilesData.length; i++) {
            const data = projectilesData[i];
            if (!data) continue;
            const id = data.id || null;
            let proj = id ? projectileById.get(id) : null;
            if (!proj) {
                proj = new Projectile(
                    data.x || 0,
                    data.y || 0,
                    data.vx || 0,
                    data.vy || 0,
                    data.type || 'fireball',
                    data.ownerId || null
                );
                if (id) {
                    proj.serverId = id;
                    projectileById.set(id, proj);
                }
                this.projectiles.push(proj);
            }

            proj.x = data.x || 0;
            proj.y = data.y || 0;
            proj.vx = data.vx || 0;
            proj.vy = data.vy || 0;
            proj.type = data.type || proj.type;
            proj.ownerId = data.ownerId || proj.ownerId;
            if (typeof data.lifetime === 'number') proj.lifetime = data.lifetime;
            if (typeof data.maxLifetime === 'number') proj.maxLifetime = data.maxLifetime;
            proj.dead = data.dead !== undefined ? !!data.dead : proj.dead;
            if (typeof data.radius === 'number') proj.radius = data.radius;
            if (typeof data.mass === 'number') proj.mass = data.mass;
        }
    }

    serializeTerrainChunksForKeys(keys, options = {}) {
        if (!keys || typeof keys[Symbol.iterator] !== 'function') {
            return null;
        }

        const terrain = this.terrain;
        if (!terrain || typeof terrain.serializeChunksForKeys !== 'function') {
            return null;
        }

        const requestedKeys = Array.from(keys);
        if (!requestedKeys.length) {
            return null;
        }

        const terrainChunkSize = Math.max(1, terrain.chunkSize || 1);
        const terrainWidth = Math.max(1, terrain.width || this.width || 0);
        const terrainHeight = Math.max(1, terrain.height || this.height || 0);
        const totalTerrainChunksX = Math.max(1, Math.ceil(terrainWidth / terrainChunkSize));
        const totalTerrainChunksY = Math.max(1, Math.ceil(terrainHeight / terrainChunkSize));
        const sourceChunkSize = (options && Number.isFinite(options.keyChunkSize) && options.keyChunkSize > 0)
            ? options.keyChunkSize
            : terrainChunkSize;

        const normalizeKey = (rawKey) => {
            if (rawKey === null || rawKey === undefined) return null;
            const parts = typeof rawKey === 'string' ? rawKey.split('|') : String(rawKey).split('|');
            if (parts.length !== 2) return null;
            let chunkX = parseInt(parts[0], 10);
            let chunkY = parseInt(parts[1], 10);
            if (Number.isNaN(chunkX) || Number.isNaN(chunkY)) return null;
            chunkX = ((chunkX % totalTerrainChunksX) + totalTerrainChunksX) % totalTerrainChunksX;
            chunkY = Math.max(0, Math.min(totalTerrainChunksY - 1, chunkY));
            return `${chunkX}|${chunkY}`;
        };

        const activeTerrainChunks = this.isServer
            ? this.getActiveTerrainChunkSet(terrainChunkSize)
            : null;

        if (sourceChunkSize === terrainChunkSize) {
            const filtered = [];
            for (let i = 0; i < requestedKeys.length; i++) {
                const normalizedKey = normalizeKey(requestedKeys[i]);
                if (!normalizedKey) continue;
                if (activeTerrainChunks && activeTerrainChunks.size && !activeTerrainChunks.has(normalizedKey)) {
                    continue;
                }
                filtered.push(normalizedKey);
            }
            if (filtered.length === 0) {
                return null;
            }
            return terrain.serializeChunksForKeys(new Set(filtered));
        }

        if (!this.terrainChunkRemapCache) {
            this.terrainChunkRemapCache = new Map();
        }
        const remapCache = this.terrainChunkRemapCache;
        if (remapCache.size > 4096) {
            remapCache.clear();
        }

        const normalizedKeys = new Set();

        for (let i = 0; i < requestedKeys.length; i++) {
            const normalizedKey = normalizeKey(requestedKeys[i]);
            if (!normalizedKey) continue;

            const remapKey = `${terrainChunkSize}:${sourceChunkSize}:${normalizedKey}`;
            let mapped = remapCache.get(remapKey);
            if (!mapped) {
                const [chunkXStr, chunkYStr] = normalizedKey.split('|');
                const chunkX = parseInt(chunkXStr, 10);
                const chunkY = parseInt(chunkYStr, 10);
                if (Number.isNaN(chunkX) || Number.isNaN(chunkY)) {
                    remapCache.set(remapKey, []);
                    continue;
                }

                const startWorldX = chunkX * sourceChunkSize;
                const startWorldY = chunkY * sourceChunkSize;
                const endWorldX = startWorldX + sourceChunkSize;
                const endWorldY = startWorldY + sourceChunkSize;

                const minChunkX = Math.floor(startWorldX / terrainChunkSize);
                const maxChunkX = Math.floor((endWorldX - 1) / terrainChunkSize);
                const minChunkY = Math.max(0, Math.floor(startWorldY / terrainChunkSize));
                const maxChunkY = Math.min(totalTerrainChunksY - 1, Math.floor((endWorldY - 1) / terrainChunkSize));

                if (minChunkY > maxChunkY) {
                    remapCache.set(remapKey, []);
                    continue;
                }

                const bucket = [];
                for (let cx = minChunkX; cx <= maxChunkX; cx++) {
                    const normalizedX = ((cx % totalTerrainChunksX) + totalTerrainChunksX) % totalTerrainChunksX;
                    for (let cy = minChunkY; cy <= maxChunkY; cy++) {
                        if (cy < 0 || cy >= totalTerrainChunksY) continue;
                        bucket.push(`${normalizedX}|${cy}`);
                    }
                }
                remapCache.set(remapKey, bucket);
                mapped = bucket;
            }

            if (!mapped || mapped.length === 0) {
                continue;
            }

            for (let j = 0; j < mapped.length; j++) {
                const candidate = mapped[j];
                if (activeTerrainChunks && activeTerrainChunks.size && !activeTerrainChunks.has(candidate)) {
                    continue;
                }
                normalizedKeys.add(candidate);
            }
        }

        if (normalizedKeys.size === 0) {
            return null;
        }

        return terrain.serializeChunksForKeys(normalizedKeys);
    }

    pullStaticTerrainUpdates(limit = 8) {
        if (!this.terrain || typeof this.terrain.collectStaticChunkUpdates !== 'function') {
            return null;
        }
        return this.terrain.collectStaticChunkUpdates(limit);
    }

    getActiveTerrainChunkSet(chunkSize) {
        if (!this.isServer) {
            return null;
        }
        if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
            return null;
        }
        if (!this.players || this.players.size === 0) {
            return null;
        }

        if (!this.activeTerrainChunkCache) {
            this.activeTerrainChunkCache = { tick: -1, chunkSize: 0, keys: null };
        }
        const cache = this.activeTerrainChunkCache;
        if (cache.tick === this.tick && cache.chunkSize === chunkSize && cache.keys instanceof Set) {
            return cache.keys;
        }

        const totalChunksX = Math.max(1, Math.ceil(this.width / chunkSize));
        const totalChunksY = Math.max(1, Math.ceil(this.height / chunkSize));
        const chunks = new Set();

        const players = this.playerList.length ? this.playerList : Array.from(this.players.values());
        if (!players.length) {
            cache.tick = this.tick;
            cache.chunkSize = chunkSize;
            cache.keys = chunks;
            return chunks;
        }

        const computeRadius = Math.max(0, Math.floor(this.playerChunkComputeRadius));
        const bufferRadius = Math.max(0, Math.floor(this.playerChunkBufferRadius));
        const combinedRadius = computeRadius + bufferRadius + 1;
        const pixelRadius = combinedRadius * this.chunkSize;
        const terrainRadius = Math.max(1, Math.ceil(pixelRadius / chunkSize));

        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            if (!player) continue;
            const normalizedX = Number.isFinite(player.x) ? player.x : 0;
            const clampedY = Number.isFinite(player.y)
                ? Math.max(0, Math.min(this.height - 1, player.y))
                : 0;
            const baseChunkX = Math.floor(normalizedX / chunkSize);
            const baseChunkY = Math.floor(clampedY / chunkSize);
            for (let dy = -terrainRadius; dy <= terrainRadius; dy++) {
                const chunkY = baseChunkY + dy;
                if (chunkY < 0 || chunkY >= totalChunksY) continue;
                for (let dx = -terrainRadius; dx <= terrainRadius; dx++) {
                    const chunkX = ((baseChunkX + dx) % totalChunksX + totalChunksX) % totalChunksX;
                    chunks.add(`${chunkX}|${chunkY}`);
                }
            }
        }

        cache.tick = this.tick;
        cache.chunkSize = chunkSize;
        cache.keys = chunks;
        return chunks;
    }

    clearSandChunks() {
        for (const key of Array.from(this.sandChunks.keys())) {
            this.removeSandChunkByKey(key);
        }
        this.sandChunks.clear();
        this.sandParticleCount = 0;
        this.activeSandLists.length = 0;
        this.activeSandChunkKeys.length = 0;
        this.activeSandLookup.length = 0;
        this.pendingFluidChunks.clear();
        this.pendingFluidCount = 0;
        this.lastFluidSpawnTick = -1;
    }

    removeSandChunkByKey(key) {
        const list = this.sandChunks.get(key);
        if (!list || list.length === 0) {
            this.sandChunks.delete(key);
            this.markSandChunkDirty(key);
            return;
        }

        const count = list.length;
        for (let i = 0; i < count; i++) {
            this.returnSandParticleToPool(list[i]);
        }

        this.sandParticleCount = Math.max(0, this.sandParticleCount - count);
        this.sandChunks.delete(key);
        this.markSandChunkDirty(key);
    }

    applySandSnapshot(snapshot, replaceAll = false) {
        if (!snapshot || !Array.isArray(snapshot.chunks)) {
            return;
        }

        if (typeof snapshot.chunkSize === 'number' && snapshot.chunkSize > 0 && snapshot.chunkSize !== this.chunkSize) {
            this.chunkSize = snapshot.chunkSize;
            if (this.terrain && typeof this.terrain.setChunkSize === 'function') {
                this.terrain.setChunkSize(this.chunkSize);
            }
        }

        const totalChunksX = Math.ceil(this.width / this.chunkSize);
        const maxChunkY = Math.ceil(this.height / this.chunkSize) - 1;

        const includeState = !!snapshot.includeState;
        const entries = snapshot.chunks;
        let pendingParticles = 0;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry || !Array.isArray(entry.particles)) continue;
            pendingParticles += entry.particles.length;
        }
        if (pendingParticles > 0) {
            this.ensureSandCapacity(this.sandParticleCount + pendingParticles);
        }

        let reachedSandCap = false;

        for (let i = 0; i < entries.length && !reachedSandCap; i++) {
            const entry = entries[i];
            if (!entry || !entry.key || !Array.isArray(entry.particles)) continue;

            const [chunkXString, chunkYString] = entry.key.split('|');
            let chunkX = parseInt(chunkXString, 10);
            let chunkY = parseInt(chunkYString, 10);
            if (Number.isNaN(chunkX) || Number.isNaN(chunkY)) continue;

            chunkY = Math.max(0, Math.min(maxChunkY, chunkY));
            chunkX = ((chunkX % totalChunksX) + totalChunksX) % totalChunksX;
            const normalizedKey = `${chunkX}|${chunkY}`;

            if (!replaceAll) {
                this.removeSandChunkByKey(normalizedKey);
            }

            const particles = entry.particles;
            if (!particles.length) continue;

            for (let j = 0; j < particles.length; j++) {
                if (this.sandParticleCount >= this.maxSandParticles) {
                    reachedSandCap = true;
                    break;
                }
                const data = particles[j];
                if (typeof data.x !== 'number' || typeof data.y !== 'number') continue;
                const material = typeof data.material === 'number' ? data.material : this.terrain.DIRT;
                const props = this.terrain.substances[material] || {};
                const massDefault = typeof props.density === 'number' ? props.density : 1;
                const isLiquidDefault = props.type === 'liquid';
                const sand = this.getSandParticleFromPool();
                const vx = typeof data.vx === 'number' ? data.vx : 0;
                const vy = typeof data.vy === 'number' ? data.vy : 0;
                sand.init(data.x, data.y, material, data.color || '#ffffff', 0, massDefault, isLiquidDefault);
                sand.vx = vx;
                sand.vy = vy;
                if (includeState) {
                    if (typeof data.restTime === 'number') sand.restTime = data.restTime;
                    if (typeof data.settleDelay === 'number') sand.settleDelay = data.settleDelay;
                    if (typeof data.drift === 'number') sand.drift = data.drift;
                    if (typeof data.mass === 'number') sand.mass = data.mass;
                    if (typeof data.isLiquid === 'boolean') sand.isLiquid = data.isLiquid;
                    if (typeof data.dead === 'boolean') sand.dead = data.dead;
                    if (typeof data.updateInterval === 'number') sand.updateInterval = data.updateInterval;
                    if (typeof data.nextUpdateTick === 'number') sand.nextUpdateTick = data.nextUpdateTick;
                    if (typeof data.activityLevel === 'number') sand.activityLevel = data.activityLevel;
                    if (typeof data.chunkPriority === 'number') sand.chunkPriority = data.chunkPriority;
                    if (typeof data.blobId === 'number') sand.blobId = data.blobId;
                    if (typeof data.lastBlobId === 'number') sand.lastBlobId = data.lastBlobId;
                }
                this.addSandToChunk(sand, chunkX, chunkY);
                this.sandParticleCount++;
            }
        }

        const dims = this.getViewDimensions();
        this.updateActiveChunks(dims.width, dims.height);
    }

    updateSandChunks(snapshot) {
        this.applySandSnapshot(snapshot, false);
    }

    loadSandChunks(snapshot) {
        this.clearSandChunks();

        this.applySandSnapshot(snapshot, true);
    }

    getParticleFromPool() {
        return this.particlePool.length > 0 ? this.particlePool.pop() : new Particle();
    }
    
    returnParticleToPool(particle) {
        particle.reset();
        if (this.particlePool.length < 500) {
            this.particlePool.push(particle);
        }
    }
    
    getState() {
        const sandSnapshot = this.serializeSandChunks(true);
        const terrainMods = this.terrain.getModifications();

        const state = {
            tick: this.tick,
            seed: this.seed,
            players: Array.from(this.players.values()).map(p => p.serialize()),
            projectiles: this.projectiles.map(p => p.serialize()),
            sand: this.sandParticleCount,
            chunkSize: this.chunkSize
        };

        if (sandSnapshot) {
            state.sandChunks = sandSnapshot;
        }

        if (terrainMods) {
            state.terrain = terrainMods;
        }

        return state;
    }

    setState(state) {
        this.tick = state.tick;
        if (typeof state.seed === 'number') {
            this.setSeed(state.seed);
        }
        
        // Update players
        for (const pData of state.players) {
            let player = this.players.get(pData.id);
            if (!player) {
                player = this.addPlayer(pData.id, pData.x, pData.y, pData.selectedSpell);
            }
            player.deserialize(pData);
        }
        
        // Remove disconnected players
        for (const [id, player] of this.players.entries()) {
            if (!state.players.find(p => p.id === id)) {
                this.removePlayer(id);
            }
        }
        
        if (state.chunkSize && state.chunkSize !== this.chunkSize) {
            this.chunkSize = state.chunkSize;
        }

        if (state.sandChunks && Array.isArray(state.sandChunks.chunks) && state.sandChunks.chunks.length) {
            this.loadSandChunks(state.sandChunks);
        } else if ((state.sandChunks && (!Array.isArray(state.sandChunks.chunks) || state.sandChunks.chunks.length === 0)) || (typeof state.sand === 'number' && state.sand === 0)) {
            this.clearSandChunks();
        }

        if (this.eigenSand) {
            this.eigenSand.reset();
        }

        if (state.terrain) {
            this.terrain.applyModifications(state.terrain);
        }

        // Sync projectiles and sand if needed
        // (In a real implementation, you'd do delta compression here)
    }

    setSeed(seed) {
        if (typeof seed !== 'number') return;
        const normalized = seed >>> 0;
        if (normalized === this.seed) return;
        this.seed = normalized;
        const fallbackRandom = this.random || null;
        this.random = typeof DeterministicRandom === 'function'
            ? new DeterministicRandom(this.seed)
            : fallbackRandom;
        if (this.terrain && this.random && typeof this.random.fork === 'function') {
            this.terrain.random = this.random.fork('terrain');
        }
        for (const player of this.playerList) {
            if (player && this.random && typeof this.random.fork === 'function') {
                player.random = this.random.fork(`player:${player.id}`);
            }
        }
        if (this.eigenSand) {
            this.eigenSand.reset();
        }
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.GameEngine = globalThis.GameEngine || GameEngine;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = GameEngine;
}
