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
        this.width = 1600;
        this.height = 900;
        this.pixelSize = 2; // Render scale for performance
        
        this.terrain = null;
        this.chunks = [];
        this.players = new Map();
        this.projectiles = [];
        this.particles = [];
        
        // Physics settings (deterministic)
        this.gravity = 0.3;
        this.fixedTimeStep = 1000 / 60; // 60 FPS fixed timestep
        this.accumulator = 0;
        this.lastTime = 0;
        
        // Multiplayer
        this.tick = 0;
        this.playerId = null;
        
        // Performance
        this.chunkPool = [];
        this.particlePool = [];
        
        // Camera
        this.cameraX = 0;
        this.cameraY = 0;
        
        this.running = false;
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
        return player;
    }
    
    removePlayer(id) {
        this.players.delete(id);
    }
    
    start() {
        this.running = true;
        this.lastTime = performance.now();
        this.loop();
    }
    
    stop() {
        this.running = false;
    }
    
    loop() {
        if (!this.running) return;
        
        const currentTime = performance.now();
        const deltaTime = currentTime - this.lastTime;
        this.lastTime = currentTime;
        
        this.accumulator += deltaTime;
        
        // Fixed timestep updates for deterministic physics
        while (this.accumulator >= this.fixedTimeStep) {
            this.update(this.fixedTimeStep);
            this.accumulator -= this.fixedTimeStep;
            this.tick++;
        }
        
        if (!this.isServer) {
            this.render();
        }
        
        requestAnimationFrame(() => this.loop());
    }
    
    update(dt) {
        // Update players
        for (const player of this.players.values()) {
            player.update(dt, this);
        }
        
        // Update projectiles
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const proj = this.projectiles[i];
            proj.update(dt, this);
            
            if (proj.dead) {
                this.projectiles.splice(i, 1);
            }
        }
        
        // Update physics chunks
        for (let i = this.chunks.length - 1; i >= 0; i--) {
            const chunk = this.chunks[i];
            chunk.update(dt, this);
            
            if (chunk.shouldRemove()) {
                this.returnChunkToPool(chunk);
                this.chunks.splice(i, 1);
            }
        }
        
        // Update particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const particle = this.particles[i];
            particle.update(dt);
            
            if (particle.dead) {
                this.returnParticleToPool(particle);
                this.particles.splice(i, 1);
            }
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
        const camX = Math.floor(this.cameraX - this.canvas.width / (2 * scale));
        const camY = Math.floor(this.cameraY - this.canvas.height / (2 * scale));
        ctx.translate(-camX * scale, -camY * scale);
        
        // Render terrain
        this.terrain.render(ctx, camX, camY, this.canvas.width / scale, this.canvas.height / scale, scale);
        
        // Render chunks
        for (const chunk of this.chunks) {
            chunk.render(ctx, scale);
        }
        
        // Render projectiles
        for (const proj of this.projectiles) {
            proj.render(ctx, scale);
        }
        
        // Render particles
        for (const particle of this.particles) {
            particle.render(ctx, scale);
        }
        
        // Render players
        for (const player of this.players.values()) {
            player.render(ctx, scale);
        }
        
        ctx.restore();
        
        // UI
        this.renderUI(ctx);
    }
    
    renderUI(ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.font = '14px monospace';
        ctx.fillText(`Players: ${this.players.size}`, 10, 20);
        ctx.fillText(`Chunks: ${this.chunks.length}`, 10, 40);
        ctx.fillText(`Projectiles: ${this.projectiles.length}`, 10, 60);
        ctx.fillText(`Tick: ${this.tick}`, 10, 80);
    }
    
    spawnProjectile(x, y, vx, vy, type, ownerId) {
        const proj = new Projectile(x, y, vx, vy, type, ownerId);
        this.projectiles.push(proj);
        return proj;
    }
    
    destroyTerrain(x, y, radius, explosive = false) {
        const chunks = this.terrain.destroy(x, y, radius);
        
        // Create physics chunks from destroyed terrain
        for (const chunkData of chunks) {
            const chunk = this.getChunkFromPool();
            chunk.init(chunkData.pixels, chunkData.x, chunkData.y, chunkData.width, chunkData.height);
            
            if (explosive) {
                const angle = Math.atan2(chunkData.y + chunkData.height / 2 - y, chunkData.x + chunkData.width / 2 - x);
                const dist = Math.sqrt((chunkData.x - x) ** 2 + (chunkData.y - y) ** 2);
                const force = Math.max(0, 1 - dist / (radius * 2));
                chunk.vx = Math.cos(angle) * force * 8;
                chunk.vy = Math.sin(angle) * force * 8 - 2;
            }
            
            this.chunks.push(chunk);
        }
    }
    
    spawnParticles(x, y, count, color) {
        for (let i = 0; i < count; i++) {
            const particle = this.getParticleFromPool();
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 3 + 1;
            particle.init(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, color);
            this.particles.push(particle);
        }
    }
    
    // Object pooling
    getChunkFromPool() {
        return this.chunkPool.length > 0 ? this.chunkPool.pop() : new PhysicsChunk();
    }
    
    returnChunkToPool(chunk) {
        chunk.reset();
        if (this.chunkPool.length < 100) {
            this.chunkPool.push(chunk);
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
            chunks: this.chunks.map(c => c.serialize()),
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
        
        // Sync projectiles and chunks if needed
        // (In a real implementation, you'd do delta compression here)
    }
}
