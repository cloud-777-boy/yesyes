/**
 * Wrap a horizontal value into the range [0, width).
 * Using Math.floor ensures negative values wrap correctly.
 */
function wrapHorizontal(value, width) {
    if (width <= 0) return value;
    let wrapped = value % width;
    if (wrapped < 0) wrapped += width;
    return wrapped;
}

function shortestWrappedDelta(a, b, width) {
    if (width <= 0) return a - b;
    let delta = a - b;
    if (delta > width / 2) {
        delta -= width;
    } else if (delta < -width / 2) {
        delta += width;
    }
    return delta;
}

if (typeof globalThis !== 'undefined') {
    globalThis.wrapHorizontal = wrapHorizontal;
    globalThis.shortestWrappedDelta = shortestWrappedDelta;
}

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
        this.GOLD = 5;
        this.SILVER = 6;
        this.IRON = 7;
        this.WATER = 8;
        this.LAVA = 9;
        
        // Base palette fallback
        this.colors = {
            [this.EMPTY]: null,
            [this.STONE]: '#6b7280',
            [this.DIRT]: '#92633c',
            [this.GRASS]: '#4ade80',
            [this.BEDROCK]: '#1f2937',
            [this.GOLD]: '#facc15',
            [this.SILVER]: '#d1d5db',
            [this.IRON]: '#9ca3af'
        };

        this.palettes = {
            [this.GRASS]: ['#3fd473', '#49e07f', '#36c96a', '#58e78d'],
            [this.DIRT]: ['#8f5b34', '#99603a', '#a26844', '#845230'],
            [this.STONE]: ['#5d6774', '#6b7280', '#5c6570', '#747c8a'],
            [this.GOLD]: ['#facc15', '#fbbf24', '#fbbf0f', '#f5d547'],
            [this.SILVER]: ['#cbd5f5', '#d1d5db', '#bfc6d3', '#e0e5ef'],
            [this.IRON]: ['#8d99a6', '#9ca3af', '#7d8895', '#a8b1bd'],
            [this.BEDROCK]: ['#111827', '#1f2937', '#0f172a', '#1a2333'],
            [this.WATER]: ['#1e3a8a', '#2563eb', '#1d4ed8', '#3b82f6'],
            [this.LAVA]: ['#dc2626', '#f97316', '#f43f5e', '#fb923c']
        };

        this.substances = {
            [this.EMPTY]: { name: 'empty', durability: 0, density: 0, degradeTo: null, raiseOnContact: false, type: 'empty' },
            [this.GRASS]: { name: 'grass', durability: 1, density: 1, degradeTo: this.EMPTY, raiseOnContact: true, type: 'solid' },
            [this.DIRT]: { name: 'dirt', durability: 2, density: 2, degradeTo: this.GRASS, raiseOnContact: true, type: 'granular' },
            [this.STONE]: { name: 'stone', durability: 4, density: 3, degradeTo: this.DIRT, raiseOnContact: true, type: 'solid' },
            [this.GOLD]: { name: 'gold', durability: 5, density: 4, degradeTo: this.STONE, raiseOnContact: true, type: 'solid' },
            [this.SILVER]: { name: 'silver', durability: 6, density: 4, degradeTo: this.STONE, raiseOnContact: true, type: 'solid' },
            [this.IRON]: { name: 'iron', durability: 7, density: 5, degradeTo: this.STONE, raiseOnContact: true, type: 'solid' },
            [this.BEDROCK]: { name: 'bedrock', durability: Infinity, density: 10, degradeTo: null, raiseOnContact: false, type: 'solid' },
            [this.WATER]: { name: 'water', durability: 0, density: 1, degradeTo: null, raiseOnContact: false, type: 'liquid', mixWith: this.LAVA, mixResult: this.STONE },
            [this.LAVA]: { name: 'lava', durability: 0, density: 1, degradeTo: null, raiseOnContact: false, type: 'liquid', mixWith: this.WATER, mixResult: this.STONE }
        };
        
        // Render cache
        this.imageData = null;
        this.pixelColors32 = null;
        this.dirty = true;
        this.offscreenCanvas = null;
        this.offscreenCtx = null;
        this.colorCache = new Map();
        this.surfaceCache = new Int16Array(width);
        this.surfaceCache.fill(height);
        this.dirtyBounds = null;
        this.isLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
        this.fullRedrawNeeded = true;
        this.chunkSize = 64;
        this.chunkWidth = Math.ceil(width / this.chunkSize);
        this.chunkHeight = Math.ceil(height / this.chunkSize);
        this.modifiedChunks = new Map();
        this.suppressModificationTracking = false;
        this.caves = [];
        this.initialFluids = [];
        this.generating = false;
    }

    setChunkSize(size) {
        const newSize = Math.max(1, Math.floor(size));
        if (newSize === this.chunkSize) return;
        this.chunkSize = newSize;
        this.chunkWidth = Math.ceil(this.width / this.chunkSize);
        this.chunkHeight = Math.ceil(this.height / this.chunkSize);
        this.modifiedChunks.clear();
    }
    
    generate() {
        // Generate terrain using Perlin-like noise
        const noise = new SimplexNoise();
        if (this.surfaceCache) {
            this.surfaceCache.fill(this.height);
        }
        this.caves.length = 0;
        this.initialFluids.length = 0;
        this.suppressModificationTracking = true;
        this.generating = true;

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
                    // Stone layer with ores, liquids, and caves
                    const caveNoise1 = noise.noise2D(x * 0.02, y * 0.02);
                    const caveNoise2 = noise.noise2D(x * 0.03 + 100, y * 0.03 + 100);
                    const cave = caveNoise1 * caveNoise2;
                    const oreNoise = noise.noise2D(x * 0.04 + 200, y * 0.04 + 200);
                    const liquidNoise = noise.noise2D(x * 0.01 + 300, y * 0.01 + 300);

                    if (cave > 0.15) {
                        this.setPixel(x, y, this.EMPTY);
                    } else if (liquidNoise < -0.7 && depth > 30) {
                        this.setPixel(x, y, this.WATER);
                    } else if (liquidNoise > 0.7 && depth > 60) {
                        this.setPixel(x, y, this.LAVA);
                    } else if (oreNoise > 0.55 && depth > 40) {
                        this.setPixel(x, y, this.IRON);
                    } else if (oreNoise < -0.6 && depth > 60) {
                        this.setPixel(x, y, this.SILVER);
                    } else if (Math.abs(oreNoise) > 0.7 && depth > 70) {
                        this.setPixel(x, y, this.GOLD);
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

        this.generateCaves();
        this.generateSurfaceLakes();
        this.generateSurfaceLakes();

        this.dirty = true;
        this.dirtyBounds = {
            minX: 0,
            minY: 0,
            maxX: this.width - 1,
            maxY: this.height - 1
        };
        this.fullRedrawNeeded = true;
        this.modifiedChunks.clear();
        this.suppressModificationTracking = false;
        this.generating = false;
    }

    generateSurfaceLakes() {
        if (this.height < 20) return;
        let seed = Math.max(1, Math.abs(Math.floor(Math.sin(this.width * 0.5123 + this.height * 0.913) * 100000)));
        const rand = () => {
            const value = Math.sin(seed++) * 43758.5453123;
            return value - Math.floor(value);
        };

        const lakeCount = 1 + Math.floor(rand() * 3);
        const attempts = lakeCount * 4;
        let created = 0;

        for (let i = 0; i < attempts && created < lakeCount; i++) {
            const cx = Math.floor(rand() * this.width);
            const surfaceY = this.findSurfaceY(cx);
            if (surfaceY < 4 || surfaceY > this.height - 20) continue;
            const radiusX = 14 + rand() * 18;
            const radiusY = 5 + rand() * 9;
            const basinTop = surfaceY + 1;
            const basinBottom = Math.min(this.height - 4, surfaceY + radiusY * 2.0);

            for (let y = basinTop; y <= basinBottom; y++) {
                for (let x = Math.floor(cx - radiusX); x <= Math.floor(cx + radiusX); x++) {
                    const wrappedX = Math.floor(wrapHorizontal(x, this.width));
                    const dx = (wrappedX - cx) / radiusX;
                    const dy = (y - surfaceY) / radiusY;
                    if (dx * dx + dy * dy <= 1.2) {
                        this.setPixel(wrappedX, y, this.EMPTY);
                    }
                }
            }

            const fillStart = Math.floor(surfaceY + radiusY * 0.25);
            const fillEnd = Math.min(this.height - 4, surfaceY + radiusY * 1.1);
            for (let y = fillStart; y <= fillEnd; y++) {
                for (let x = Math.floor(cx - radiusX * 0.9); x <= Math.floor(cx + radiusX * 0.9); x++) {
                    const wrappedX = Math.floor(wrapHorizontal(x, this.width));
                    const dx = (wrappedX - cx) / (radiusX * 0.9);
                    const dy = (y - fillStart) / (radiusY * 0.8);
                    if (dx * dx + dy * dy <= 1.0) {
                        this.setPixel(wrappedX, y, this.WATER);
                    }
                }
            }
            created++;
        }
    }

    findSurfaceY(x) {
        const wrappedX = Math.floor(wrapHorizontal(x, this.width));
        for (let y = 0; y < this.height - 2; y++) {
            if (this.pixels[y * this.width + wrappedX] !== this.EMPTY) {
                return y;
            }
        }
        return this.height - 3;
    }

    setPixel(x, y, material) {
        if (y < 0 || y >= this.height) return;
        const wrappedX = Math.floor(wrapHorizontal(x, this.width));
        const index = y * this.width + wrappedX;
        const previous = this.pixels[index];

        const isFluid = material === this.WATER || material === this.LAVA;
        let nextMaterial = material;
        if (this.generating && isFluid) {
            this.initialFluids.push({ x: wrappedX, y, material });
            nextMaterial = this.EMPTY;
        }

        if (previous === nextMaterial) return;

        this.pixels[index] = nextMaterial;

        if (this.pixelColors32) {
            const color = this.getMaterialColor(nextMaterial, wrappedX, y);
            this.pixelColors32[index] = color ? color.rgba32 : 0;
        }

        this.updateSurfaceColumn(wrappedX, y, nextMaterial, previous);
        if (!this.suppressModificationTracking) {
            this.markChunkModified(wrappedX, y);
        }
    }

    getPixel(x, y) {
        if (y < 0 || y >= this.height) return this.BEDROCK;
        const wrappedX = Math.floor(wrapHorizontal(x, this.width));
        return this.pixels[y * this.width + wrappedX];
    }
    
    isSolid(x, y) {
        const pixel = this.getPixel(Math.floor(x), Math.floor(y));
        if (pixel === this.EMPTY) return false;
        const props = this.substances[pixel];
        if (props && props.type === 'liquid') return false;
        return true;
    }

    isGranular(x, y) {
        const material = this.getPixel(x, y);
        if (material === this.EMPTY || material === this.BEDROCK) {
            return false;
        }
        const props = this.substances[material];
        return props ? !!props.raiseOnContact : false;
    }

    isLiquid(x, y) {
        const material = this.getPixel(x, y);
        if (material === this.EMPTY || material === this.BEDROCK) {
            return false;
        }
        const props = this.substances[material];
        return props ? props.type === 'liquid' : false;
    }
    
    destroy(centerX, centerY, radius) {
        const chunks = [];
        const visited = new Set();
        
        centerX = Math.floor(centerX);
        centerY = Math.floor(centerY);
        
        let dirtyMinX = Infinity;
        let dirtyMinY = Infinity;
        let dirtyMaxX = -Infinity;
        let dirtyMaxY = -Infinity;
        let underflowMinX = Infinity;
        let underflowMaxX = -Infinity;
        let overflowMinX = Infinity;
        let overflowMaxX = -Infinity;

        // Helper to expand dirty bounds without function allocation inside loops.
        const extendDirtyBounds = (x, y) => {
            if (x < dirtyMinX) dirtyMinX = x;
            if (x > dirtyMaxX) dirtyMaxX = x;
            if (y < dirtyMinY) dirtyMinY = y;
            if (y > dirtyMaxY) dirtyMaxY = y;
        };

        // Remove pixels in radius
        const radiusSq = radius * radius;
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = centerX + dx;
                const y = centerY + dy;

                const distSq = dx * dx + dy * dy;
                if (distSq > radiusSq) continue;

                const material = this.getPixel(x, y);
                if (material === this.EMPTY || material === this.BEDROCK) continue;

                const props = this.substances[material] || this.substances[this.STONE];
                const distance = Math.sqrt(distSq);
                const impact = Math.max(0, radius - distance);

                const wrappedX = Math.floor(wrapHorizontal(x, this.width));
                if (impact >= props.durability || props.durability === 0) {
                    this.setPixel(x, y, this.EMPTY);
                    extendDirtyBounds(wrappedX, y);
                    if (x < 0) {
                        if (x < underflowMinX) underflowMinX = x;
                        if (x > underflowMaxX) underflowMaxX = x;
                    } else if (x >= this.width) {
                        if (x < overflowMinX) overflowMinX = x;
                        if (x > overflowMaxX) overflowMaxX = x;
                    }
                } else if (impact >= props.durability * 0.5 && props.degradeTo !== null && props.degradeTo !== undefined) {
                    this.setPixel(x, y, props.degradeTo);
                    extendDirtyBounds(wrappedX, y);
                }
            }
        }
        
        // Find disconnected chunks in affected area
        const searchRadius = radius + 10;
        for (let dy = -searchRadius; dy <= searchRadius; dy++) {
            for (let dx = -searchRadius; dx <= searchRadius; dx++) {
                const x = centerX + dx;
                const y = centerY + dy;
                
                const wrappedX = Math.floor(wrapHorizontal(x, this.width));
                const visitKey = `${wrappedX},${y}`;
                if (this.getPixel(wrappedX, y) !== this.EMPTY && !visited.has(visitKey)) {
                    const chunk = this.floodFill(wrappedX, y, visited, 400, x);
                    
                    // Only create chunks if disconnected from ground
                    if (chunk.pixels.length > 0 && chunk.pixels.length < 400 && !this.isGrounded(chunk)) {
                        chunks.push(chunk);
                        
                        // Remove from terrain
                        for (const px of chunk.pixels) {
                            this.setPixel(px.x, px.y, this.EMPTY);
                            extendDirtyBounds(Math.floor(wrapHorizontal(px.x, this.width)), px.y);
                        }
                    }
                }
            }
        }
        
        if (dirtyMinX !== Infinity) {
            this.markDirtyRegion(dirtyMinX, dirtyMinY, dirtyMaxX, dirtyMaxY);
        }

        if (underflowMaxX !== -Infinity) {
            const start = Math.floor(wrapHorizontal(underflowMinX, this.width));
            const end = Math.floor(wrapHorizontal(underflowMaxX, this.width));
            if (start <= end) {
                this.markDirtyRegion(start, dirtyMinY, end, dirtyMaxY);
            }
        }

        if (overflowMaxX !== -Infinity) {
            const start = Math.floor(wrapHorizontal(overflowMinX, this.width));
            const end = Math.floor(wrapHorizontal(overflowMaxX, this.width));
            if (start <= end) {
                this.markDirtyRegion(start, dirtyMinY, end, dirtyMaxY);
            }
        }

        this.healVerticalSeams(centerX, centerY, radius + 6);

        return chunks;
    }

    healVerticalSeams(centerX, centerY, radius) {
        const width = this.width;
        const height = this.height;
        if (width <= 0 || height <= 0) return;

        const minX = Math.floor(centerX - radius - 2);
        const maxX = Math.ceil(centerX + radius + 2);
        const minY = Math.max(0, Math.floor(centerY - radius - 16));
        const maxY = Math.min(height - 1, Math.ceil(centerY + radius + 16));

        const chooseFiller = (leftMat, rightMat) => {
            const isSolid = (mat) => {
                if (mat === this.EMPTY || mat === this.BEDROCK || mat == null) return false;
                const props = this.substances[mat];
                return props && props.type === 'solid';
            };

            const leftSolid = isSolid(leftMat) ? leftMat : null;
            const rightSolid = isSolid(rightMat) ? rightMat : null;
            if (!leftSolid && !rightSolid) return null;
            if (leftSolid && rightSolid) {
                if (leftSolid === rightSolid) return leftSolid;
                const leftDensity = (this.substances[leftSolid] && this.substances[leftSolid].density) || 0;
                const rightDensity = (this.substances[rightSolid] && this.substances[rightSolid].density) || 0;
                return leftDensity >= rightDensity ? leftSolid : rightSolid;
            }
            return leftSolid || rightSolid;
        };

        for (let unwrappedX = minX; unwrappedX <= maxX; unwrappedX++) {
            const wrappedX = Math.floor(wrapHorizontal(unwrappedX, width));
            let y = minY;
            while (y <= maxY) {
                while (y <= maxY && this.getPixel(wrappedX, y) !== this.EMPTY) {
                    y++;
                }
                if (y > maxY) break;

                const startY = y;
                while (y <= maxY && this.getPixel(wrappedX, y) === this.EMPTY) {
                    y++;
                }
                const endY = y - 1;
                const spanHeight = endY - startY + 1;
                if (spanHeight <= 0) continue;

                // Skip very large gaps (likely intended caves or open sky)
                if (spanHeight > Math.max(radius * 2, 120)) {
                    continue;
                }

                const leftX = (wrappedX - 1 + width) % width;
                const rightX = (wrappedX + 1) % width;
                const leftMat = this.getPixel(leftX, startY);
                const rightMat = this.getPixel(rightX, startY);
                const filler = chooseFiller(leftMat, rightMat);
                if (!filler) {
                    continue;
                }

                // Avoid filling through liquids
                const fillerProps = this.substances[filler] || {};
                if (fillerProps.type !== 'solid') continue;

                for (let fillY = startY; fillY <= endY; fillY++) {
                    this.setPixel(unwrappedX, fillY, filler);
                }
            }
        }
    }

    floodFill(startX, startY, visited, maxSize = 400, startUnwrappedX = startX) {
        const initialWrapped = Math.floor(wrapHorizontal(startX, this.width));
        const stack = [{ wrappedX: initialWrapped, y: startY, unwrappedX: startUnwrappedX }];
        const pixels = [];

        let minX = startUnwrappedX;
        let maxX = startUnwrappedX;
        let minY = startY;
        let maxY = startY;

        while (stack.length > 0 && pixels.length < maxSize) {
            const { wrappedX, y, unwrappedX } = stack.pop();
            const key = `${wrappedX},${y}`;

            if (visited.has(key)) continue;

            const material = this.getPixel(wrappedX, y);
            if (material === this.EMPTY || material === this.BEDROCK) continue;

            visited.add(key);
            pixels.push({ x: unwrappedX, y, material });

            if (unwrappedX < minX) minX = unwrappedX;
            if (unwrappedX > maxX) maxX = unwrappedX;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            const rightUnwrapped = unwrappedX + 1;
            const leftUnwrapped = unwrappedX - 1;

            stack.push({
                wrappedX: Math.floor(wrapHorizontal(rightUnwrapped, this.width)),
                y,
                unwrappedX: rightUnwrapped
            });
            stack.push({
                wrappedX: Math.floor(wrapHorizontal(leftUnwrapped, this.width)),
                y,
                unwrappedX: leftUnwrapped
            });
            stack.push({ wrappedX, y: y + 1, unwrappedX });
            stack.push({ wrappedX, y: y - 1, unwrappedX });
        }

        return {
            pixels,
            x: minX,
            y: minY,
            width: Math.round(maxX - minX + 1),
            height: Math.round(maxY - minY + 1)
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
        this.markDirtyRegion(x, y, x, y);
    }

    updateSurfaceColumn(x, y, newMaterial, oldMaterial) {
        if (!this.surfaceCache) return;
        const current = this.surfaceCache[x];

        if (newMaterial === this.EMPTY) {
            if (y <= current) {
                let next = this.height;
                const width = this.width;
                for (let scan = y; scan < this.height; scan++) {
                    if (this.pixels[scan * width + x] !== this.EMPTY) {
                        next = scan;
                        break;
                    }
                }
                this.surfaceCache[x] = next;
            }
        } else if (y < current) {
            this.surfaceCache[x] = y;
        }

        if (oldMaterial !== this.EMPTY && newMaterial === this.EMPTY && y === current) {
            let next = this.height;
            const width = this.width;
            for (let scan = y; scan < this.height; scan++) {
                if (this.pixels[scan * width + x] !== this.EMPTY) {
                    next = scan;
                    break;
                }
            }
            this.surfaceCache[x] = next;
        }
    }

    processSurfaceDirty() {
        // Surface cache updates occur eagerly via updateSurfaceColumn
    }

    render(ctx, camX, camY, viewWidth, viewHeight, scale) {
        // Lazy render - only redraw when terrain changes
        if (this.dirty) {
            this.updateRenderCache(camX, camY, viewWidth, viewHeight);
            this.dirty = false;
        }
        
        if (!this.offscreenCanvas) return;

        const startY = Math.max(0, Math.floor(camY));
        const endY = Math.min(this.height, Math.ceil(camY + viewHeight));
        const regionHeight = endY - startY;
        if (regionHeight <= 0) return;

        ctx.imageSmoothingEnabled = false;

        const worldStart = camX;
        const worldEnd = camX + viewWidth;
        const tileWidth = this.width;
        const tileStart = Math.floor(worldStart / tileWidth);
        const tileEnd = Math.floor((worldEnd - 1) / tileWidth);

        for (let tile = tileStart; tile <= tileEnd; tile++) {
            const tileWorldStart = tile * tileWidth;
            const segmentStart = Math.max(worldStart, tileWorldStart);
            const segmentEnd = Math.min(worldEnd, tileWorldStart + tileWidth);
            const segmentStartPx = Math.floor(segmentStart);
            const segmentEndPx = Math.ceil(segmentEnd);
            const pixelWidth = segmentEndPx - segmentStartPx;
            if (pixelWidth <= 0) continue;

            let srcX = segmentStartPx - tileWorldStart;
            if (srcX < 0) srcX += tileWidth;

            ctx.drawImage(
                this.offscreenCanvas,
                srcX,
                startY,
                pixelWidth,
                regionHeight,
                segmentStartPx * scale,
                startY * scale,
                pixelWidth * scale,
                regionHeight * scale
            );
        }
    }
    
    updateRenderCache(camX, camY, viewWidth, viewHeight) {
        // Build an offscreen canvas that stores the full terrain as pixel data.
        if (typeof document === 'undefined') {
            // Rendering only matters on the client; nothing to build here.
            return;
        }

        if (!this.ensureRenderResources()) return;

        if (!this.dirtyBounds) {
            if (!this.fullRedrawNeeded) {
                return;
            }
            this.dirtyBounds = {
                minX: 0,
                minY: 0,
                maxX: this.width - 1,
                maxY: this.height - 1
            };
        }

        if (this.fullRedrawNeeded) {
            this.populateImageData(0, 0, this.width - 1, this.height - 1);
            this.fullRedrawNeeded = false;
        }

        const bounds = this.dirtyBounds;
        const minX = Math.max(0, Math.floor(bounds.minX));
        const minY = Math.max(0, Math.floor(bounds.minY));
        const maxX = Math.min(this.width - 1, Math.ceil(bounds.maxX));
        const maxY = Math.min(this.height - 1, Math.ceil(bounds.maxY));

        const regionWidth = maxX - minX + 1;
        const regionHeight = maxY - minY + 1;
        if (regionWidth <= 0 || regionHeight <= 0) {
            this.dirtyBounds = null;
            return;
        }

        const ctx = this.offscreenCtx;
        ctx.putImageData(this.imageData, 0, 0, minX, minY, regionWidth, regionHeight);
        this.dirtyBounds = null;
    }

    getModifications() {
        if (this.modifiedChunks.size === 0) {
            return null;
        }

        const result = {
            chunkSize: this.chunkSize,
            chunks: []
        };

        for (const [key, data] of this.modifiedChunks.entries()) {
            const pixels = [];
            for (const [localIndex, material] of data.pixels.entries()) {
                pixels.push({ localIndex, material });
            }
            if (pixels.length > 0) {
                result.chunks.push({ key, pixels });
            }
            data.pixels.clear();
        }
        this.modifiedChunks.clear();
        return result.chunks.length ? result : null;
    }

    markChunkModified(x, y) {
        const chunkX = Math.floor(x / this.chunkSize);
        const chunkY = Math.floor(y / this.chunkSize);
        const key = `${chunkX}|${chunkY}`;
        let record = this.modifiedChunks.get(key);
        if (!record) {
            record = { pixels: new Map() };
            this.modifiedChunks.set(key, record);
        }
        let localX = x % this.chunkSize;
        let localY = y % this.chunkSize;
        if (localX < 0) localX += this.chunkSize;
        if (localY < 0) localY += this.chunkSize;
        const localIndex = localY * this.chunkSize + localX;
        record.pixels.set(localIndex, this.pixels[y * this.width + x]);
    }

    applyModifications(snapshot) {
        if (!snapshot) return;
        const chunkSize = snapshot.chunkSize || this.chunkSize;
        this.setChunkSize(chunkSize);
        const chunks = snapshot.chunks || [];
        this.suppressModificationTracking = true;
        for (let i = 0; i < chunks.length; i++) {
            const entry = chunks[i];
            if (!entry || !entry.key || !Array.isArray(entry.pixels)) continue;
            const [chunkXString, chunkYString] = entry.key.split('|');
            const chunkX = parseInt(chunkXString, 10);
            const chunkY = parseInt(chunkYString, 10);
            if (Number.isNaN(chunkX) || Number.isNaN(chunkY)) continue;
            for (let j = 0; j < entry.pixels.length; j++) {
                const pixelData = entry.pixels[j];
                if (!pixelData) continue;
                const localIndex = pixelData.localIndex;
                const material = pixelData.material;
                if (typeof localIndex !== 'number' || typeof material !== 'number') continue;
                const localX = localIndex % chunkSize;
                const localY = Math.floor(localIndex / chunkSize);
                const worldX = chunkX * chunkSize + localX;
                const worldY = chunkY * chunkSize + localY;
                const wrappedX = Math.floor(wrapHorizontal(worldX, this.width));
                if (worldY < 0 || worldY >= this.height) continue;
                this.setPixel(wrappedX, worldY, material);
            }
        }
        this.suppressModificationTracking = false;
    }

    consumeInitialFluids() {
        const fluids = this.initialFluids.slice();
        this.initialFluids.length = 0;
        return fluids;
    }

    generateCaves() {
        const area = this.width * this.height;
        const targetCaves = Math.max(6, Math.floor(area / 90000));
        const caveNoise = new SimplexNoise(Math.random());
        let randSeed = Math.max(1, Math.abs(Math.floor(Math.sin(this.width * 12.9898 + this.height * 78.233) * 100000)));
        const rand = () => {
            const value = Math.sin(randSeed++) * 43758.5453123;
            return value - Math.floor(value);
        };
        const attempts = targetCaves * 3;
        let created = 0;

        for (let i = 0; i < attempts && created < targetCaves; i++) {
            const cx = Math.floor(rand() * this.width);
            const cy = Math.floor(this.height * 0.25 + rand() * this.height * 0.6);
            if (cy >= this.height - 6) continue;

            const roll = rand();
            let subtype = 'tube';
            if (roll > 0.8) subtype = 'basin';
            if (roll > 0.9) subtype = 'lake';
            if (roll > 0.96) subtype = 'lava_lake';

            const cave = this.carveCave(cx, cy, subtype, caveNoise, rand);
            if (cave) {
                this.caves.push(cave);
                created++;
            }
        }
    }

    carveCave(cx, cy, subtype, noise, rand = Math.random) {
        const record = { subtype, nodes: [] };
        const baseRadius = 6 + rand() * 6;
        const clampY = (y) => Math.max(2, Math.min(this.height - 6, y));

        const seedTunnel = (startX, startY, radius, noiseRef, randRef, depth = 0) => {
            const length = (120 + randRef() * 160) * (depth === 0 ? 1 : 0.6);
            let angle = randRef() * Math.PI * 2;
            let x = startX;
            let y = startY;
            let prevBranch = 0;

            for (let step = 0; step < length; step++) {
                const radiusScale = radius * (0.7 + randRef() * 0.6);
                this.carveBlob(Math.floor(x), Math.floor(y), radiusScale, radiusScale * 0.6);
                record.nodes.push({ x, y, radius: radiusScale });

                if (depth < 2 && step - prevBranch > 30 && randRef() > 0.78) {
                    prevBranch = step;
                    const branchAngle = angle + (randRef() - 0.5) * 1.2;
                    const branchRadius = radius * (0.5 + randRef() * 0.4);
                    const branchLength = length * 0.45;
                    let branchX = x;
                    let branchY = y;
                    for (let b = 0; b < branchLength; b++) {
                        const brScale = branchRadius * (0.6 + randRef() * 0.4);
                        this.carveBlob(Math.floor(branchX), Math.floor(branchY), brScale, brScale * 0.6);
                        record.nodes.push({ x: branchX, y: branchY, radius: brScale });
                        branchX += Math.cos(branchAngle) * 2.5;
                        branchY = clampY(branchY + Math.sin(branchAngle) * 2 + noiseRef.noise2D(branchX * 0.03, branchY * 0.03));
                        if (branchX < 4 || branchX >= this.width - 4) break;
                    }
                }

                angle += (randRef() - 0.5) * 0.4;
                x += Math.cos(angle) * 3;
                y = clampY(y + Math.sin(angle) * 2 + noiseRef.noise2D(x * 0.02, y * 0.02) * 2);
                if (x < 4 || x >= this.width - 4) break;
            }
        };

        if (subtype === 'tube') {
            seedTunnel(cx, cy, baseRadius, noise, rand, 0);
            return record;
        }

        const radius = baseRadius * (1.5 + rand());
        const verticalRadius = radius * (0.7 + rand() * 0.5);
        this.carveBlob(cx, cy, radius, verticalRadius);
        record.nodes.push({ x: cx, y: cy, radius, verticalRadius });

        const branchCount = 2 + Math.floor(rand() * 3);
        for (let b = 0; b < branchCount; b++) {
            const angle = rand() * Math.PI * 2;
            const startX = cx + Math.cos(angle) * radius * 0.6;
            const startY = clampY(cy + Math.sin(angle) * verticalRadius * 0.5);
            seedTunnel(startX, startY, radius * (0.6 + rand() * 0.4), noise, rand, 1);
        }

        if (subtype === 'basin' || subtype === 'lake' || subtype === 'lava_lake') {
            const floorY = Math.floor(cy + verticalRadius * 0.6);
            const fillMaterial = subtype === 'lava_lake' ? this.LAVA : subtype === 'lake' ? this.WATER : this.EMPTY;
            if (fillMaterial !== this.EMPTY) {
                for (let y = floorY; y < Math.min(this.height - 3, floorY + Math.max(3, verticalRadius)); y++) {
                    for (let x = Math.floor(cx - radius + 1); x <= Math.floor(cx + radius - 1); x++) {
                        const dist = Math.sqrt((x - cx) ** 2 + ((y - cy) / verticalRadius) ** 2);
                        if (dist <= 0.9) {
                            this.setPixel(x, y, fillMaterial);
                        }
                    }
                }
            }
        }

        return record;
    }

    carveBlob(cx, cy, radiusX, radiusY) {
        const minX = Math.floor(cx - radiusX - 2);
        const maxX = Math.ceil(cx + radiusX + 2);
        const minY = Math.floor(cy - radiusY - 2);
        const maxY = Math.ceil(cy + radiusY + 2);

        for (let y = minY; y <= maxY; y++) {
            if (y < 1 || y >= this.height - 2) continue;
            for (let x = minX; x <= maxX; x++) {
                const wrappedX = Math.floor(wrapHorizontal(x, this.width));
                const dx = (wrappedX - cx) / radiusX;
                const dy = (y - cy) / radiusY;
                if (dx * dx + dy * dy <= 1.0) {
                    this.setPixel(wrappedX, y, this.EMPTY);
                }
            }
        }
    }

    generateCaves() {
        const area = this.width * this.height;
        const targetCaves = Math.max(6, Math.floor(area / 90000));
        const caveNoise = new SimplexNoise(Math.random());
        let randSeed = Math.max(1, Math.abs(Math.floor(Math.sin(this.width * 12.9898 + this.height * 78.233) * 100000)));
        const rand = () => {
            const value = Math.sin(randSeed++) * 43758.5453123;
            return value - Math.floor(value);
        };
        const attempts = targetCaves * 3;
        let created = 0;

        for (let i = 0; i < attempts && created < targetCaves; i++) {
            const cx = Math.floor(rand() * this.width);
            const cy = Math.floor(this.height * 0.25 + rand() * this.height * 0.6);
            if (cy >= this.height - 6) continue;

            const roll = rand();
            let subtype = 'tube';
            if (roll > 0.8) subtype = 'basin';
            if (roll > 0.9) subtype = 'lake';
            if (roll > 0.96) subtype = 'lava_lake';

            const cave = this.carveCave(cx, cy, subtype, caveNoise, rand);
            if (cave) {
                this.caves.push(cave);
                created++;
            }
        }
    }

    carveCave(cx, cy, subtype, noise, rand = Math.random) {
        const record = { subtype, nodes: [] };
        const baseRadius = 4 + rand() * 4;
        const clampY = (y) => Math.max(2, Math.min(this.height - 6, y));

        if (subtype === 'tube') {
            const length = 60 + rand() * 140;
            let angle = rand() * Math.PI * 2;
            let x = cx;
            let y = cy;
            for (let step = 0; step < length; step++) {
                const radius = baseRadius * (0.7 + rand() * 0.6);
                this.carveBlob(Math.floor(x), Math.floor(y), radius, radius * 0.6);
                record.nodes.push({ x, y, radius });
                angle += (rand() - 0.5) * 0.4;
                x += Math.cos(angle) * 3;
                y = clampY(y + Math.sin(angle) * 2 + noise.noise2D(x * 0.02, y * 0.02) * 2);
                if (x < 4 || x >= this.width - 4) break;
            }
            return record;
        }

        const radius = baseRadius * (1.4 + rand());
        const verticalRadius = radius * (0.6 + rand() * 0.6);
        this.carveBlob(cx, cy, radius, verticalRadius);
        record.nodes.push({ x: cx, y: cy, radius, verticalRadius });

        if (subtype === 'basin' || subtype === 'lake' || subtype === 'lava_lake') {
            const floorY = Math.floor(cy + verticalRadius * 0.6);
            const fillMaterial = subtype === 'lava_lake' ? this.LAVA : subtype === 'lake' ? this.WATER : this.EMPTY;
            if (fillMaterial !== this.EMPTY) {
                for (let y = floorY; y < Math.min(this.height - 3, floorY + Math.max(3, verticalRadius)); y++) {
                    for (let x = Math.floor(cx - radius + 1); x <= Math.floor(cx + radius - 1); x++) {
                        const dist = Math.sqrt((x - cx) ** 2 + ((y - cy) / verticalRadius) ** 2);
                        if (dist <= 0.9) {
                            this.setPixel(x, y, fillMaterial);
                        }
                    }
                }
            }
        }

        return record;
    }

    carveBlob(cx, cy, radiusX, radiusY) {
        const minX = Math.floor(cx - radiusX - 2);
        const maxX = Math.ceil(cx + radiusX + 2);
        const minY = Math.floor(cy - radiusY - 2);
        const maxY = Math.ceil(cy + radiusY + 2);

        for (let y = minY; y <= maxY; y++) {
            if (y < 1 || y >= this.height - 2) continue;
            for (let x = minX; x <= maxX; x++) {
                const wrappedX = Math.floor(wrapHorizontal(x, this.width));
                const dx = (wrappedX - cx) / radiusX;
                const dy = (y - cy) / radiusY;
                if (dx * dx + dy * dy <= 1.0) {
                    this.setPixel(wrappedX, y, this.EMPTY);
                }
            }
        }
    }

    markDirtyRegion(minX, minY, maxX, maxY) {
        if (minX > maxX || minY > maxY) return;

        minX = Math.floor(minX);
        minY = Math.floor(minY);
        maxX = Math.floor(maxX);
        maxY = Math.floor(maxY);

        minX = Math.max(0, Math.min(minX, this.width - 1));
        maxX = Math.max(0, Math.min(maxX, this.width - 1));
        minY = Math.max(0, Math.min(minY, this.height - 1));
        maxY = Math.max(0, Math.min(maxY, this.height - 1));

        if (minX > maxX || minY > maxY) return;

        this.dirty = true;

        if (!this.dirtyBounds) {
            this.dirtyBounds = { minX, minY, maxX, maxY };
            return;
        }

        if (minX < this.dirtyBounds.minX) this.dirtyBounds.minX = minX;
        if (maxX > this.dirtyBounds.maxX) this.dirtyBounds.maxX = maxX;
        if (minY < this.dirtyBounds.minY) this.dirtyBounds.minY = minY;
        if (maxY > this.dirtyBounds.maxY) this.dirtyBounds.maxY = maxY;
    }

    ensureRenderResources() {
        if (typeof document === 'undefined') {
            return false;
        }

        if (!this.offscreenCanvas) {
            this.offscreenCanvas = document.createElement('canvas');
            this.offscreenCanvas.width = this.width;
            this.offscreenCanvas.height = this.height;
            this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
            this.offscreenCtx.imageSmoothingEnabled = false;
        }

        if (!this.imageData) {
            this.imageData = this.offscreenCtx.createImageData(this.width, this.height);
            this.pixelColors32 = new Uint32Array(this.imageData.data.buffer);
            this.fullRedrawNeeded = true;
        }

        return !!this.offscreenCanvas;
    }

    populateImageData(minX, minY, maxX, maxY) {
        if (!this.pixelColors32) return;

        for (let y = minY; y <= maxY; y++) {
            let baseIndex = y * this.width + minX;
            for (let x = minX; x <= maxX; x++, baseIndex++) {
                const material = this.pixels[baseIndex];
                const color = this.getMaterialColor(material, x, y);
                this.pixelColors32[baseIndex] = color ? color.rgba32 : 0;
            }
        }
    }

    getMaterialColor(material, x = 0, y = 0) {
        if (material === this.EMPTY) return null;

        const palette = this.palettes[material] || (this.colors[material] ? [this.colors[material]] : ['#ffffff']);
        const paletteIndex = palette.length === 1
            ? 0
            : this.computePaletteIndex(x, y, material, palette.length);
        const cacheKey = `${material}|${paletteIndex}`;

        if (this.colorCache.has(cacheKey)) {
            return this.colorCache.get(cacheKey);
        }

        const hex = palette[paletteIndex];
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const a = 255;
        const rgba32 = this.isLittleEndian
            ? (a << 24) | (b << 16) | (g << 8) | r
            : (r << 24) | (g << 16) | (b << 8) | a;

        const color = { r, g, b, a, rgba32, hex };
        this.colorCache.set(cacheKey, color);
        return color;
    }

    computePaletteIndex(x, y, material, paletteSize) {
        const hash = Math.sin((x * 12.9898) + (y * 78.233) + material * 37.719);
        const normalized = hash - Math.floor(hash);
        return Math.abs(Math.floor(normalized * paletteSize)) % paletteSize;
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
