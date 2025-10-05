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
        this.sandParticles = [];
        this.players = new Map();
        this.playerList = [];
        this.projectiles = [];
        this.particles = [];

        this.maxSandParticles = 6000;
        this.maxSandUpdatesPerFrame = 900;
        this.maxSandSpawnPerDestroy = 500;
        this.sandUpdateCursor = 0;
        
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
        this.sandPool = [];
        this.sandOccupancy = new Set();
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
    
    update(dt) {
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

    updateSand(dt) {
        const total = this.sandParticles.length;
        if (total === 0) return;

        const occupancy = this.sandOccupancy;
        occupancy.clear();

        for (let i = 0; i < total; i++) {
            const sand = this.sandParticles[i];
            if (!sand.dead) {
                occupancy.add(sand.key());
            }
        }

        const updates = Math.min(total, this.maxSandUpdatesPerFrame);
        if (updates === 0) return;

        this.sandUpdateCursor = this.sandUpdateCursor % total;
        let processed = 0;
        let scanned = 0;

        while (processed < updates && scanned < total) {
            const idx = (this.sandUpdateCursor + scanned) % total;
            scanned++;
            const sand = this.sandParticles[idx];
            if (sand.dead) continue;
            sand.update(this, occupancy, dt);
            processed++;
        }

        this.sandUpdateCursor = (this.sandUpdateCursor + scanned) % Math.max(1, this.sandParticles.length);

        for (let i = this.sandParticles.length - 1; i >= 0; i--) {
            const sand = this.sandParticles[i];
            if (!sand.dead) continue;
            this.returnSandParticleToPool(sand);
            const last = this.sandParticles.pop();
            if (i < this.sandParticles.length) {
                this.sandParticles[i] = last;
            }
        }

        if (this.sandParticles.length === 0) {
            this.sandUpdateCursor = 0;
        } else {
            this.sandUpdateCursor %= this.sandParticles.length;
        }
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

            for (const sand of this.sandParticles) {
                sand.render(ctx, scale);
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
        ctx.fillText(`Sand: ${this.sandParticles.length}`, 10, 40);
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

        if (this.sandParticles.length >= this.maxSandParticles) {
            return;
        }

        const availableSlots = this.maxSandParticles - this.sandParticles.length;
        const spawnCap = Math.min(this.maxSandSpawnPerDestroy, availableSlots);
        const spawnRatio = pixels.length > spawnCap ? spawnCap / pixels.length : 1;
        let spawned = 0;

        for (let i = 0; i < pixels.length; i++) {
            if (spawned >= spawnCap) break;
            if (Math.random() > spawnRatio) continue;

            const px = pixels[i];
            if (px.y < 0 || px.y >= this.height) continue;
            const wrappedX = wrapHorizontal(px.x, this.width);
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
            this.sandParticles.push(sand);
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
        return {
            tick: this.tick,
            players: Array.from(this.players.values()).map(p => p.serialize()),
            projectiles: this.projectiles.map(p => p.serialize()),
            sand: this.sandParticles.length,
            terrain: this.terrain.getModifications()
        };
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
        
        // Sync projectiles and sand if needed
        // (In a real implementation, you'd do delta compression here)
    }
}
