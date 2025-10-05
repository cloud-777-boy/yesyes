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
        this.lastAimVector = { x: 1, y: 0 };
        this.touchControlsActive = false;
        this.touchMoveLeft = false;
        this.touchMoveRight = false;
        this.touchJumpActive = false;
        this.touchJumpQueued = false;
        this.isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
        this.isPhoneDevice = this.detectPhoneDevice();

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
                    if (typeof player.normalizeSpellIndex === 'function') {
                        player.selectedSpell = player.normalizeSpellIndex(spellIndex);
                    } else {
                        player.selectedSpell = spellIndex;
                    }
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
            if (!rect.width || !rect.height) return;
            const xRatio = (e.clientX - rect.left) / rect.width;
            const yRatio = (e.clientY - rect.top) / rect.height;
            this.updateAimFromRatio(xRatio, yRatio);
        });
        
        this.canvas.addEventListener('mousedown', (e) => {
            this.mouseDown = true;
            e.preventDefault();
        });
        
        this.canvas.addEventListener('mouseup', () => {
            this.mouseDown = false;
        });
        
        // Touch support
        const touchOptions = { passive: false };
        const handleTouch = (e) => {
            this.handleTouchInput(e);
        };
        this.canvas.addEventListener('touchstart', handleTouch, touchOptions);
        this.canvas.addEventListener('touchmove', handleTouch, touchOptions);
        this.canvas.addEventListener('touchend', handleTouch, touchOptions);
        this.canvas.addEventListener('touchcancel', handleTouch, touchOptions);

        // Prevent context menu
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        const updateDeviceClass = () => {
            this.isPhoneDevice = this.detectPhoneDevice();
        };
        window.addEventListener('resize', updateDeviceClass);
        window.addEventListener('orientationchange', updateDeviceClass);
    }

    update() {
        const player = this.engine.players.get(this.engine.playerId);
        if (!player || !player.alive) return;

        const moveLeftKey = this.keys['a'] || this.keys['arrowleft'] || false;
        const moveRightKey = this.keys['d'] || this.keys['arrowright'] || false;
        const jumpKey = this.keys['w'] || this.keys[' '] || this.keys['arrowup'] || false;
        const moveLeft = moveLeftKey || this.touchMoveLeft;
        const moveRight = moveRightKey || this.touchMoveRight;
        const jump = jumpKey || this.touchJumpQueued;

        // Build input state
        const input = {
            left: moveLeft,
            right: moveRight,
            jump,
            shoot: this.mouseDown,
            mouseX: this.mouseWorldX,
            mouseY: this.mouseWorldY
        };

        this.touchJumpQueued = false;

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
        
        // Smooth camera follow with horizontal wrapping
        const lerpFactor = 0.1;
        const dx = shortestWrappedDelta(targetX, this.engine.cameraX, this.engine.width);
        this.engine.cameraX = wrapHorizontal(this.engine.cameraX + dx * lerpFactor, this.engine.width);
        this.engine.cameraY += (targetY - this.engine.cameraY) * lerpFactor;
        
        // Clamp camera vertically to world bounds
        const halfViewHeight = this.canvas.height / (2 * this.engine.pixelSize);
        this.engine.cameraY = Math.max(halfViewHeight, Math.min(this.engine.cameraY, this.engine.height - halfViewHeight));
    }
    
    isKeyDown(key) {
        return this.keys[key.toLowerCase()] || false;
    }

    detectPhoneDevice() {
        const ua = (navigator.userAgent || '').toLowerCase();
        const maxTouch = navigator.maxTouchPoints || 0;
        const isMobileUA = /android|iphone|ipod|mobile|blackberry|iemobile|opera mini/.test(ua);
        const screenSize = Math.min(window.innerWidth || 0, window.innerHeight || 0);
        const smallScreen = screenSize > 0 ? screenSize <= 900 : true;
        return (isMobileUA || maxTouch > 1) && smallScreen;
    }

    handleTouchInput(e) {
        if (!this.canvas) return;
        if (e) {
            e.preventDefault();
        }

        const touches = Array.from((e && e.touches) || []);
        const rect = this.canvas.getBoundingClientRect();
        const rectWidth = rect.width || this.canvas.width;
        const rectHeight = rect.height || this.canvas.height;

        if (touches.length === 0) {
            this.touchControlsActive = false;
            this.touchMoveLeft = false;
            this.touchMoveRight = false;
            this.touchJumpActive = false;
            this.touchJumpQueued = false;
            this.mouseDown = false;
            return;
        }

        if (!rectWidth || !rectHeight) return;

        this.touchControlsActive = true;

        if (!this.isPhoneDevice) {
            this.touchMoveLeft = false;
            this.touchMoveRight = false;
            this.touchJumpActive = false;
            this.touchJumpQueued = false;
            const touch = touches[0];
            const xRatio = (touch.clientX - rect.left) / rectWidth;
            const yRatio = (touch.clientY - rect.top) / rectHeight;
            this.updateAimFromRatio(xRatio, yRatio);
            this.mouseDown = true;
            return;
        }

        const prevJumpActive = this.touchJumpActive;
        let currentJumpActive = false;
        let moveLeft = false;
        let moveRight = false;
        let aimActive = false;
        let aimVector = null;
        let aimMagnitudeSq = 0;

        const deadZone = 0.15;
        const aimDeadZone = 0.12;

        for (const touch of touches) {
            let xRatio = (touch.clientX - rect.left) / rectWidth;
            let yRatio = (touch.clientY - rect.top) / rectHeight;
            xRatio = Math.max(0, Math.min(1, xRatio));
            yRatio = Math.max(0, Math.min(1, yRatio));

            if (xRatio <= 0.5) {
                const normalized = xRatio / 0.5; // 0..1 across left half
                const offset = normalized - 0.5; // -0.5..0.5
                if (offset < -deadZone) moveLeft = true;
                if (offset > deadZone) moveRight = true;

                if (yRatio < 0.35) {
                    currentJumpActive = true;
                }
            } else {
                const relativeX = Math.max(-1, Math.min(1, (xRatio - 0.75) / 0.25));
                const relativeY = Math.max(-1, Math.min(1, (yRatio - 0.5) / 0.5));
                const magnitudeSq = relativeX * relativeX + relativeY * relativeY;
                if (!aimActive || magnitudeSq > aimMagnitudeSq) {
                    aimActive = true;
                    aimMagnitudeSq = magnitudeSq;
                    aimVector = { x: relativeX, y: relativeY };
                }
            }
        }

        if (currentJumpActive && !prevJumpActive) {
            this.touchJumpQueued = true;
        }
        this.touchJumpActive = currentJumpActive;
        this.touchMoveLeft = moveLeft;
        this.touchMoveRight = moveRight;

        if (aimActive && aimVector) {
            const magnitude = Math.sqrt(aimMagnitudeSq);
            const normalizedMagnitude = Math.min(1, magnitude || 0);

            if (magnitude > aimDeadZone) {
                const normFactor = magnitude > 0 ? 1 / magnitude : 1;
                this.lastAimVector.x = aimVector.x * normFactor;
                this.lastAimVector.y = aimVector.y * normFactor;
            }

            this.mouseDown = true;
            this.setAimDirection(this.lastAimVector.x, this.lastAimVector.y, normalizedMagnitude);
        } else {
            this.mouseDown = false;
        }
    }

    updateAimFromRatio(xRatio, yRatio) {
        const clampedX = Math.max(0, Math.min(1, xRatio));
        const clampedY = Math.max(0, Math.min(1, yRatio));
        const canvasX = clampedX * this.canvas.width;
        const canvasY = clampedY * this.canvas.height;
        this.updateAimFromCanvas(canvasX, canvasY);
    }

    updateAimFromCanvas(canvasX, canvasY) {
        this.mouseX = canvasX;
        this.mouseY = canvasY;

        const scale = this.engine.pixelSize;
        const camX = this.engine.cameraX - this.canvas.width / (2 * scale);
        const camY = this.engine.cameraY - this.canvas.height / (2 * scale);

        this.mouseWorldX = wrapHorizontal(canvasX / scale + camX, this.engine.width);
        this.mouseWorldY = canvasY / scale + camY;
        this.updateLastAimVector();
    }

    setAimDirection(dirX, dirY, magnitude = 1) {
        const player = this.engine.players.get(this.engine.playerId);
        if (!player) return;

        const norm = Math.hypot(dirX, dirY);
        const unitX = norm > 0 ? dirX / norm : 1;
        const unitY = norm > 0 ? dirY / norm : 0;

        const clampedMagnitude = Math.max(0, Math.min(1, magnitude));
        const minRadius = 12;
        const maxRadius = 48;
        const distance = minRadius + (maxRadius - minRadius) * clampedMagnitude;

        const centerX = wrapHorizontal(player.x + player.width / 2, this.engine.width);
        const centerY = player.y + player.height / 2;

        this.applyAimWorld(centerX + unitX * distance, centerY + unitY * distance);
    }

    applyAimWorld(worldX, worldY) {
        const wrappedX = wrapHorizontal(worldX, this.engine.width);
        const scale = this.engine.pixelSize;
        const dxToCamera = shortestWrappedDelta(wrappedX, this.engine.cameraX, this.engine.width);
        const dyToCamera = worldY - this.engine.cameraY;

        this.mouseWorldX = wrappedX;
        this.mouseWorldY = worldY;
        this.mouseX = this.canvas.width / 2 + dxToCamera * scale;
        this.mouseY = this.canvas.height / 2 + dyToCamera * scale;

        this.updateLastAimVector();
    }

    updateLastAimVector() {
        const player = this.engine.players.get(this.engine.playerId);
        if (!player) return;

        const centerX = wrapHorizontal(player.x + player.width / 2, this.engine.width);
        const centerY = player.y + player.height / 2;
        const dx = shortestWrappedDelta(this.mouseWorldX, centerX, this.engine.width);
        const dy = this.mouseWorldY - centerY;
        const length = Math.hypot(dx, dy);
        if (length > 0.0001) {
            this.lastAimVector.x = dx / length;
            this.lastAimVector.y = dy / length;
        }
    }
}
