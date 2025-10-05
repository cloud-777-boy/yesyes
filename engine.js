/**
 * Pixel Physics Engine - Main Engine
 * Optimized for 64-player multiplayer with deterministic physics
 */

class GameEngine {
    constructor(canvas, isServer = false) {
        this.canvas = canvas;
        this.ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null;
        this.isServer = isServer;
        
        // Core systems
        this.width = 11200;
        this.height = 900;
        this.pixelSize = 6; // Render scale (zoomed-in view)
        
        this.terrain = null;
        this.chunkSize = 256;
        this.sandChunks = new Map();
        this.sandParticleCount = 0;
        this.sandPool = [];
        this.sandOccupancy = new Set();
        this.activeChunkSet = new Set();
        this.activeChunkKeys = [];
        this.activeSandLists = [];
        this.activeSandChunkKeys = [];
        this.activeSandLookup = [];
        this.maxSandParticles = 6000;
        this.maxSandUpdatesPerFrame = 900;
        this.maxSandSpawnPerDestroy = 500;
        this.sandUpdateCursor = 0;
        this.players = new Map();
        this.playerList = [];
        this.projectiles = [];
        this.particles = [];
        
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
        this.defaultViewWidth = 800;
        this.defaultViewHeight = 600;
        this.particlePool = [];
        
        // Camera
        this.cameraX = 0;
        this.cameraY = 0;
        
        this.running = false;
        this._boundLoop = this.loop.bind(this);
    }
    
    init() {
        // Initialize terrain
        this.terrain = new Terrain(this.width, this.height);
        this.terrain.generate();
        const fluids = this.terrain.consumeInitialFluids();
        this.spawnInitialFluids(fluids);
        this.sandChunks.clear();
        this.sandParticleCount = 0;
        this.sandUpdateCursor = 0;
        this.sandPool.length = 0;
        this.activeChunkSet.clear();
        this.activeChunkKeys.length = 0;
        this.activeSandLists.length = 0;
        this.activeSandChunkKeys.length = 0;
        this.activeSandLookup.length = 0;

        // Setup camera
        this.cameraX = this.width / 2;
        this.cameraY = this.height / 2;
    }
    
    addPlayer(id, x, y) {
        const player = new Player(id, x, y);
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

    updateActiveChunks(viewWidth, viewHeight) {
        const chunkSize = this.chunkSize;
        const totalChunksX = Math.ceil(this.width / chunkSize);
        const totalChunksY = Math.ceil(this.height / chunkSize);
        const radiusX = Math.max(chunkSize, viewWidth * this.sandViewRadiusMultiplier);
        const radiusY = Math.max(chunkSize, viewHeight * this.sandViewRadiusMultiplier);
        const chunkRadiusX = Math.ceil(radiusX / chunkSize);
        const chunkRadiusY = Math.ceil(radiusY / chunkSize);

        this.activeChunkSet.clear();

        const players = this.playerList.length ? this.playerList : Array.from(this.players.values());
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            const chunkX = Math.floor(player.x / chunkSize);
            const chunkY = Math.floor(player.y / chunkSize);
            for (let dx = -chunkRadiusX; dx <= chunkRadiusX; dx++) {
                for (let dy = -chunkRadiusY; dy <= chunkRadiusY; dy++) {
                    const wrappedChunkX = ((chunkX + dx) % totalChunksX + totalChunksX) % totalChunksX;
                    const clampedChunkY = Math.max(0, Math.min(totalChunksY - 1, chunkY + dy));
                    const key = `${wrappedChunkX}|${clampedChunkY}`;
                    this.activeChunkSet.add(key);
                }
            }
        }

        const camChunkX = Math.floor(this.cameraX / chunkSize);
        const camChunkY = Math.floor(this.cameraY / chunkSize);
        for (let dx = -chunkRadiusX; dx <= chunkRadiusX; dx++) {
            for (let dy = -chunkRadiusY; dy <= chunkRadiusY; dy++) {
                const wrappedChunkX = ((camChunkX + dx) % totalChunksX + totalChunksX) % totalChunksX;
                const clampedChunkY = Math.max(0, Math.min(totalChunksY - 1, camChunkY + dy));
                const key = `${wrappedChunkX}|${clampedChunkY}`;
                this.activeChunkSet.add(key);
            }
        }

        this.activeChunkKeys.length = 0;
        for (const key of this.activeChunkSet) {
            this.activeChunkKeys.push(key);
        }

        this.activeSandLists.length = 0;
        this.activeSandChunkKeys.length = 0;
        this.activeSandLookup.length = 0;

        for (let i = 0; i < this.activeChunkKeys.length; i++) {
            const key = this.activeChunkKeys[i];
            const list = this.sandChunks.get(key);
            if (list && list.length) {
                this.activeSandChunkKeys.push(key);
                this.activeSandLists.push(list);
                for (let j = 0; j < list.length; j++) {
                    const sand = list[j];
                    sand.chunkIndex = j;
                    this.activeSandLookup.push(sand);
                }
            }
        }
    }

