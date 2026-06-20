(function() {
    'use strict';

    /**
     * Anti-Cheat System for SmartLMS
     * Blocks copy/paste, DevTools, tab switching, and more based on configuration.
     */
    class AntiCheatSystem {
        constructor() {
            this.config = {
                DEBUG: false,
                FULLSCREEN_REQUIRED: false,
                MULTI_TAB_LOCK: false,
                BLOCK_COPY: false,
                BLOCK_PASTE: false,
                BLOCK_CUT: false,
                BLOCK_CONTEXT_MENU: false,
                BLOCK_KEYBOARD_SHORTCUTS: false,
                BLOCK_LONG_PRESS: false,
                BLOCK_TEXT_SELECTION: false,
                BLOCK_DRAG: false,
                BLOCK_DEVTOOLS: false,
                BLOCK_TAB_SWITCH: false,

                LONG_PRESS_THRESHOLD: 500,
                DEVTOOLS_THRESHOLD: 160,
                BLUR_THRESHOLD: 2000,
                MIN_VIOLATION_INTERVAL: 2000,

                callbacks: {
                    onViolation: null,
                    onBlocked: null
                }
            };

            this.state = {
                isActive: false,
                assessmentId: null,
                assessmentType: null, // 'quiz' or 'assignment'
                userEmail: null,
                startTime: null,
                lastViolationTime: {},
                sessionInfo: {
                    browser: this.getBrowserInfo(),
                    device: this.getDeviceInfo(),
                    os: this.getOSInfo()
                }
            };

            this.longPressTimers = new Map();
            this.focusLossTimer = null;
            this.resizeTimeout = null;
            this.tabChannel = null;
            this.mutationObserver = null;
            this.eventListeners = [];
        }

        configure(options = {}) {
            for (const key in options) {
                if (key === 'callbacks') {
                    Object.assign(this.config.callbacks, options.callbacks);
                } else if (this.config.hasOwnProperty(key)) {
                    this.config[key] = options[key];
                }
            }
        }

        async init(assessmentId, assessmentType, userEmail, config = {}) {
            if (this.state.isActive) this.destroy();

            this.state.assessmentId = assessmentId;
            this.state.assessmentType = assessmentType;
            this.state.userEmail = userEmail;
            this.state.startTime = Date.now();
            this.state.isActive = true;

            this.configure(config);

            if (this.config.FULLSCREEN_REQUIRED) {
                this.initFullscreenHandlers();
                this.enforceFullscreen();
            }

            if (this.config.MULTI_TAB_LOCK) this.initMultiTabLock();
            this.initEventBlocking();
            this.initLongPressDetection();
            this.initInputControl();
            this.initVisibilityDetection();
            this.initDevToolsDetection();

            if (this.config.DEBUG) console.log('Anti-Cheat: Initialized', { assessmentId, assessmentType, config: this.config });
        }

        logViolation(type, metadata = {}) {
            if (!this.state.isActive) return;

            const now = Date.now();
            const lastTime = this.state.lastViolationTime[type] || 0;
            if (now - lastTime < this.config.MIN_VIOLATION_INTERVAL) return;

            this.state.lastViolationTime[type] = now;

            const severity = this.getViolationSeverity(type);
            const score = this.getViolationScore(type);

            const violation = {
                user_email: this.state.userEmail,
                assessment_id: this.state.assessmentId,
                assessment_type: this.state.assessmentType,
                type,
                browser: this.state.sessionInfo.browser || 'Unknown',
                device: this.state.sessionInfo.device || 'Unknown',
                os: this.state.sessionInfo.os || 'Unknown',
                elapsed_time: Math.max(0, now - (this.state.startTime || now)),
                score: score || 0,
                severity: severity || 'LOW',
                metadata: {
                    ...metadata,
                    url: window.location.href,
                    visibilityState: document.visibilityState
                },
                timestamp: new Date(now).toISOString()
            };

            // Sync to DB if SupabaseDB is available
            if (window.SupabaseDB && typeof window.SupabaseDB.saveViolation === 'function') {
                window.SupabaseDB.saveViolation(violation).catch(err => {
                    if (this.config.DEBUG) console.error('Anti-Cheat: Sync failed', err, violation);
                });
            }

            // Callbacks
            if (this.config.callbacks.onViolation) {
                try {
                    this.config.callbacks.onViolation(violation);
                } catch (e) { console.error('Anti-Cheat: Callback failed', e); }
            }

            if (this.config.DEBUG) {
                console.log('Anti-Cheat Violation:', type, violation);
            }

            return violation;
        }

        calculateStats(violations) {
            const stats = {
                totalCount: violations.length,
                totalScore: 0,
                riskLevel: 'Low',
                lastViolation: 'None',
                topViolation: 'None',
                tabSwitchCount: 0,
                blockedActionCount: 0,
                criticalCount: 0,
                highCount: 0,
                lowCount: 0
            };

            if (violations.length === 0) return stats;

            const counts = {};
            violations.forEach(v => {
                const type = v.type;
                counts[type] = (counts[type] || 0) + 1;
                stats.totalScore += v.score || 0;

                if (v.severity === 'CRITICAL') stats.criticalCount++;
                else if (v.severity === 'HIGH') stats.highCount++;
                else stats.lowCount++;

                if (type === 'TAB_SWITCH') stats.tabSwitchCount++;
                if (type.includes('_ATTEMPT') || type.includes('BLOCK_')) stats.blockedActionCount++;
            });

            stats.lastViolation = violations[0].type.replace(/_/g, ' ');

            let maxCount = 0;
            for (const type in counts) {
                if (counts[type] > maxCount) {
                    maxCount = counts[type];
                    stats.topViolation = type.replace(/_/g, ' ');
                }
            }

            if (stats.totalScore >= 20 || stats.criticalCount > 0) stats.riskLevel = 'High';
            else if (stats.totalScore >= 10 || stats.highCount > 1) stats.riskLevel = 'Medium';

            return stats;
        }

        addGlobalListener(target, type, handler, options) {
            target.addEventListener(type, handler, options);
            this.eventListeners.push({ target, type, handler, options });
        }

        // Fullscreen
        initFullscreenHandlers() {
            const handler = () => {
                if (this.config.FULLSCREEN_REQUIRED && !document.fullscreenElement && this.state.isActive) {
                    this.logViolation('EXIT_FULLSCREEN', { reason: 'exited fullscreen' });
                    this.enforceFullscreen();
                }
            };
            this.addGlobalListener(document, 'fullscreenchange', handler);
            this.addGlobalListener(document, 'webkitfullscreenchange', handler);
        }

        async enforceFullscreen() {
            if (!this.config.FULLSCREEN_REQUIRED || !this.state.isActive) return;

            try {
                const docEl = document.documentElement;
                let promise;
                if (docEl.requestFullscreen) {
                    promise = docEl.requestFullscreen();
                } else if (docEl.webkitRequestFullscreen) {
                    promise = docEl.webkitRequestFullscreen();
                }

                if (promise) {
                    await promise;
                }
            } catch (err) {
                // If it fails, it might need user interaction or permissions
                if (this.config.DEBUG) console.warn('Anti-Cheat: Fullscreen enforcement failed', err);

                // Show overlay if fullscreen is required but failed
                if (this.config.FULLSCREEN_REQUIRED && !document.fullscreenElement) {
                    this.showFullscreenOverlay();
                }
            }
        }

        showFullscreenOverlay() {
            if (document.getElementById('anti-cheat-fullscreen-overlay')) return;

            const overlay = document.createElement('div');
            overlay.id = 'anti-cheat-fullscreen-overlay';
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.95);
                z-index: 999999;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                color: white;
                text-align: center;
                padding: 20px;
                font-family: sans-serif;
            `;

            overlay.innerHTML = `
                <div style="max-width: 500px;">
                    <h2 style="margin-bottom: 20px; color: #ff4d4d;">Security Required</h2>
                    <p style="margin-bottom: 30px; font-size: 1.1rem; line-height: 1.5;">
                        This assessment requires Fullscreen Mode to ensure academic integrity.
                        Please click the button below to re-enter fullscreen and continue.
                    </p>
                    <button id="re-enter-fullscreen-btn" style="
                        background: #5b2ea6;
                        color: white;
                        border: none;
                        padding: 15px 40px;
                        font-size: 1.2rem;
                        border-radius: 8px;
                        cursor: pointer;
                        font-weight: bold;
                        transition: background 0.2s;
                    ">Re-enter Fullscreen</button>
                </div>
            `;

            document.body.appendChild(overlay);

            const btn = document.getElementById('re-enter-fullscreen-btn');
            btn.onmouseover = () => btn.style.background = '#4a2586';
            btn.onmouseout = () => btn.style.background = '#5b2ea6';

            btn.onclick = async () => {
                await this.enforceFullscreen();
                if (document.fullscreenElement) {
                    overlay.remove();
                }
            };
        }

        // Multi-tab
        initMultiTabLock() {
            if (!window.BroadcastChannel) return;
            this.tabChannel = new BroadcastChannel('anticheat_tab_' + this.state.assessmentId);
            const tabId = Math.random().toString(36).substring(2);

            this.tabChannel.onmessage = (e) => {
                if (e.data === 'PING') {
                    this.tabChannel.postMessage('PONG_' + tabId);
                } else if (e.data.startsWith('PONG_') && e.data !== 'PONG_' + tabId) {
                    this.logViolation('MULTIPLE_TABS', { reason: 'another tab detected' });
                }
            };

            this._tabInterval = setInterval(() => this.tabChannel.postMessage('PING'), 5000);
        }

        // Event Blocking
        initEventBlocking() {
            const block = (e, type, details = {}) => {
                e.preventDefault();
                this.logViolation(type, details);
                if (this.config.callbacks.onBlocked) this.config.callbacks.onBlocked(type);
                return false;
            };

            if (this.config.BLOCK_CONTEXT_MENU) {
                this.addGlobalListener(document, 'contextmenu', (e) => block(e, 'RIGHT_CLICK', { target: e.target.tagName }), { passive: false });
            }

            if (this.config.BLOCK_COPY) {
                this.addGlobalListener(document, 'copy', (e) => block(e, 'COPY_ATTEMPT', { target: e.target?.tagName }), { passive: false });
            }

            if (this.config.BLOCK_PASTE) {
                this.addGlobalListener(document, 'paste', (e) => block(e, 'PASTE_ATTEMPT', { target: e.target?.tagName }), { passive: false });
            }

            if (this.config.BLOCK_CUT) {
                this.addGlobalListener(document, 'cut', (e) => block(e, 'CUT_ATTEMPT', { target: e.target?.tagName }), { passive: false });
            }

            if (this.config.BLOCK_DRAG) {
                this.addGlobalListener(document, 'dragstart', (e) => block(e, 'DRAG_ATTEMPT', { target: e.target?.tagName }), { passive: false });
                this.addGlobalListener(document, 'drop', (e) => block(e, 'DROP_ATTEMPT', {}), { passive: false });
            }

            if (this.config.BLOCK_KEYBOARD_SHORTCUTS) {
                this.addGlobalListener(document, 'keydown', (e) => this.handleKeydown(e), { passive: false });
            }
        }

        handleKeydown(e) {
            const ctrl = e.ctrlKey || e.metaKey;
            const shift = e.shiftKey;
            const alt = e.altKey;
            const key = e.key;

            let violated = false;
            let type = '';
            let shortcut = '';

            if (key === 'F12') {
                violated = true; type = 'DEVTOOLS_ATTEMPT'; shortcut = 'F12';
            } else if (ctrl && shift && ['I', 'J', 'C'].includes(key.toUpperCase())) {
                violated = true; type = 'DEVTOOLS_ATTEMPT'; shortcut = `Ctrl+Shift+${key}`;
            } else if (ctrl && alt && ['U', 'A'].includes(key.toUpperCase())) {
                violated = true; type = 'DEVTOOLS_ATTEMPT'; shortcut = `Ctrl+Alt+${key}`;
            } else if (ctrl && key.toUpperCase() === 'U') {
                violated = true; type = 'VIEW_SOURCE_ATTEMPT'; shortcut = 'Ctrl+U';
            } else if (key === 'PrintScreen') {
                violated = true; type = 'SCREENSHOT_ATTEMPT'; shortcut = 'PrintScreen';
            }

            if (violated) {
                e.preventDefault();
                this.logViolation(type, { shortcut });
                if (this.config.callbacks.onBlocked) this.config.callbacks.onBlocked(type);
                return false;
            }
        }

        // Long Press Detection
        initLongPressDetection() {
            if (!this.config.BLOCK_LONG_PRESS) return;
            const selectors = 'input:not([type="hidden"]), textarea, [contenteditable]';

            const setup = (el) => {
                let timer = null;
                const start = (e) => {
                    if (!this.state.isActive) return;
                    timer = setTimeout(() => {
                        this.logViolation('LONG_PRESS', { target: e.target.tagName });
                        if (this.config.callbacks.onBlocked) this.config.callbacks.onBlocked('LONG_PRESS');
                        window.getSelection()?.removeAllRanges();
                    }, this.config.LONG_PRESS_THRESHOLD);
                };
                const end = () => { if (timer) clearTimeout(timer); };

                el.addEventListener('mousedown', start);
                el.addEventListener('mouseup', end);
                el.addEventListener('mouseleave', end);
                el.addEventListener('touchstart', start);
                el.addEventListener('touchend', end);
                el.addEventListener('touchmove', end);
            };

            document.querySelectorAll(selectors).forEach(setup);
            this.mutationObserver = new MutationObserver((mutations) => {
                mutations.forEach(m => m.addedNodes.forEach(node => {
                    if (node.nodeType === 1) {
                        if (node.matches(selectors)) setup(node);
                        node.querySelectorAll(selectors).forEach(setup);
                    }
                }));
            });
            this.mutationObserver.observe(document.body, { childList: true, subtree: true });
        }

        // Input Control
        initInputControl() {
            if (!this.config.BLOCK_TEXT_SELECTION) return;
            const selectors = 'input:not([type="hidden"]), textarea, [contenteditable]';
            const setup = (el) => {
                el.addEventListener('selectstart', (e) => {
                    e.preventDefault();
                    this.logViolation('TEXT_SELECTION', { target: e.target.tagName });
                });
                el.style.userSelect = 'none';
                el.style.webkitUserSelect = 'none';
            };
            document.querySelectorAll(selectors).forEach(setup);
        }

        // Visibility
        initVisibilityDetection() {
            if (!this.config.BLOCK_TAB_SWITCH) return;
            this.addGlobalListener(document, 'visibilitychange', () => {
                if (document.hidden && this.state.isActive) {
                    this.focusLossTimer = setTimeout(() => {
                        this.logViolation('TAB_SWITCH', {});
                    }, this.config.BLUR_THRESHOLD);
                } else if (!document.hidden && this.focusLossTimer) {
                    clearTimeout(this.focusLossTimer);
                    this.focusLossTimer = null;
                }
            });
        }

        // DevTools Detection
        initDevToolsDetection() {
            if (!this.config.BLOCK_DEVTOOLS) return;
            const check = () => {
                const threshold = this.config.DEVTOOLS_THRESHOLD;
                if (Math.abs(window.outerWidth - window.innerWidth) > threshold || Math.abs(window.outerHeight - window.innerHeight) > threshold) {
                    this.logViolation('DEVTOOLS_OPEN', {});
                }
            };
            this.addGlobalListener(window, 'resize', () => {
                if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
                this.resizeTimeout = setTimeout(check, 500);
            });
            setTimeout(check, 1000);
        }

        getViolationSeverity(type) {
            const weights = {
                'TAB_SWITCH': 'HIGH',
                'DEVTOOLS_OPEN': 'CRITICAL',
                'DEVTOOLS_ATTEMPT': 'HIGH',
                'VIEW_SOURCE_ATTEMPT': 'HIGH',
                'SCREENSHOT_ATTEMPT': 'HIGH',
                'RIGHT_CLICK': 'LOW',
                'COPY_ATTEMPT': 'LOW',
                'PASTE_ATTEMPT': 'LOW',
                'CUT_ATTEMPT': 'LOW',
                'DRAG_ATTEMPT': 'LOW',
                'DROP_ATTEMPT': 'LOW',
                'EXIT_FULLSCREEN': 'HIGH',
                'MULTIPLE_TABS': 'CRITICAL',
                'LONG_PRESS': 'LOW',
                'TEXT_SELECTION': 'LOW'
            };
            return weights[type] || 'LOW';
        }

        getViolationScore(type) {
            const severity = this.getViolationSeverity(type);
            const scores = {
                'CRITICAL': 5,
                'HIGH': 3,
                'LOW': 2
            };
            return scores[severity] || 2;
        }

        getBrowserInfo() {
            const ua = navigator.userAgent;
            if (ua.includes("Firefox")) return "Firefox";
            if (ua.includes("SamsungBrowser")) return "Samsung Browser";
            if (ua.includes("Opera") || ua.includes("OPR")) return "Opera";
            if (ua.includes("Trident")) return "Internet Explorer";
            if (ua.includes("Edge")) return "Edge";
            if (ua.includes("Chrome")) return "Chrome";
            if (ua.includes("Safari")) return "Safari";
            return "Unknown Browser";
        }

        getDeviceInfo() {
            const ua = navigator.userAgent;
            if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) return "Tablet";
            if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) return "Mobile";
            return "Desktop";
        }

        getOSInfo() {
            const ua = navigator.userAgent;
            if (ua.indexOf("Win") !== -1) return "Windows";
            if (ua.indexOf("Mac") !== -1) return "MacOS";
            if (ua.indexOf("X11") !== -1) return "UNIX";
            if (ua.indexOf("Linux") !== -1) return "Linux";
            if (ua.indexOf("Android") !== -1) return "Android";
            if (ua.indexOf("like Mac") !== -1) return "iOS";
            return "Unknown OS";
        }

        destroy() {
            if (!this.state.isActive) return;

            this.state.isActive = false;
            if (this._tabInterval) {
                clearInterval(this._tabInterval);
                this._tabInterval = null;
            }
            if (this.tabChannel) {
                this.tabChannel.close();
                this.tabChannel = null;
            }
            if (this.mutationObserver) {
                this.mutationObserver.disconnect();
                this.mutationObserver = null;
            }
            if (this.focusLossTimer) {
                clearTimeout(this.focusLossTimer);
                this.focusLossTimer = null;
            }
            if (this.resizeTimeout) {
                clearTimeout(this.resizeTimeout);
                this.resizeTimeout = null;
            }

            this.eventListeners.forEach(l => {
                l.target.removeEventListener(l.type, l.handler, l.options);
            });
            this.eventListeners = [];

            if (this.config.DEBUG) console.log('Anti-Cheat: Destroyed');

            // Remove any anti-cheat overlays
            const overlay = document.getElementById('anti-cheat-fullscreen-overlay');
            if (overlay) overlay.remove();

            // Try to exit fullscreen if we forced it
            if (document.fullscreenElement) {
                try {
                    if (document.exitFullscreen) document.exitFullscreen();
                    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
                } catch (e) {}
            }
        }
    }

    window.AntiCheat = new AntiCheatSystem();
})();
