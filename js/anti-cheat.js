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
                DEVTOOLS_HEARTBEAT: true,

                PROCTORING_WEBCAM: false,
                PROCTORING_SCREEN: false,
                PROCTORING_FACE_DETECTION: false,
                PROCTORING_NOISE_DETECTION: false,

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
                sessionId: null, // Unique ID for this specific assessment attempt
                assessmentId: null,
                assessmentType: null, // 'quiz' or 'assignment'
                userEmail: null,
                startTime: null,
                lastViolationTime: {},
                sessionInfo: window.DeviceUtils ? window.DeviceUtils.getFullContext() : {
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
            this.proctor = null;
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
            if (this.state.isActive) await this.destroy();

            this.state.sessionId = 'asmt_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now();
            this.state.assessmentId = assessmentId;
            this.state.assessmentType = assessmentType;
            this.state.courseId = config.courseId || null;
            this.state.userEmail = userEmail;
            this.state.startTime = Date.now();
            this.state.isActive = true;

            // Re-sync device info in case of changes
            if (window.DeviceUtils) {
                this.state.sessionInfo = window.DeviceUtils.getFullContext();
            }

            this.configure(config);

            if (this.config.FULLSCREEN_REQUIRED) {
                this.initFullscreenHandlers();
                await this.enforceFullscreen();
            }

            if (this.config.MULTI_TAB_LOCK) this.initMultiTabLock();
            this.initEventBlocking();
            this.initLongPressDetection();
            this.initInputControl();
            this.initVisibilityDetection();
            this.initDevToolsDetection();
            await this.initProctoring();

            if (this.config.DEBUG) console.log('Anti-Cheat: Initialized', { assessmentId, assessmentType, config: this.config });
        }

        async initProctoring() {
            const webcam = this.config.PROCTORING_WEBCAM;
            const screen = this.config.PROCTORING_SCREEN;
            const face = this.config.PROCTORING_FACE_DETECTION;
            const noise = this.config.PROCTORING_NOISE_DETECTION;

            if (!webcam && !screen && !face && !noise) return;

            if (typeof ProctorEngine === 'undefined') {
                console.error('Anti-Cheat: ProctorEngine not found. Ensure js/proctor-engine.js is loaded.');
                return;
            }

            try {
                this.proctor = new ProctorEngine({
                    supabaseUrl: window.supabaseClient?.supabaseUrl,
                    supabaseKey: window.supabaseClient?.supabaseKey,
                    sessionId: this.state.sessionId,
                    attemptId: this.state.assessmentId,
                    courseId: this.state.courseId,
                    userId: this.state.userEmail,
                    debug: this.config.DEBUG,
                    webcam: { enabled: webcam },
                    screen: { enabled: screen },
                    faceDetection: { enabled: face },
                    noiseDetection: { enabled: noise },
                    callbacks: {
                        onViolation: (v) => this.injectViolation(v)
                    }
                });

                await this.proctor.start();
                if (this.config.DEBUG) console.log('Anti-Cheat: Proctoring started');
            } catch (err) {
                console.error('Anti-Cheat: Failed to start proctoring', err);
                this.logViolation('PROCTORING_FAILURE', { error: err.message });
            }
        }

        async injectViolation(violation) {
            // Forward from ProctorEngine to standard AntiCheat logging
            const metadata = violation.event_data || violation.data || violation;

            // Standardize severity for proctoring logs if not provided
            const logTypes = ['SESSION_STARTED', 'SESSION_ENDED', 'SNAPSHOT_CAPTURED', 'CHUNK_RECORDED', 'FACE_DETECTED', 'SCREEN_RECORDING_STARTED', 'SCREEN_RECORDING_FINALIZED', 'WEBCAM_SWITCHED'];
            const isLog = logTypes.includes(violation.type);
            const severity = violation.severity || (isLog ? 'INFO' : this.getViolationSeverity(violation.type));
            const score = violation.score || (isLog ? 0 : this.getViolationScore(violation.type));

            this.logViolation(violation.type, metadata, { severity, score, elapsed: violation.elapsed });
        }

        logViolation(type, metadata = {}, options = {}) {
            if (!this.state.isActive) return;

            const now = Date.now();
            const lastTime = this.state.lastViolationTime[type] || 0;

            // High-frequency logs (snapshots/chunks) bypass interval check
            const isHighFreq = ['SNAPSHOT_CAPTURED', 'CHUNK_RECORDED', 'FACE_DETECTED', 'NOISE_DETECTED'].includes(type);
            if (!isHighFreq && (now - lastTime < this.config.MIN_VIOLATION_INTERVAL)) return;

            this.state.lastViolationTime[type] = now;

            const severity = options.severity || this.getViolationSeverity(type);
            const score = options.score !== undefined ? options.score : this.getViolationScore(type);

            const violation = {
                session_id: this.state.sessionId,
                user_email: this.state.userEmail,
                assessment_id: this.state.assessmentId,
                assessment_type: this.state.assessmentType,
                course_id: this.state.courseId,
                type,
                browser: this.state.sessionInfo.browser || 'Unknown',
                device: this.state.sessionInfo.device || 'Unknown',
                os: this.state.sessionInfo.os || 'Unknown',
                device_info: this.state.sessionInfo,
                elapsed_time: options.elapsed || Math.max(0, now - (this.state.startTime || now)),
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
                if (v.severity === 'INFO') return; // Skip proctoring logs for stats

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

            // Don't re-enforce if already in fullscreen
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                const overlay = document.getElementById('anti-cheat-fullscreen-overlay');
                if (overlay) overlay.remove();
                return;
            }

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
                    const overlay = document.getElementById('anti-cheat-fullscreen-overlay');
                    if (overlay) overlay.remove();
                }
            } catch (err) {
                // If it fails, it might need user interaction or permissions
                if (this.config.DEBUG) console.warn('Anti-Cheat: Fullscreen enforcement failed', err);

                // Show overlay if fullscreen is required but failed
                if (this.config.FULLSCREEN_REQUIRED && !document.fullscreenElement && !document.webkitFullscreenElement) {
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

        // Unified Observer for Long Press and Input Control
        initDynamicElementHandling() {
            if (this.mutationObserver) return;

            const longPressEnabled = this.config.BLOCK_LONG_PRESS;
            const textSelectionEnabled = this.config.BLOCK_TEXT_SELECTION;
            if (!longPressEnabled && !textSelectionEnabled) return;

            const selectors = 'input:not([type="hidden"]), textarea, [contenteditable]';

            const setup = (el) => {
                if (el.dataset.anticheatApplied) return;
                el.dataset.anticheatApplied = 'true';

                // Text Selection Blocking
                if (textSelectionEnabled) {
                    el.addEventListener('selectstart', (e) => {
                        e.preventDefault();
                        this.logViolation('TEXT_SELECTION', { target: e.target.tagName });
                    });
                    el.style.userSelect = 'none';
                    el.style.webkitUserSelect = 'none';
                }

                // Long Press Detection
                if (longPressEnabled) {
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
                }
            };

            // Initial setup
            document.querySelectorAll(selectors).forEach(setup);

            // Observer for dynamic elements
            this.mutationObserver = new MutationObserver((mutations) => {
                mutations.forEach(m => {
                    // Re-enforce fullscreen if overlay was removed
                    if (this.config.FULLSCREEN_REQUIRED && this.state.isActive && !document.fullscreenElement) {
                        const overlay = document.getElementById('anti-cheat-fullscreen-overlay');
                        if (!overlay) this.showFullscreenOverlay();
                    }

                    m.addedNodes.forEach(node => {
                        if (node.nodeType === 1) {
                            if (node.matches(selectors)) setup(node);
                            node.querySelectorAll(selectors).forEach(setup);
                        }
                    });
                });
            });
            this.mutationObserver.observe(document.body, { childList: true, subtree: true });
        }

        initLongPressDetection() {
            this.initDynamicElementHandling();
        }

        initInputControl() {
            this.initDynamicElementHandling();
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

            // Multi-layered detection
            // Layer 1: Window size threshold
            const checkSize = () => {
                const threshold = this.config.DEVTOOLS_THRESHOLD;
                const widthDiff = Math.abs(window.outerWidth - window.innerWidth);
                const heightDiff = Math.abs(window.outerHeight - window.innerHeight);

                if (widthDiff > threshold || heightDiff > threshold) {
                    this.logViolation('DEVTOOLS_OPEN', {
                        method: 'size_check',
                        widthDiff,
                        heightDiff
                    });
                }
            };

            // Layer 2: Debugger heartbeat (Heartbeat timing check)
            const checkDebugger = () => {
                const start = performance.now();
                // This debugger statement will pause execution if DevTools is open
                // and the "Pause on exceptions" or similar is active.
                // If DevTools is NOT open, it completes instantly.
                debugger;
                const end = performance.now();
                if (end - start > 100) { // If it took more than 100ms, execution was likely paused
                    this.logViolation('DEVTOOLS_OPEN', {
                        method: 'debugger_heartbeat',
                        delay: Math.round(end - start)
                    });
                }
            };

            this.addGlobalListener(window, 'resize', () => {
                if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
                this.resizeTimeout = setTimeout(checkSize, 500);
            });

            // Initial check
            setTimeout(checkSize, 1000);

            // Periodic debugger check
            if (this.config.DEVTOOLS_HEARTBEAT) {
                this._devtoolsInterval = setInterval(checkDebugger, 2000);
            }
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
                'TEXT_SELECTION': 'LOW',
                'MULTIPLE_FACES': 'HIGH',
                'NOISE_DETECTED': 'MEDIUM',
                'PROCTORING_FAILURE': 'MEDIUM',
                'SESSION_STARTED': 'INFO',
                'SESSION_ENDED': 'INFO',
                'SNAPSHOT_CAPTURED': 'INFO',
                'CHUNK_RECORDED': 'INFO',
                'FACE_DETECTED': 'INFO',
                'SCREEN_RECORDING_STARTED': 'INFO',
                'SCREEN_RECORDING_FINALIZED': 'INFO',
                'WEBCAM_SWITCHED': 'INFO'
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
            return window.DeviceUtils ? window.DeviceUtils.getBrowser() : "Unknown";
        }

        getDeviceInfo() {
            return window.DeviceUtils ? window.DeviceUtils.getDevice() : "Unknown";
        }

        getOSInfo() {
            return window.DeviceUtils ? window.DeviceUtils.getOS() : "Unknown";
        }

        async destroy() {
            if (!this.state.isActive) return;

            this.state.isActive = false;

            // Stop Proctoring session and streams
            if (this.proctor) {
                try {
                    await this.proctor.stop();
                } catch (e) {
                    console.error('Anti-Cheat: Proctor stop failed', e);
                }
                this.proctor = null;
            }

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
            if (this._devtoolsInterval) {
                clearInterval(this._devtoolsInterval);
                this._devtoolsInterval = null;
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
