/**
 * Terrain System - Procedural generation and destruction
 */

class Terrain {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        
        // Pixel data - each pixel stores material type
        this.pixels = new Uint8Array(width * height);
        
        // Material types
        this.EMPTY = 0;
        this.STONE = 1;
        this.DIRT = 2;
        this.GRASS = 3;
        this.BEDROCK = 4;
        
        // Color palette
        this.colors = {
            [this.EMPTY]: null,
            [this.STONE]: '#6b7280',
            [this.DIRT]: '#92633c',
            [this.GRASS]: '#4ade80',
            [this.BEDROCK]: '#1f2937'
        };
        
        // Render cache
        this.imageData = null;
        this.dirty = true;
        this.dirtyRegions = [];
    }
    
    generate() {
        // Generate terrain using Perlin-like noise
        const noise = new SimplexNoise();
        
        // Generate base terrain height
        for (let x = 0; x < this.width; x++) {
            const heightVariation = noise.noise2D(x * 0.005, 0) * 80;
            const baseHeight = this.height * 0.4 + heightVariation;
            
            for (let y = 0; y < this.height; y++) {
                const depth = y - baseHeight;
                
                if (depth < 0) {
                    // Air
                    this.setPixel(x, y, this.EMPTY);
                } else if (depth < 2) {
                    // Grass layer
                    this.setPixel(x, y, this.GRASS);
                } else if (depth < 25) {
                    // Dirt layer with some variation
                    const dirtNoise = noise.noise2D(x * 0.1, y * 0.1);
                    if (dirtNoise > 0.3) {
                        this.setPixel(x, y, this.STONE);
                    } else {
                        this.setPixel(x, y, this.DIRT);
                    }
                } else {
                    // Stone layer with caves
                    const caveNoise1 = noise.noise2D(x * 0.02, y * 0.02);
                    const caveNoise2 = noise.noise2D(x * 0.03 + 100, y * 0.03 + 100);
                    const cave = caveNoise1 * caveNoise2;
                    
                    if (cave > 0.15) {
                        this.setPixel(x, y, this.EMPTY);
                    } else {
                        this.setPixel(x, y, this.STONE);
                    }
                }
                
                // Bedrock at bottom
                if (y >= this.height - 3) {
                    this.setPixel(x, y, this.BEDROCK);
                }
            }
        }
        
        this.dirty = true;
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
        const chunks = [];
        const visited = new Set();
        
        centerX = Math.floor(centerX);
        centerY = Math.floor(centerY);
        
        // Remove pixels in radius
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = centerX + dx;
                const y = centerY + dy;
                
                if (dx * dx + dy * dy <= radius * radius) {
                    const material = this.getPixel(x, y);
                    if (material !== this.EMPTY && material !== this.BEDROCK) {
                        this.setPixel(x, y, this.EMPTY);
                        this.markDirty(x, y);
                    }
                }
            }
        }
        
        // Find disconnected chunks in affected area
        const searchRadius = radius + 10;
        for (let dy = -searchRadius; dy <= searchRadius; dy++) {
            for (let dx = -searchRadius; dx <= searchRadius; dx++) {
                const x = centerX + dx;
                const y = centerY + dy;
                
                if (this.getPixel(x, y) !== this.EMPTY && !visited.has(`${x},${y}`)) {
                    const chunk = this.floodFill(x, y, visited);
                    
                    // Only create chunks if disconnected from ground
                    if (chunk.pixels.length > 0 && chunk.pixels.length < 400 && !this.isGrounded(chunk)) {
                        chunks.push(chunk);
                        
                        // Remove from terrain
                        for (const px of chunk.pixels) {
                            this.setPixel(px.x, px.y, this.EMPTY);
                            this.markDirty(px.x, px.y);
                        }
                    }
                }
            }
        }
        
        return chunks;
    }
    
    floodFill(startX, startY, visited, maxSize = 400) {
        const stack = [{x: startX, y: startY}];
        const pixels = [];
        let minX = startX, maxX = startX, minY = startY, maxY = startY;
        
        while (stack.length > 0 && pixels.length < maxSize) {
            const {x, y} = stack.pop();
            const key = `${x},${y}`;
            
            if (visited.has(key)) continue;
            if (this.getPixel(x, y) === this.EMPTY || this.getPixel(x, y) === this.BEDROCK) continue;
            
            visited.add(key);
            const material = this.getPixel(x, y);
            pixels.push({x, y, material});
            
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
            
            // 4-way connectivity
            stack.push({x: x + 1, y});
            stack.push({x: x - 1, y});
            stack.push({x, y: y + 1});
            stack.push({x, y: y - 1});
        }
        
        return {
            pixels,
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1
        };
    }
    
    isGrounded(chunk) {
        // Check if chunk touches bedrock or extends to bottom
        for (const px of chunk.pixels) {
            if (px.y >= this.height - 4) return true;
            
            // Check neighbors for bedrock
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (this.getPixel(px.x + dx, px.y + dy) === this.BEDROCK) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
    
    markDirty(x, y) {
        this.dirty = true;
    }
    
    render(ctx, camX, camY, viewWidth, viewHeight, scale) {
        // Lazy render - only redraw when terrain changes
        if (this.dirty) {
            this.updateRenderCache(camX, camY, viewWidth, viewHeight);
            this.dirty = false;
        }
        
        if (this.imageData) {
            const startX = Math.max(0, Math.floor(camX));
            const startY = Math.max(0, Math.floor(camY));
            const endX = Math.min(this.width, Math.ceil(camX + viewWidth));
            const endY = Math.min(this.height, Math.ceil(camY + viewHeight));
            
            for (let y = startY; y < endY; y++) {
                for (let x = startX; x < endX; x++) {
                    const material = this.getPixel(x, y);
                    if (material === this.EMPTY) continue;
                    
                    const color = this.colors[material];
                    if (color) {
                        ctx.fillStyle = color;
                        ctx.fillRect(x * scale, y * scale, scale, scale);
                    }
                }
            }
        }
    }
    
    updateRenderCache(camX, camY, viewWidth, viewHeight) {
        // For large terrains, we render on-demand rather than caching entire terrain
        // This method is called when terrain is dirty
    }
    
    getModifications() {
        // For network sync - return list of modified pixels
        return [];
    }
}

/**
 * Simple noise generator for procedural terrain
 */
class SimplexNoise {
    constructor(seed = Math.random()) {
        this.seed = seed;
        this.perm = new Uint8Array(512);
        
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            p[i] = i;
        }
        
        // Shuffle
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
