/**
 * InputManager - Handles keyboard and mouse input
 */

class InputManager {
    constructor(canvas, engine, network = null) {
        this.canvas = canvas;
        this.engine = engine;
        this.network = network;
        
        this.keys = {};
        this.mouseX = 0;
        this.mouseY = 0;
        this.mouseWorldX = 0;
        this.mouseWorldY = 0;
        this.mouseDown = false;
        
        this.setupListeners();
    }
    
    setupListeners() {
        // Keyboard
        window.addEventListener('keydown', (e) => {
            this.keys[e.key.toLowerCase()] = true;
            
            // Spell selection
            if (e.key >= '1' && e.key <= '4') {
                const spellIndex = parseInt(e.key) - 1;
                const player = this.engine.players.get(this.engine.playerId);
                if (player) {
                    player.selectedSpell = spellIndex;
                }
            }
            
            // Prevent default for game keys
            if (['w', 'a', 's', 'd', ' '].includes(e.key.toLowerCase())) {
                e.preventDefault();
            }
        });
        
        window.addEventListener('keyup', (e) => {
            this.keys[e.key.toLowerCase()] = false;
        });
        
        // Mouse
        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;
            
            // Convert to world coordinates
            const scale = this.engine.pixelSize;
            const camX = this.engine.cameraX - this.canvas.width / (2 * scale);
            const camY = this.engine.cameraY - this.canvas.height / (2 * scale);
            
            this.mouseWorldX = this.mouseX / scale + camX;
            this.mouseWorldY = this.mouseY / scale + camY;
        });
        
        this.canvas.addEventListener('mousedown', (e) => {
            this.mouseDown = true;
            e.preventDefault();
        });
        
        this.canvas.addEventListener('mouseup', () => {
            this.mouseDown = false;
        });
        
        // Touch support
        this.canvas.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = touch.clientX - rect.left;
            this.mouseY = touch.clientY - rect.top;
            this.mouseDown = true;
            e.preventDefault();
        });
        
        this.canvas.addEventListener('touchmove', (e) => {
            const touch = e.touches[0];
            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = touch.clientX - rect.left;
            this.mouseY = touch.clientY - rect.top;
            
            const scale = this.engine.pixelSize;
            const camX = this.engine.cameraX - this.canvas.width / (2 * scale);
            const camY = this.engine.cameraY - this.canvas.height / (2 * scale);
            
            this.mouseWorldX = this.mouseX / scale + camX;
            this.mouseWorldY = this.mouseY / scale + camY;
            e.preventDefault();
        });
        
        this.canvas.addEventListener('touchend', () => {
            this.mouseDown = false;
        });
        
        // Prevent context menu
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });
    }
    
    update() {
        const player = this.engine.players.get(this.engine.playerId);
        if (!player || !player.alive) return;
        
        // Build input state
        const input = {
            left: this.keys['a'] || this.keys['arrowleft'] || false,
            right: this.keys['d'] || this.keys['arrowright'] || false,
            jump: this.keys['w'] || this.keys[' '] || this.keys['arrowup'] || false,
            shoot: this.mouseDown,
            mouseX: this.mouseWorldX,
            mouseY: this.mouseWorldY
        };
        
        // Send to network or apply locally
        if (this.network && this.network.connected) {
            this.network.sendInput(input);
        } else {
            // Offline mode - apply directly
            player.input = input;
        }
        
        // Update camera to follow player
        this.updateCamera(player);
    }
    
    updateCamera(player) {
        const targetX = player.x + player.width / 2;
        const targetY = player.y + player.height / 2;
        
        // Smooth camera follow
        const lerpFactor = 0.1;
        this.engine.cameraX += (targetX - this.engine.cameraX) * lerpFactor;
        this.engine.cameraY += (targetY - this.engine.cameraY) * lerpFactor;
        
        // Clamp camera to world bounds
        const halfViewWidth = this.canvas.width / (2 * this.engine.pixelSize);
        const halfViewHeight = this.canvas.height / (2 * this.engine.pixelSize);
        
        this.engine.cameraX = Math.max(halfViewWidth, Math.min(this.engine.cameraX, this.engine.width - halfViewWidth));
        this.engine.cameraY = Math.max(halfViewHeight, Math.min(this.engine.cameraY, this.engine.height - halfViewHeight));
    }
    
    isKeyDown(key) {
        return this.keys[key.toLowerCase()] || false;
    }
}
