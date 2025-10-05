# Pixel Mage Arena - Multiplayer Destruction Game Engine

A high-performance JavaScript game engine inspired by Cortex Command and Falling Sand games, featuring pixel-perfect terrain destruction, deterministic physics, and support for 64-player multiplayer battles.

## 🎮 Features

### Core Engine
- **Pixel-Perfect Destruction**: Terrain can be destroyed down to individual pixels
- **Dynamic Physics**: Destroyed terrain crumbles into falling sand particles that can settle or flow
- **Substances System**: Grass, dirt, stone, and precious ores each have unique durability and behavior
- **Massive Worlds**: Optimized pipeline supports 11k+ pixel wide maps without sacrificing framerate
- **Chunked Simulation**: Physics only runs in buffered active chunks around players for huge performance gains
- **Procedural Generation**: Terrain generated using Perlin-like noise with caves and layers
- **Deterministic Physics**: Fixed timestep ensures consistent behavior across all clients
- **Object Pooling**: Optimized memory management for sand and effect particles

### Gameplay
- **Mage Characters**: Small wizard characters with staffs
- **4 Spell Types**:
  - 🔥 Fireball: Large explosive area damage
  - 🧊 Ice: Piercing projectile with freezing effect  
  - ⚡ Lightning: Fast-moving bolt with chain damage
  - 🪨 Earth: Heavy projectile with knockback

### Multiplayer
- **Up to 64 Players**: Designed for massive online battles
- **Client-Side Prediction**: Smooth gameplay despite network latency
- **Server Reconciliation**: Automatic correction of client divergence
- **Lockstep Networking**: Ensures all clients stay synchronized
- **WebSocket Based**: Real-time bidirectional communication

## 🚀 Quick Start

### Singleplayer (No Setup Required)

1. Open `index.html` in a modern web browser
2. Click "SINGLEPLAYER"
3. Start playing!

**Controls:**
- A/D or Arrow Keys: Move left/right
- W/Space: Jump
- Mouse: Aim and shoot spells
- 1-4: Select spell type
- Click: Cast spell

### Multiplayer Setup

#### Option 1: Local Testing (Development)

The game includes a mock server mode for testing. Simply:
1. Open `index.html`
2. Click "MULTIPLAYER"
3. Use default URL: `ws://localhost:8080`
4. Click "CONNECT"

Note: This won't actually connect but will fall back to singleplayer mode.

#### Option 2: Real Server (Production)

Create a Node.js WebSocket server:

```javascript
// server.js
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

const players = new Map();
let tick = 0;

// Game loop - 60 ticks per second
setInterval(() => {
    tick++;
    
    // Broadcast state to all clients
    const state = {
        type: 'state',
        tick: tick,
        players: Array.from(players.values()),
        terrainMods: []
    };
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(state));
        }
    });
}, 1000 / 60);

wss.on('connection', (ws) => {
    const playerId = 'player-' + Math.random().toString(36).substr(2, 9);
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        playerId: playerId,
        tick: tick,
        spawnX: Math.random() * 800 + 400,
        spawnY: 100
    }));
    
    // Add player
    players.set(playerId, {
        id: playerId,
        x: Math.random() * 800 + 400,
        y: 100,
        health: 100,
        alive: true
    });
    
    // Notify others
    wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'player_joined',
                playerId: playerId,
                x: players.get(playerId).x,
                y: players.get(playerId).y
            }));
        }
    });
    
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        
        switch (msg.type) {
            case 'input':
                // Process player input
                const player = players.get(playerId);
                if (player) {
                    // Apply input to player state
                    if (msg.input.left) player.x -= 2;
                    if (msg.input.right) player.x += 2;
                }
                break;
                
            case 'projectile':
                // Broadcast projectile to all clients
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msg));
                    }
                });
                break;
                
            case 'terrain_destroy':
                // Broadcast terrain destruction
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'terrain_update',
                            x: msg.x,
                            y: msg.y,
                            radius: msg.radius,
                            explosive: msg.explosive
                        }));
                    }
                });
                break;
        }
    });
    
    ws.on('close', () => {
        players.delete(playerId);
        
        // Notify others
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'player_left',
                    playerId: playerId
                }));
            }
        });
    });
});

console.log('Server running on ws://localhost:8080');
```

Install dependencies and run:
```bash
npm install ws
node server.js
```

## 🏗️ Architecture

### Engine Components

