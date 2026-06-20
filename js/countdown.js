
(function(global) {
    'use strict';

    // ============================================
    // GLOBAL TIMER MANAGER
    // ============================================
    const TimerManager = {
        _currentTime: Date.now(),
        serverOffset: 0,
        intervalId: null,
        listeners: new Set(),
        tickInterval: 1000,
        isSyncing: false,

        async syncWithServer() {
            if (this.isSyncing) return;
            this.isSyncing = true;
            try {
                if (window.supabaseClient) {
                    const start = performance.now();
                    const { data, error } = await window.supabaseClient.rpc('get_server_time');
                    const end = performance.now();

                    if (!error && data) {
                        const serverTime = new Date(data).getTime();
                        const latency = (end - start) / 2;
                        this.serverOffset = (serverTime + latency) - Date.now();
                    }
                }
            } catch (e) {
                console.warn('TimerManager: Server sync failed, using local clock.', e);
            } finally {
                this.isSyncing = false;
                this._updateInternalTime();
                this.notifyListeners();
            }
        },

        _updateInternalTime() {
            this._currentTime = Date.now() + this.serverOffset;
        },

        init() {
            if (this.intervalId) return;

            this.syncWithServer();
            this.intervalId = setInterval(() => {
                this._updateInternalTime();
                this.notifyListeners();
            }, this.tickInterval);

            if (!this._visibilityHandler) {
                this._visibilityHandler = () => {
                    if (document.visibilityState === 'visible') {
                        this.syncWithServer();
                    }
                };
                document.addEventListener('visibilitychange', this._visibilityHandler);
                window.addEventListener('focus', this._visibilityHandler);
            }
        },

        stop() {
            if (this.intervalId) {
                clearInterval(this.intervalId);
                this.intervalId = null;
            }
        },

        destroy() {
            this.stop();
            this.listeners.clear();
            if (this._visibilityHandler) {
                document.removeEventListener('visibilitychange', this._visibilityHandler);
                window.removeEventListener('focus', this._visibilityHandler);
                this._visibilityHandler = null;
            }
        },

        getTime() {
            return this._currentTime;
        },

        subscribe(callback) {
            this.listeners.add(callback);
            if (this.listeners.size === 1) {
                this.init();
            }
            // Immediate notification
            callback(this.getTime());
            return () => {
                this.listeners.delete(callback);
                if (this.listeners.size === 0) {
                    this.stop();
                }
            };
        },

        notifyListeners() {
            const now = this.getTime();
            this.listeners.forEach(cb => {
                try {
                    cb(now);
                } catch (e) {
                    console.error('TimerManager listener error:', e);
                }
            });
        }
    };

    // ============================================
    // COUNTDOWN CLASS (Enhanced for Multiple Schedules)
    // ============================================
    const CountdownRegistry = new WeakMap();

    class Countdown {
        _escape(str) {
            if (typeof window.escapeHtml === 'function') return window.escapeHtml(str);
            if (str === null || str === undefined) return '';
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        constructor(options = {}) {
            // Configuration with clarified naming
            this.schedules = Array.isArray(options.schedules) ? options.schedules : null;

            // Legacy/Single target support (remapped internally)
            this.targetDate = options.targetDate || options.target || null;
            this.startDate = options.startDate || options.startAt || null;
            this.referenceDate = options.referenceDate || options.startTime || options.start || null;

            this.onStart = options.onStart || null;
            this.onEnd = options.onEnd || null;
            this.onTick = options.onTick || null;

            this.className = options.className || '';
            this.showIcon = options.showIcon !== false;
            this.showProgress = options.showProgress === true;
            this.compact = options.compact === true;
            this.headless = options.headless === true;
            this.status = options.status || 'published';

            this.endLabel = options.endLabel !== undefined ? options.endLabel : 'Ended';
            this.upcomingLabel = options.upcomingLabel || 'Starts in';
            this.activeLabel = options.label || '';

            // Internal State
            this.container = null;
            this.mounted = false;
            this.unsubscribe = null;
            this._hasStartedCalled = false;
            this._hasEndedCalled = false;
            this._currentPhase = null; // 'upcoming', 'active', 'ended'
            this._activeScheduleIdx = -1;

            if (options.selector) {
                this.mount(options.selector);
            }
        }

        _parse(d) {
            if (d === null || d === undefined || d === '') return null;
            if (typeof d === 'number') return isNaN(d) ? null : d;
            if (typeof d === 'string' && /^\d+$/.test(d)) {
                const val = parseInt(d);
                return isNaN(val) ? null : val;
            }
            try {
                const ts = new Date(d).getTime();
                return isNaN(ts) ? null : ts;
            } catch (e) { return null; }
        }

        /**
         * Resolves the current applicable schedule from the provided array or single target.
         */
        _resolveActiveSchedule() {
            const now = TimerManager.getTime();

            // Case 1: Multiple Schedules (Maintenance, Recurring events)
            if (this.schedules && this.schedules.length > 0) {
                // Find currently active schedule
                const activeIdx = this.schedules.findIndex(s => {
                    const start = this._parse(s.startAt || s.startDate);
                    const end = this._parse(s.endAt || s.targetDate);
                    return start && end && now >= start && now <= end;
                });

                if (activeIdx !== -1) {
                    this._activeScheduleIdx = activeIdx;
                    const s = this.schedules[activeIdx];
                    return {
                        phase: 'active',
                        reference: this._parse(s.startAt || s.startDate),
                        start: this._parse(s.startAt || s.startDate),
                        target: this._parse(s.endAt || s.targetDate),
                        label: s.label || this.activeLabel,
                        endLabel: s.endLabel || this.endLabel
                    };
                }

                // Find next upcoming schedule
                const upcoming = this.schedules
                    .map((s, idx) => ({ s, idx, start: this._parse(s.startAt || s.startDate) }))
                    .filter(item => item.start && item.start > now)
                    .sort((a, b) => a.start - b.start)[0];

                if (upcoming) {
                    this._activeScheduleIdx = upcoming.idx;
                    const s = upcoming.s;
                    return {
                        phase: 'upcoming',
                        reference: this._parse(s.created_at) || now,
                        start: upcoming.start,
                        target: upcoming.start, // Target for "Starts in"
                        label: s.upcomingLabel || this.upcomingLabel
                    };
                }

                return { phase: 'ended' };
            }

            // Case 2: Single target (Assignments, Quizzes, etc.)
            const startTs = this._parse(this.startDate);
            const targetTs = this._parse(this.targetDate);
            const refTs = this._parse(this.referenceDate);

            if (!targetTs) return { phase: 'invalid' };

            if (startTs && now < startTs) {
                return {
                    phase: 'upcoming',
                    reference: refTs || now,
                    start: startTs,
                    target: startTs,
                    label: this.upcomingLabel
                };
            }

            if (now > targetTs) {
                return { phase: 'ended' };
            }

            return {
                phase: 'active',
                reference: startTs || refTs || now,
                start: startTs || refTs || now,
                target: targetTs,
                label: this.activeLabel
            };
        }

        calculateState() {
            const schedule = this._resolveActiveSchedule();
            const now = TimerManager.getTime();

            if (schedule.phase === 'ended') {
                return { phase: 'ended', total: 0, progress: 100, endLabel: schedule.endLabel || this.endLabel };
            }
            if (schedule.phase === 'invalid') return null;

            const difference = schedule.target - now;
            let progress = null;

            if (schedule.reference && schedule.target > schedule.reference) {
                const totalDuration = schedule.target - schedule.reference;
                const elapsed = now - schedule.reference;
                progress = Math.max(0, Math.min(100, (elapsed / totalDuration) * 100));
            }

            return {
                phase: schedule.phase,
                days: Math.floor(difference / (1000 * 60 * 60 * 24)),
                hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
                minutes: Math.floor((difference / 1000 / 60) % 60),
                seconds: Math.floor((difference / 1000) % 60),
                total: Math.max(0, difference),
                isSoon: difference > 0 && difference < 60 * 60 * 1000,
                progress: progress,
                label: schedule.label,
                endLabel: schedule.endLabel || this.endLabel
            };
        }

        mount(selector) {
            if (this.mounted) this.destroy();

            this.container = typeof selector === 'string'
                ? document.querySelector(selector)
                : selector;

            if (!this.container && !this.headless) {
                return this;
            }

            this.unsubscribe = TimerManager.subscribe(() => this.update());
            this.mounted = true;
            return this;
        }

        update() {
            if (!this.mounted) return;

            if (this.status === 'draft') {
                this._renderDraft();
                return;
            }

            const state = this.calculateState();
            if (!state) {
                if (this.container) this.container.innerHTML = '';
                return;
            }

            // Handle Transitions & Callbacks
            if (state.phase === 'active' && !this._hasStartedCalled) {
                this._hasStartedCalled = true;
                if (typeof this.onStart === 'function') this.onStart();
            }

            if (state.phase === 'ended') {
                this._renderEnded(state);
                if (!this._hasEndedCalled) {
                    this._hasEndedCalled = true;
                    if (typeof this.onEnd === 'function') this.onEnd();
                    // If no more schedules, we can stop polling for this instance
                    if (!this.schedules || this._activeScheduleIdx === -1 || this._activeScheduleIdx >= this.schedules.length - 1) {
                        this.destroy(false); // Unsubscribe but keep DOM
                    }
                }
                return;
            }

            // Reset ended flag if we transitioned to a new active/upcoming schedule
            this._hasEndedCalled = false;

            if (typeof this.onTick === 'function') this.onTick(state);

            if (this.container) {
                if (state.phase === 'upcoming') this._renderUpcoming(state);
                else this._renderActive(state);
            }
        }

        _renderDraft() {
            if (!this.container) return;
            this.container.innerHTML = `
                <div class="countdown-wrapper">
                    ${this.activeLabel ? `<div class="countdown-label small bold mb-5">${this._escape(this.activeLabel)}</div>` : ''}
                    <div class="countdown-draft ${this.className}">
                        ${this.showIcon ? this._getIcon(14) : ''}
                        <span class="countdown-label uppercase bold">Draft</span>
                    </div>
                </div>
            `;
        }

        _renderEnded(state) {
            if (!this.container) return;
            if (state.endLabel === null) {
                this.container.innerHTML = '';
            } else {
                this.container.innerHTML = `
                    <span class="countdown-ended ${this.className}">
                        ${this.showIcon ? this._getIcon(12) : ''}
                        <span class="countdown-label">${this._escape(state.endLabel)}</span>
                    </span>
                `;
            }
        }

        _renderUpcoming(state) {
            const timeStr = state.days > 0 ? `${state.days}d ${state.hours}h` :
                           state.hours > 0 ? `${state.hours}h ${state.minutes}m` : `${state.minutes}m`;

            this.container.innerHTML = `
                <div class="countdown-upcoming-wrapper">
                    <div class="countdown-upcoming inline-flex items-center gap-1 ${this.className}">
                        ${this.showIcon ? this._getIcon(12) : ''}
                        <span class="small-text">${this._escape(state.label)} ${timeStr}</span>
                    </div>
                    ${this._getProgressHtml(state)}
                </div>
            `;
        }

        _renderActive(state) {
            const { days, hours, minutes, seconds, isSoon, label } = state;
            const iconSize = this.compact ? 14 : 18;

            const timeClasses = [
                'countdown-display inline-flex items-center gap-2',
                isSoon ? 'countdown-soon' : 'countdown-normal',
                this.className
            ].filter(Boolean).join(' ');

            let html = `
                <div class="countdown-wrapper">
                    ${label ? `<div class="countdown-label small bold mb-5">${this._escape(label)}</div>` : ''}
                    <div class="${timeClasses}">
                        ${this.showIcon ? this._getIcon(iconSize) : ''}
                        <div class="countdown-values flex gap-1 font-mono font-bold text-sm md:text-base">
            `;

            if (days > 0) html += this._getUnitHtml(days, 'Days', 'd', false);
            if (days > 0 || hours > 0) html += this._getUnitHtml(hours, 'Hrs', 'h', true);
            html += this._getUnitHtml(minutes, 'Min', 'm', true);
            html += this._getUnitHtml(seconds, 'Sec', 's', true);

            html += `</div></div>${this._getProgressHtml(state)}</div>`;
            this.container.innerHTML = html;
        }

        _getUnitHtml(val, long, short, pad) {
            const displayVal = pad ? val.toString().padStart(2, '0') : val.toString();
            return `
                <div class="countdown-unit flex flex-col items-center">
                    <span>${displayVal}${this.compact ? short : ''}</span>
                    ${!!long && !this.compact ? `<span class="text-[8px] uppercase tracking-tighter -mt-1 opacity-60">${long}</span>` : ''}
                </div>
            `;
        }

        _getProgressHtml(state) {
            if (!this.showProgress || state.progress === null) return '';
            const urgencyClass = state.progress > 75 ? 'progress-critical' : (state.progress > 50 ? 'progress-warn' : 'progress-ok');
            return `
                <div class="countdown-progress-container mt-5">
                    <div class="countdown-progress-fill ${urgencyClass}" style="width: ${state.progress}%"></div>
                </div>
            `;
        }

        _getIcon(size) {
            return `
                <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"
                     viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
            `;
        }

        setTargetDate(newDate) {
            this.targetDate = newDate;
            this._hasEndedCalled = false;
            this._hasStartedCalled = false;
            if (this.mounted) this.update();
        }

        setOptions(options) {
            Object.assign(this, options);
            if (this.mounted) this.update();
        }

        destroy(clearContainer = true) {
            if (this.unsubscribe) {
                this.unsubscribe();
                this.unsubscribe = null;
            }
            if (clearContainer && this.container) {
                this.container.innerHTML = '';
            }
            this.mounted = false;
        }
    }

    // ============================================
    // STATIC HELPERS
    // ============================================
    Countdown.create = function(selector, options = {}) {
        const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
        if (!el && !options.headless) return null;

        if (el && CountdownRegistry.has(el)) {
            CountdownRegistry.get(el).destroy();
        }

        const ds = el ? el.dataset : {};
        const mergedOptions = {
            targetDate: options.targetDate || ds.target || ds.targetDate,
            referenceDate: options.referenceDate || ds.reference || ds.start || ds.startTime,
            startDate: options.startDate || ds.startDate || ds.startAt,
            activeLabel: options.label || ds.label || ds.activeLabel,
            status: options.status || ds.status,
            upcomingLabel: options.upcomingLabel || ds.upcomingLabel,
            endLabel: options.endLabel !== undefined ? options.endLabel : ds.endLabel,
            ...options
        };

        const instance = new Countdown({ ...mergedOptions, selector: el });
        if (el) CountdownRegistry.set(el, instance);
        return instance;
    };

    Countdown.createAll = function(selector, options) {
        const elements = document.querySelectorAll(selector);
        return Array.from(elements).map(el => Countdown.create(el, options));
    };

    global.TimerManager = TimerManager;
    global.Countdown = Countdown;

})(typeof window !== 'undefined' ? window : this);
