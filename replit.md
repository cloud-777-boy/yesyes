# Pixel Mage Arena - Replit Setup

## Overview

This is a multiplayer pixel destruction game featuring procedural terrain generation, real-time physics, and WebSocket-based multiplayer for up to 64 players. Players control mage characters that can cast different spells to destroy terrain and battle each other.

## Project Architecture

### Frontend (Browser-based)
- **index.html**: Main game interface with menu system and HUD
- **engine.js**: Core game loop with fixed timestep physics (60 FPS)
- **terrain.js**: Procedural terrain generation and pixel-perfect destruction
- **physics.js**: Falling sand simulation for debris and particle effects
- **player.js**: Player character movement and collision
- **projectile.js**: Spell projectiles with different effects
- **network.js**: Multiplayer networking with client-side prediction
- **input.js**: Keyboard and mouse input handling

### Backend (Node.js)
- **app.js**: Combined HTTP and WebSocket server
  - HTTP server on port 5000 serves static files
  - WebSocket server on port 8080 handles multiplayer game state
  - Includes cache-control headers to prevent stale content

### Game Features
- **4 Spell Types**:
  - Fireball: Large explosive area damage
  - Ice: Piercing projectile with freezing effect
  - Lightning: Fast-moving bolt with chain damage
  - Earth: Heavy projectile with knockback
- **Pixel-Perfect Destruction**: Terrain destroyed down to individual pixels
- **Dynamic Physics**: Destroyed terrain collapses into falling sand particles
- **Multiplayer Synchronization**: Server authoritative with client prediction

## Technical Setup

### Server Configuration
- Frontend served on port 5000 (HTTP)
- WebSocket multiplayer on port 8080
- Static file serving with no-cache headers
- Automatic WebSocket URL detection based on environment

### Deployment
- Configured as VM deployment (always-on server needed for WebSocket)
- Runs `node app.js` in production
- Supports both HTTP and secure WebSocket (WSS) connections

## How to Play

### Singleplayer
1. Click "SINGLEPLAYER" on the main menu
2. Game starts immediately with AI/physics simulation

### Multiplayer
1. Click "MULTIPLAYER" on the main menu
2. WebSocket URL is automatically configured
3. Click "CONNECT" to join the server
4. Play with other connected players

### Controls
- **Mouse**: Aim and shoot spells
- **A/D or Arrow Keys**: Move left/right
- **W/Space**: Jump
- **1-4**: Select spell type
- **Click**: Cast spell

## Development Notes

### Performance Optimizations
- Object pooling for sand and particles
- Fixed timestep ensures deterministic physics
- Dirty region rendering for terrain updates
- Efficient collision detection

### Network Architecture
- Client-side prediction for smooth local gameplay
- Server reconciliation to correct divergence
- Input buffering and replay for network compensation
- Tick-based synchronization (60 Hz physics, 20 Hz state updates)

## Recent Changes

**2025-10-05**: Liquid physics improvements
- Liquids (water/lava) now remain dynamic forever using falling sand physics
- Removed settling behavior - liquids never convert to static terrain
- Maintains continuous flow and spreading behavior

**2025-10-05**: Multiplayer movement smoothing
- Implemented smooth interpolation for remote players (30% blend rate)
- Local player reconciliation uses gradual correction instead of snapping
- Eliminates jerky/rubber-banding movement in multiplayer

**2025-10-05**: Fixed multiplayer hovering bug
- Removed hardcoded server-side ground collision at y=300
- Changed to client-authoritative physics for terrain collision  
- Server now accepts client positions with basic bounds validation
- This fixes the visual hovering bug where players appeared to float over terrain
- Note: Proper anti-cheat would require syncing terrain data to server (future enhancement)

**2025-10-04**: Initial Replit setup
- Created combined HTTP/WebSocket server (app.js)
- Configured frontend to auto-detect WebSocket URL
- Set up workflow for port 5000
- Configured VM deployment for production
- Added cache-control headers to prevent stale content