    update(dt) {
        const { width: viewWidth, height: viewHeight } = this.getViewDimensions();
        this.updateActiveChunks(viewWidth, viewHeight);

        // Update players
        const players = this.playerList;
        for (let i = 0; i < players.length; i++) {
            players[i].update(dt, this);
        }
        
        // Update projectiles
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const proj = this.projectiles[i];
            proj.update(dt, this);
            
            if (proj.dead) {
                this.projectiles.splice(i, 1);
            }
        }
        
        // Update falling sand
        this.updateSand(dt);
        
        // Update particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const particle = this.particles[i];
            particle.update(dt, this.width);
            
            if (particle.dead) {
                this.returnParticleToPool(particle);
                this.particles.splice(i, 1);
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
        return list;
    }

    removeSandFromChunk(sand) {
        if (!sand.chunkKey) return;
        const list = this.sandChunks.get(sand.chunkKey);
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
            this.sandChunks.delete(sand.chunkKey);
        }
        sand.chunkX = -1;
        sand.chunkY = -1;
        sand.chunkKey = null;
        sand.chunkIndex = -1;
    }

    moveSandToChunk(sand, newChunkX, newChunkY) {
        const oldKey = sand.chunkKey;
        if (oldKey) {
            this.removeSandFromChunk(sand);
        }
        this.addSandToChunk(sand, newChunkX, newChunkY);
    }

    spawnInitialFluids(fluids) {
        if (!Array.isArray(fluids)) return;
        for (let i = 0; i < fluids.length; i++) {
            if (this.sandParticleCount >= this.maxSandParticles) break;
            const { x, y, material } = fluids[i];
            const sand = this.getSandParticleFromPool();
            const colorObj = this.terrain.getMaterialColor(material, x, y);
            const color = colorObj ? colorObj.hex : '#ffffff';
            sand.init(x, y, material, color, 0);
            const chunkX = Math.floor(x / this.chunkSize);
            const chunkY = Math.floor(y / this.chunkSize);
            this.addSandToChunk(sand, chunkX, chunkY);
            this.sandParticleCount++;
        }
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
            this.sandUpdateCursor = 0;
            return;
        }

        const occupancy = this.sandOccupancy;
        occupancy.clear();

        for (let i = 0; i < total; i++) {
            const sand = this.activeSandLookup[i];
            if (!sand.dead) {
                occupancy.add(sand.key());
            }
        }

        const updates = Math.min(total, this.maxSandUpdatesPerFrame);
        if (updates === 0) return;

        this.sandUpdateCursor %= total;
        let processed = 0;

        const chunkSize = this.chunkSize;
        const totalChunksX = Math.ceil(this.width / chunkSize);
        const totalChunksY = Math.ceil(this.height / chunkSize);

        while (processed < updates) {
            const idx = (this.sandUpdateCursor + processed) % total;
            const sand = this.activeSandLookup[idx];
            if (!sand.dead) {
                sand.update(this, occupancy, dt);
                const newChunkX = Math.floor(sand.x / chunkSize);
                let newChunkY = Math.floor(sand.y / chunkSize);
                newChunkY = Math.max(0, Math.min(totalChunksY - 1, newChunkY));
                const wrappedChunkX = ((newChunkX % totalChunksX) + totalChunksX) % totalChunksX;
                if (sand.chunkX !== wrappedChunkX || sand.chunkY !== newChunkY) {
                    this.moveSandToChunk(sand, wrappedChunkX, newChunkY);
                }
            }
            processed++;
        }

        this.sandUpdateCursor = (this.sandUpdateCursor + updates) % total;

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
            }
        }

        if (this.sandParticleCount < 0) {
            this.sandParticleCount = 0;
        }

        this.activeSandLookup.length = 0;
        this.activeSandLists.length = 0;
        this.activeSandChunkKeys.length = 0;
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
        ctx.fillText(`Players: ${this.players.size}`, 10, 20);
        ctx.fillText(`Sand: ${this.sandParticleCount}`, 10, 40);
        ctx.fillText(`Projectiles: ${this.projectiles.length}`, 10, 60);
        ctx.fillText(`Tick: ${this.tick}`, 10, 80);
    }
    
    spawnProjectile(x, y, vx, vy, type, ownerId) {
        const proj = new Projectile(wrapHorizontal(x, this.width), y, vx, vy, type, ownerId);
        this.projectiles.push(proj);
        return proj;
    }

    destroyTerrain(x, y, radius, explosive = false) {
        const wrappedX = wrapHorizontal(x, this.width);
        const chunks = this.terrain.destroy(wrappedX, y, radius);

        for (const chunkData of chunks) {
            this.spawnSandFromPixels(chunkData, wrappedX, y, explosive);
        }
    }

    spawnSandFromPixels(chunkData, originX, originY, explosive) {
        if (!chunkData || !chunkData.pixels || chunkData.pixels.length === 0) {
            return;
        }

        const pixels = chunkData.pixels;
        const explosionFalloff = explosive ? 1 : 0;

        if (this.sandParticleCount >= this.maxSandParticles) {
            return;
        }

        const availableSlots = this.maxSandParticles - this.sandParticleCount;
        const spawnCap = Math.min(this.maxSandSpawnPerDestroy, availableSlots);
        const spawnRatio = pixels.length > spawnCap ? spawnCap / pixels.length : 1;
        let spawned = 0;

        if (spawnCap <= 0) {
            return;
        }

        for (let i = 0; i < pixels.length; i++) {
            if (spawned >= spawnCap) break;
            if (Math.random() > spawnRatio) continue;

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
            } else if (Math.random() < 0.2) {
                drift = Math.random() < 0.5 ? -1 : 1;
            }

            sand.init(wrappedX, px.y, px.material, color, drift * explosionFalloff || drift);
            const chunkX = Math.floor(wrappedX / this.chunkSize);
            const chunkY = Math.floor(px.y / this.chunkSize);
            this.addSandToChunk(sand, chunkX, chunkY);
            this.sandParticleCount++;
            spawned++;
        }
    }

    spawnParticles(x, y, count, color) {
        for (let i = 0; i < count; i++) {
            const particle = this.getParticleFromPool();
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 3 + 1;
            const px = wrapHorizontal(x, this.width);
            particle.init(px, y, Math.cos(angle) * speed, Math.sin(angle) * speed, color);
            this.particles.push(particle);
        }
    }
    
    // Object pooling
    getSandParticleFromPool() {
        return this.sandPool.length > 0 ? this.sandPool.pop() : new SandParticle();
    }

    returnSandParticleToPool(sand) {
        sand.reset();
        if (this.sandPool.length < 5000) {
            this.sandPool.push(sand);
        }
    }

    serializeSandChunks(activeOnly = false) {
        const payload = {
            chunkSize: this.chunkSize,
            chunks: []
        };

        if (activeOnly) {
            if (this.activeSandLists.length === 0) {
                for (const [key, list] of this.sandChunks.entries()) {
                    if (!list.length) continue;
                    payload.chunks.push({
                        key,
                        particles: list.map(p => ({ x: p.x, y: p.y, material: p.material, color: p.color }))
                    });
                }
            } else {
                for (let i = 0; i < this.activeSandLists.length; i++) {
                    const key = this.activeSandChunkKeys[i];
                    const list = this.activeSandLists[i];
                    if (!list.length) continue;
                    payload.chunks.push({
                        key,
                        particles: list.map(p => ({ x: p.x, y: p.y, material: p.material, color: p.color }))
                    });
                }
            }
        } else {
            for (const [key, list] of this.sandChunks.entries()) {
                if (!list.length) continue;
                payload.chunks.push({
                    key,
                    particles: list.map(p => ({ x: p.x, y: p.y, material: p.material, color: p.color }))
                });
            }
        }

        return payload.chunks.length ? payload : null;
    }

    clearSandChunks() {
        for (const list of this.sandChunks.values()) {
            for (let i = 0; i < list.length; i++) {
                this.returnSandParticleToPool(list[i]);
            }
        }
        this.sandChunks.clear();
        this.sandParticleCount = 0;
        this.activeSandLists.length = 0;
        this.activeSandChunkKeys.length = 0;
        this.activeSandLookup.length = 0;
    }

    loadSandChunks(snapshot) {
        this.clearSandChunks();

        if (snapshot.chunkSize && snapshot.chunkSize !== this.chunkSize) {
            this.chunkSize = snapshot.chunkSize;
        }

        const totalChunksX = Math.ceil(this.width / this.chunkSize);
        const maxChunkY = Math.ceil(this.height / this.chunkSize) - 1;
        const entries = snapshot.chunks || [];

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry || !entry.key || !Array.isArray(entry.particles)) continue;
            const [chunkXString, chunkYString] = entry.key.split('|');
            let chunkX = parseInt(chunkXString, 10);
            let chunkY = parseInt(chunkYString, 10);
            if (Number.isNaN(chunkX) || Number.isNaN(chunkY)) continue;

            chunkY = Math.max(0, Math.min(maxChunkY, chunkY));
            chunkX = ((chunkX % totalChunksX) + totalChunksX) % totalChunksX;

            const particles = entry.particles;
            for (let j = 0; j < particles.length; j++) {
                const data = particles[j];
                if (typeof data.x !== 'number' || typeof data.y !== 'number') continue;
                const sand = this.getSandParticleFromPool();
                sand.init(data.x, data.y, data.material || this.terrain.DIRT, data.color || '#ffffff', 0);
                this.addSandToChunk(sand, chunkX, chunkY);
                this.sandParticleCount++;
            }
        }

        const dims = this.getViewDimensions();
        this.updateActiveChunks(dims.width, dims.height);
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
        
        // Update players
        for (const pData of state.players) {
            let player = this.players.get(pData.id);
            if (!player) {
                player = this.addPlayer(pData.id, pData.x, pData.y);
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

        if (state.terrain) {
            this.terrain.applyModifications(state.terrain);
        }

        // Sync projectiles and sand if needed
        // (In a real implementation, you'd do delta compression here)
    }
}
