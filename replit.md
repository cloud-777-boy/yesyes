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
  - Single server on port 5000 handles both HTTP and WebSocket connections
  - WebSocket server attached to HTTP server for deployment compatibility
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
- Single port (5000) for both HTTP and WebSocket
- WebSocket connections upgrade from HTTP on the same port
- Static file serving with no-cache headers
- Automatic WebSocket URL detection based on environment
- Deployment-ready: works in both local development and production

### Deployment
- Configured as VM deployment (always-on server needed for WebSocket)
- Runs `node app.js` in production
- Supports both HTTP and secure WebSocket (WSS) connections

## How to Play

### Multiplayer Only
1. Click "PLAY" on the main menu
2. WebSocket URL is automatically configured
3. Click "CONNECT" to join the server
4. Play with other connected players (up to 64)

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
- **Terrain Synchronization**: Server-generated terrain ensures fair gameplay for all

### Terrain Synchronization System
To ensure 100% deterministic shared terrain across all players:
- **Server generates terrain** on startup using deterministic procedural generation
- **Server stores canonical terrain** snapshot that becomes the source of truth
- **All players receive identical terrain** from server on connection
- **Base64 encoding** efficiently transmits terrain pixel data
- **No client-side terrain generation** in multiplayer - server is authoritative
- **Fair gameplay** - no player has advantage from generating terrain
- **No terrain drift** between clients - all players see the same landscape

## Recent Changes

**2025-10-05**: Server-authoritative terrain system + Singleplayer removal
- Converted from "Player 1 Authority" to full server authority for terrain generation
- Server generates terrain on startup using Terrain class with deterministic RNG (~200ms)
- All connecting players receive the server's canonical terrain snapshot (~1.92MB base64)
- Removed client-side terrain upload logic (needsTerrainSnapshot flag)
- **Clients skip local terrain generation** - directly load server terrain for faster connection
- **Fixed Player 2 terrain overwrite bug** - fluids now spawn after snapshot loads, not before
- **Removed singleplayer mode** - game is now multiplayer-only
- Ensures fair gameplay - no player has terrain generation advantage
- Added module.exports to deterministic.js and terrain.js for Node.js compatibility
- Ensures 100% identical terrain across all multiplayer clients
- Added detailed logging for debugging terrain synchronization

**2025-10-05**: Fixed WebSocket URL and deployment issues
- Combined HTTP and WebSocket on single port (5000)
- WebSocket server now attached to HTTP server instead of separate port
- Fixes deployment issue where port 8080 was blocked by firewall
- Added auto-fix for stored URLs with incorrect port numbers
- WebSocket URL now correctly omits port for Replit domains (*.replit.app, *.replit.dev, *.repl.co)
- Enhanced connection logging for better debugging

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

**2025-10-04**: Initial Replit setup
- Created combined HTTP/WebSocket server (app.js)
- Configured frontend to auto-detect WebSocket URL
- Set up workflow for port 5000
- Configured VM deployment for production
- Added cache-control headers to prevent stale content