```
engine.js          - Core game loop and system coordination
terrain.js         - Procedural generation and destruction
physics.js         - Chunk physics and particle system
player.js          - Player character and movement
projectile.js      - Spell projectiles and effects
network.js         - Multiplayer synchronization
input.js           - Keyboard and mouse handling
index.html         - Main game interface
```

### Key Classes

**GameEngine**
- Main game loop with fixed timestep
- Manages all game systems
- Handles object pooling for performance

**Terrain**
- Procedural generation using simplex noise
- Flood-fill algorithm to extract loose debris
- Efficient rendering with dirty regions

**SandParticle**
- Falling sand simulation for debris
- Simple cellular movement with drift
- Welds back into terrain when settled

**Player**
- Movement and collision
- Spell casting with cooldowns
- Health and damage system

**NetworkManager**
- Client-side prediction
- Server reconciliation
- Input buffering and replay

## ⚙️ Performance Optimization

### Techniques Used

1. **Object Pooling**: Reuse sand and particle effects to reduce garbage collection
2. **Fixed Timestep**: Ensures consistent physics regardless of framerate
3. **Dirty Regions**: Only re-render terrain that has changed
4. **Spatial Partitioning**: Efficient collision detection (can be added)
5. **LOD System**: Render detail scales with view distance (can be added)

### Performance Tips

- Target 60 FPS on modern hardware
- Supports thousands of active falling sand particles
- Network traffic optimized with delta compression
- Canvas rendering optimized with batching
- Adjust `sandViewRadiusMultiplier` in `engine.js` to tune how many chunks stay active per player

## 🎯 Customization

### Adding New Spells

Edit `projectile.js` to add new spell types:

```javascript
case 'your_spell':
    this.color = '#ff00ff';
    this.explosionRadius = 25;
    this.damage = 40;
    this.gravity = 0.1;
    this.specialEffect = true;
    break;
```

### Modifying Terrain Generation

Edit `terrain.js` in the `generate()` method:

```javascript
const heightVariation = noise.noise2D(x * 0.005, 0) * 80;
const baseHeight = this.height * 0.4 + heightVariation;
```

### Tweaking Substances

Each material is defined in `terrain.js` within the `this.substances` map.  Update durability or `degradeTo` values to change how grass, dirt, stone, gold, silver, and iron react to explosions and impacts.

Color variation for each substance lives in the `this.palettes` object.  Add or edit hex values there to fine-tune the natural dithering and texture of the map.

### Adjusting Physics

Edit `engine.js` physics constants:

```javascript
this.gravity = 0.3;  // Increase for faster falling
this.fixedTimeStep = 1000 / 60;  // Change simulation rate
```

## 🐛 Troubleshooting

**Game runs slowly:**
- Reduce `pixelSize` in engine.js for better performance
- Lower canvas resolution
- Reduce max number of sand particles

**Multiplayer won't connect:**
- Ensure WebSocket server is running
- Check firewall settings
- Verify server URL is correct
- Check browser console for errors

**Terrain destruction lags:**
- Reduce explosion radius
- Lower maximum sand particles spawned per explosion
- Use smaller destruction radii for effects
- Tune `maxSandParticles`, `maxSandUpdatesPerFrame`, and `maxSandSpawnPerDestroy` in `engine.js` to match target hardware

## 📝 License

MIT License - Feel free to use in your own projects!

## 🚀 Future Enhancements

- [ ] Spatial hashing for collision optimization
- [ ] Texture atlases for better rendering
- [ ] Advanced spell combos
- [ ] Team-based gameplay
- [ ] Map editor
- [ ] Replay system
- [ ] Spectator mode
- [ ] Server-authoritative physics
- [ ] Anti-cheat measures
- [ ] Mobile touch controls optimization

## 💡 Technical Notes

### Deterministic Physics

The engine uses a fixed timestep to ensure deterministic physics. This means:
- All clients simulate the same physics
- Input is applied at specific ticks
- Results are consistent across machines

### Network Architecture

The networking uses a hybrid approach:
- Client-side prediction for local player (low latency)
- Server reconciliation for corrections
- Broadcast for projectiles and terrain changes
- Delta compression for state updates (in production)

### Pixel Storage

Terrain pixels are stored in a typed array for memory efficiency:
- Uint8Array for material types
- 1 byte per pixel
- 1600x900 = 1.44MB for full terrain

Built with ⚡ for maximum performance and 🎮 for maximum fun!
