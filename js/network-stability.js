/**
 * SmartLMS Network Stability Detection Engine
 * Senior Enterprise-Grade Production Implementation
 *
 * Monitors network indicators (navigator.onLine, real-time RTT via favicon probes,
 * standard navigator.connection stats, offline/online transitions) and detects
 * network stability without affecting any application workflows or behavior.
 */

class NetworkStabilityEngine {
    constructor() {
        if (NetworkStabilityEngine.instance) {
            return NetworkStabilityEngine.instance;
        }
        NetworkStabilityEngine.instance = this;

        this.status = '🟢 Online'; // Default legacy status for backward compatibility
        this.connectionStatus = navigator.onLine ? "Online" : "Offline"; // Simple internet connection status
        this.stabilityStatus = this.connectionStatus === "Offline" ? "Unknown" : "Stable"; // Separated network stability status

        this.probes = []; // Rolling window of recent latency metrics
        this.maxProbes = 6; // last 60 seconds (with 10s intervals)
        this.disconnects = []; // Timestamps of offline transitions
        this.disconnectWindowMs = 120000; // 2 minutes window to track frequent disconnects
        this.probeIntervalMs = 10000; // Probe every 10 seconds
        this.probeTimeoutMs = 5000; // 5 seconds timeout
        this.listeners = new Set();
        this.containerElement = null;

        this.activeController = null;
        this.activeTimeoutId = null;
        this.nextProbeTimeoutId = null;

        this.initialized = false;

        // Bind handlers as non-anonymous class members to enable complete and clean memory cleanup
        this.boundOnlineHandler = () => this.handleConnectionChange(true);
        this.boundOfflineHandler = () => this.handleConnectionChange(false);
        this.boundDOMContentLoadedHandler = () => this.renderUI();
        this.boundVisibilityChangeHandler = () => {
            if (document.visibilityState === 'visible') {
                this.runProbe();
            } else if (document.visibilityState === 'hidden') {
                if (this.nextProbeTimeoutId) {
                    clearTimeout(this.nextProbeTimeoutId);
                    this.nextProbeTimeoutId = null;
                }
                this.cancelActiveProbe();
            }
        };

        this.init();
    }

    init() {
        if (this.initialized) return;
        this.initialized = true;

        // Track disconnects via window events
        window.addEventListener('online', this.boundOnlineHandler);
        window.addEventListener('offline', this.boundOfflineHandler);
        document.addEventListener('visibilitychange', this.boundVisibilityChangeHandler);

        // Start sequential probing
        this.runProbe();

        // Inject UI
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', this.boundDOMContentLoadedHandler);
        } else {
            this.renderUI();
        }
    }

    cancelActiveProbe() {
        if (this.activeController) {
            try {
                this.activeController.abort();
            } catch (e) {}
            this.activeController = null;
        }
        if (this.activeTimeoutId) {
            clearTimeout(this.activeTimeoutId);
            this.activeTimeoutId = null;
        }
    }

    scheduleNextProbe(delay = this.probeIntervalMs) {
        if (this.nextProbeTimeoutId) {
            clearTimeout(this.nextProbeTimeoutId);
            this.nextProbeTimeoutId = null;
        }
        if (!this.initialized || document.visibilityState === 'hidden') {
            return;
        }
        this.nextProbeTimeoutId = setTimeout(async () => {
            if (this.initialized && document.visibilityState !== 'hidden') {
                await this.runProbe();
            }
        }, delay);
    }

    /**
     * Records browser online/offline transitions.
     */
    handleConnectionChange(isOnline) {
        if (!isOnline) {
            this.disconnects.push(Date.now());
            // Filter old disconnects out of the tracking window
            this.cleanDisconnectHistory();
            this.evaluateStatus();
        } else {
            // Clears probes when transitioning back online to avoid misleading packet loss metrics from offline period
            this.probes = [];
            this.evaluateStatus();
            // Trigger an immediate probe to refresh status without waiting up to 10 seconds
            this.runProbe();
        }
    }

    cleanDisconnectHistory() {
        const now = Date.now();
        this.disconnects = this.disconnects.filter(time => now - time <= this.disconnectWindowMs);
    }

    /**
     * Active favicon probe check to measure precise RTT/latency & packet loss.
     */
    async runProbe() {
        // Clear any pending scheduled timeout so that runProbe acts as the exclusive orchestrator
        if (this.nextProbeTimeoutId) {
            clearTimeout(this.nextProbeTimeoutId);
            this.nextProbeTimeoutId = null;
        }

        // If navigator.onLine is false, don't even try to fetch
        if (navigator.onLine === false) {
            this.recordProbeResult(null, false, false);
            this.scheduleNextProbe();
            return;
        }

        // Clean up previous active probe if any is running
        this.cancelActiveProbe();

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        this.activeController = controller;
        const timeoutId = setTimeout(() => {
            if (controller) {
                try {
                    controller.abort();
                } catch (e) {}
            }
        }, this.probeTimeoutMs);
        this.activeTimeoutId = timeoutId;

        const startTime = performance.now();
        const cacheBuster = Date.now();

        try {
            // Using HEAD request is lighter than GET, fallback to GET if HEAD is not allowed
            const response = await fetch(`${window.location.origin}/favicon.ico?_cb=${cacheBuster}`, {
                method: 'HEAD',
                signal: controller ? controller.signal : undefined,
                cache: 'no-store',
                mode: 'same-origin'
            });

            if (this.activeTimeoutId === timeoutId) {
                clearTimeout(timeoutId);
                this.activeTimeoutId = null;
                this.activeController = null;
            }

            // Genuinely online if we can request and fetch successfully
            const wasOnline = navigator.onLine;

            const endTime = performance.now();
            const latency = endTime - startTime;

            this.recordProbeResult(latency, response.ok || response.status < 400, wasOnline);
            this.scheduleNextProbe();
        } catch (error) {
            if (this.activeTimeoutId === timeoutId) {
                clearTimeout(timeoutId);
                this.activeTimeoutId = null;
                this.activeController = null;
            }

            // If we were destroyed or a newer probe started, stop executing
            if (!this.initialized || !this.boundOnlineHandler) return;
            if (this.activeController !== controller && controller !== null) {
                this.scheduleNextProbe();
                return;
            }

            let altTimeoutId;
            let altController = null;
            try {
                altController = typeof AbortController !== 'undefined' ? new AbortController() : null;
                this.activeController = altController;
                altTimeoutId = setTimeout(() => {
                    if (altController) {
                        try {
                            altController.abort();
                        } catch (e) {}
                    }
                }, this.probeTimeoutMs);
                this.activeTimeoutId = altTimeoutId;
                const altStartTime = performance.now();

                const response = await fetch(`${window.location.origin}/favicon.ico?_cb=${cacheBuster}`, {
                    method: 'GET',
                    signal: altController ? altController.signal : undefined,
                    cache: 'no-store',
                    mode: 'same-origin'
                });

                if (this.activeTimeoutId === altTimeoutId) {
                    clearTimeout(altTimeoutId);
                    this.activeTimeoutId = null;
                    this.activeController = null;
                }

                // If we were destroyed or a newer probe took over during fetch, abort recording
                if (!this.initialized || !this.boundOnlineHandler) return;
                if (this.activeController !== altController && altController !== null) {
                    this.scheduleNextProbe();
                    return;
                }

                const wasOnline = navigator.onLine;
                const altEndTime = performance.now();
                const latency = altEndTime - altStartTime;

                this.recordProbeResult(latency, response.ok, wasOnline);
                this.scheduleNextProbe();
            } catch (err) {
                if (this.activeTimeoutId === altTimeoutId) {
                    clearTimeout(altTimeoutId);
                    this.activeTimeoutId = null;
                    this.activeController = null;
                }

                // If we were destroyed or a newer probe took over, stop executing
                if (!this.initialized || !this.boundOnlineHandler) return;
                if (this.activeController !== altController && altController !== null) {
                    this.scheduleNextProbe();
                    return;
                }

                const wasOnline = navigator.onLine;
                // Genuinely failed to reach server
                this.recordProbeResult(null, false, wasOnline);
                this.scheduleNextProbe();
            }
        }
    }

    recordProbeResult(latency, success, wasOnline = true) {
        this.probes.push({
            timestamp: Date.now(),
            latency: success ? latency : null,
            success,
            wasOnline
        });

        // Maintain rolling sliding window
        if (this.probes.length > this.maxProbes) {
            this.probes.shift();
        }

        this.evaluateStatus();
    }

    /**
     * Core status classification logic matching production specifications.
     */
    evaluateStatus() {
        this.cleanDisconnectHistory();

        // Separate network stability status from simple internet connection status
        let connectionStatus = navigator.onLine ? "Online" : "Offline";

        // Filter probes to only those recorded while browser reported being online
        const validProbes = this.probes.filter(p => p.wasOnline !== false);

        // If the latest probes consecutively failed (e.g., last 2 attempts failed) or all failed, mark offline
        if (validProbes.length >= 2 && validProbes.slice(-2).every(p => !p.success)) {
            connectionStatus = "Offline";
        }

        let stabilityStatus = "Unknown";

        if (connectionStatus === "Offline") {
            stabilityStatus = "Unknown";
        } else if (connectionStatus === "Online") {
            // Evaluate actual network quality
            stabilityStatus = this.evaluateNetworkStability();
        }

        const previousConnectionStatus = this.connectionStatus;
        this.connectionStatus = connectionStatus;
        this.stabilityStatus = stabilityStatus;

        // Transition check: clear probes on reconnection
        if (previousConnectionStatus === "Offline" && this.connectionStatus === "Online") {
            // Preserve the successful probe that triggered the recovery by filtering out failed probes
            this.probes = this.probes.filter(p => p.success);
            // Re-evaluate stability status with clean probes
            this.stabilityStatus = this.evaluateNetworkStability();
        }

        // Map stabilityStatus and connectionStatus back to the legacy this.status for backward compatibility
        let legacyStatus = '🟢 Online';
        if (this.connectionStatus === "Offline") {
            legacyStatus = '🔴 Offline';
        } else {
            if (this.stabilityStatus === 'Unstable Network') {
                legacyStatus = '🟠 Unstable Network';
            } else if (this.stabilityStatus === 'Poor Network') {
                legacyStatus = '🟡 Poor Network';
            } else {
                legacyStatus = '🟢 Online';
            }
        }

        this.updateStatus(legacyStatus);
    }

    /**
     * Evaluates actual network quality when the simple connection status is "Online".
     * Returns "Stable", "Poor Network", or "Unstable Network".
     */
    evaluateNetworkStability() {
        const validProbes = this.probes.filter(p => p.wasOnline !== false);
        const totalProbes = validProbes.length;

        if (totalProbes === 0) {
            return 'Stable';
        }

        const successfulProbes = validProbes.filter(p => p.success);
        const successCount = successfulProbes.length;
        const failureCount = totalProbes - successCount;
        const packetLossRate = totalProbes > 0 ? (failureCount / totalProbes) : 0;

        // High packet loss, frequent disconnects (>= 2 in last 2m), or high jitter
        const disconnectCount = this.disconnects.length;
        const rttValues = successfulProbes.map(p => p.latency);

        let avgLatency = 0;
        let jitter = 0;

        if (rttValues.length > 0) {
            avgLatency = rttValues.reduce((a, b) => a + b, 0) / rttValues.length;

            if (rttValues.length > 1) {
                // Mean absolute deviation of successive latency values (jitter indicator)
                let diffs = 0;
                for (let i = 1; i < rttValues.length; i++) {
                    diffs += Math.abs(rttValues[i] - rttValues[i - 1]);
                }
                jitter = diffs / (rttValues.length - 1);
            }
        }

        // Check navigator.connection metrics if available
        let navRtt = null;
        let navDownlink = null;
        if (navigator.connection) {
            navRtt = navigator.connection.rtt; // in ms
            navDownlink = navigator.connection.downlink; // in Mbps
        }

        const isPacketLossUnstable = packetLossRate > 0 && packetLossRate < 1;
        const isFrequentDisconnects = disconnectCount >= 2;
        // Fluctuating latency: standard deviation/variance is high (jitter > 80ms)
        const isFluctuatingLatency = jitter > 80 && avgLatency > 100;

        if (isPacketLossUnstable || isFrequentDisconnects || isFluctuatingLatency) {
            return 'Unstable Network';
        }

        // Detect Poor Network
        // High latency (avgLatency > 200ms or navRtt > 300ms) OR reduced bandwidth (downlink < 1.0 Mbps)
        const isHighLatency = avgLatency > 200 || (navRtt && navRtt > 300);
        const isReducedBandwidth = (navDownlink && navDownlink < 1.0);

        if (isHighLatency || isReducedBandwidth) {
            return 'Poor Network';
        }

        return 'Stable';
    }

    updateStatus(newStatus) {
        if (this.status !== newStatus) {
            const oldStatus = this.status;
            this.status = newStatus;
            this.triggerListeners(newStatus, oldStatus);
        }
        this.updateUI();
    }

    onStatusChange(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    triggerListeners(newStatus, oldStatus) {
        this.listeners.forEach(cb => {
            try {
                cb(newStatus, oldStatus);
            } catch (e) {
                console.error('[NetworkStabilityEngine] Listener error:', e);
            }
        });
    }

    getStatus() {
        return this.status;
    }

    getDetails() {
        const onlineProbes = this.probes.filter(p => p.wasOnline !== false);
        const successfulProbes = onlineProbes.filter(p => p.success);
        const rttValues = successfulProbes.map(p => p.latency);

        let avgLatency = 0;
        let jitter = 0;

        if (rttValues.length > 0) {
            avgLatency = rttValues.reduce((a, b) => a + b, 0) / rttValues.length;
            if (rttValues.length > 1) {
                let diffs = 0;
                for (let i = 1; i < rttValues.length; i++) {
                    diffs += Math.abs(rttValues[i] - rttValues[i - 1]);
                }
                jitter = diffs / (rttValues.length - 1);
            }
        }

        const totalProbes = onlineProbes.length;
        const packetLossRate = totalProbes > 0 ? ((totalProbes - successfulProbes.length) / totalProbes) * 100 : 0;

        let navRtt = null;
        let navDownlink = null;
        if (navigator.connection) {
            navRtt = navigator.connection.rtt;
            navDownlink = navigator.connection.downlink;
        }

        return {
            status: this.status,
            connectionStatus: this.connectionStatus,
            stabilityStatus: this.stabilityStatus,
            latency: rttValues.length > 0 ? Math.round(avgLatency) : (navRtt || 0),
            jitter: Math.round(jitter),
            packetLoss: Math.round(packetLossRate),
            bandwidth: navDownlink || 'N/A',
            disconnects: this.disconnects.length,
            navigatorOnLine: navigator.onLine
        };
    }

    attachToHeader() {
        if (!this.containerElement) return;

        // Try to find the dashboard header or landing header container
        // Priority 1: .dashboard-header .header-right (inside dashboard headers)
        // Priority 2: .landing-header .nav-links (inside landing header)
        // Priority 3: Fallback standard header tag or nav links
        const targetHeader = document.querySelector(".dashboard-header .header-right") ||
                             document.querySelector(".landing-header .nav-links") ||
                             document.querySelector("header .nav-links") ||
                             document.querySelector("header") ||
                             document.querySelector(".header-right");

        if (targetHeader) {
            // Prepend or insert before first element so it integrates naturally without breaking existing components
            if (this.containerElement.parentNode !== targetHeader) {
                targetHeader.insertBefore(this.containerElement, targetHeader.firstChild);
            }
        } else {
            // True fallback to document.body if absolutely no header layout elements exist
            if (this.containerElement.parentNode !== document.body) {
                document.body.appendChild(this.containerElement);
                // Style fallback to keep it fixed if it sits in the body
                this.containerElement.style.position = "fixed";
                this.containerElement.style.bottom = "20px";
                this.containerElement.style.left = "20px";
                this.containerElement.style.zIndex = "10001";
            }
        }
    }

    cacheUIElements() {
        if (!this.containerElement) return;
        this.uiElements = {
            dot: this.containerElement.querySelector(".network-indicator-dot"),
            text: this.containerElement.querySelector(".network-indicator-text"),
            tooltipBadge: this.containerElement.querySelector(".network-indicator-badge"),
            latency: this.containerElement.querySelector("#net-val-latency"),
            jitter: this.containerElement.querySelector("#net-val-jitter"),
            loss: this.containerElement.querySelector("#net-val-loss"),
            bandwidth: this.containerElement.querySelector("#net-val-bandwidth"),
            disconnects: this.containerElement.querySelector("#net-val-disconnects"),
            desc: this.containerElement.querySelector("#net-val-desc")
        };
    }

    renderUI() {
        if (!document.body) {
            setTimeout(() => this.renderUI(), 100);
            return;
        }

        // Injected Styles
        const styles = `
            .network-indicator-container {
                position: relative;
                display: inline-flex;
                align-items: center;
                gap: 8px;
                background: rgba(255, 255, 255, 0.95);
                border: 1px solid #e2e8f0;
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.05);
                padding: 4px 12px;
                border-radius: 20px;
                font-family: 'Inter', system-ui, -apple-system, sans-serif;
                font-size: 11px;
                font-weight: 600;
                color: #1e293b;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                user-select: none;
                margin-right: 10px;
            }
            .network-indicator-container:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.08);
                border-color: #cbd5e1;
            }
            .network-indicator-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                display: inline-block;
                position: relative;
            }
            .dot-green { background-color: #10b981; }
            .dot-yellow { background-color: #eab308; }
            .dot-orange { background-color: #f97316; }
            .dot-red { background-color: #ef4444; }

            .network-indicator-dot::after {
                content: '';
                position: absolute;
                top: -2px;
                left: -2px;
                right: -2px;
                bottom: -2px;
                border-radius: 50%;
                border: 2px solid currentColor;
                opacity: 0.4;
                animation: network-pulse 2s infinite ease-out;
            }
            .dot-green::after { color: #10b981; }
            .dot-yellow::after { color: #eab308; }
            .dot-orange::after { color: #f97316; }
            .dot-red::after { color: #ef4444; }

            @keyframes network-pulse {
                0% { transform: scale(1); opacity: 0.6; }
                100% { transform: scale(2.2); opacity: 0; }
            }

            .network-tooltip {
                position: absolute;
                top: calc(100% + 8px);
                right: 0;
                background: #0f172a;
                color: #f8fafc;
                border-radius: 12px;
                padding: 14px;
                box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
                width: 240px;
                opacity: 0;
                visibility: hidden;
                transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                transform: translateY(5px);
                pointer-events: none;
                z-index: 10002;
                border: 1px solid #1e293b;
            }
            .network-indicator-container:hover .network-tooltip,
            .network-indicator-container:focus-within .network-tooltip,
            .network-indicator-container.tooltip-visible .network-tooltip {
                opacity: 1;
                visibility: visible;
                transform: translateY(0);
            }

            @media (max-width: 640px) {
                .network-indicator-container {
                    padding: 3px 8px;
                    font-size: 10px;
                    margin-right: 5px;
                }
                .network-tooltip {
                    width: 200px;
                    padding: 10px;
                    top: calc(100% + 6px);
                    right: 0;
                }
            }
            .network-tooltip-title {
                font-weight: 700;
                font-size: 13px;
                border-bottom: 1px solid #334155;
                padding-bottom: 6px;
                margin-bottom: 8px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .network-tooltip-row {
                display: flex;
                justify-content: space-between;
                margin-bottom: 5px;
                font-size: 11px;
                color: #94a3b8;
            }
            .network-tooltip-row span:last-child {
                color: #f1f5f9;
                font-weight: 600;
            }
            .network-tooltip-desc {
                font-size: 10px;
                color: #64748b;
                margin-top: 8px;
                line-height: 1.3;
                border-top: 1px solid #1e293b;
                padding-top: 6px;
            }
        `;

        if (!document.getElementById("network-stability-styles")) {
            const styleSheet = document.createElement("style");
            styleSheet.id = "network-stability-styles";
            styleSheet.innerText = styles;
            document.head.appendChild(styleSheet);
        }

        // Find existing container or create a new one
        let existingContainer = document.querySelector(".network-indicator-container");
        if (existingContainer) {
            this.containerElement = existingContainer;
        } else {
            this.containerElement = document.createElement("div");
            this.containerElement.className = "network-indicator-container";
            this.containerElement.setAttribute("role", "button");
            this.containerElement.setAttribute("tabindex", "0");
            this.containerElement.setAttribute("aria-haspopup", "true");
            this.containerElement.setAttribute("aria-expanded", "false");
            this.containerElement.innerHTML = `
                <span class="network-indicator-dot dot-green"></span>
                <span class="network-indicator-text">Online</span>
                <div class="network-tooltip">
                    <div class="network-tooltip-title">
                        <span>Network Health</span>
                        <span class="network-indicator-badge">🟢</span>
                    </div>
                    <div class="network-tooltip-row"><span>Latency:</span><span id="net-val-latency">--</span></div>
                    <div class="network-tooltip-row"><span>Jitter:</span><span id="net-val-jitter">--</span></div>
                    <div class="network-tooltip-row"><span>Packet Loss:</span><span id="net-val-loss">--</span></div>
                    <div class="network-tooltip-row"><span>Bandwidth:</span><span id="net-val-bandwidth">--</span></div>
                    <div class="network-tooltip-row"><span>Disconnects (2m):</span><span id="net-val-disconnects">--</span></div>
                    <div class="network-tooltip-desc" id="net-val-desc">Initializing network engine diagnostics...</div>
                </div>
            `;
        }

        // Attach safely into header
        this.attachToHeader();

        // Setup MutationObserver to watch for DOM updates and re-append container if header structure re-renders or switches (e.g., SPA route updates)
        if (!this.headerObserver) {
            this.headerObserver = new MutationObserver(() => {
                this.attachToHeader();
            });
            this.headerObserver.observe(document.body, { childList: true, subtree: true });
        }

        // Setup Keyboard and Focus Accessibility
        this.boundFocusHandler = () => {
            if (this.containerElement) {
                this.containerElement.setAttribute("aria-expanded", "true");
            }
        };
        this.boundBlurHandler = () => {
            if (this.containerElement) {
                this.containerElement.setAttribute("aria-expanded", "false");
                this.containerElement.classList.remove("tooltip-visible");
            }
        };
        this.boundKeydownHandler = (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (this.containerElement) {
                    const isVisible = this.containerElement.classList.toggle("tooltip-visible");
                    this.containerElement.setAttribute("aria-expanded", isVisible ? "true" : "false");
                }
            } else if (e.key === "Escape") {
                if (this.containerElement) {
                    this.containerElement.classList.remove("tooltip-visible");
                    this.containerElement.setAttribute("aria-expanded", "false");
                    this.containerElement.blur();
                }
            }
        };

        this.containerElement.addEventListener('focus', this.boundFocusHandler);
        this.containerElement.addEventListener('blur', this.boundBlurHandler);
        this.containerElement.addEventListener('keydown', this.boundKeydownHandler);

        this.cacheUIElements();
        this.updateUI();
    }

    updateUI() {
        if (!this.containerElement) return;
        if (!this.uiElements) {
            this.cacheUIElements();
        }
        const els = this.uiElements;
        if (!els || !els.dot) return;

        const details = this.getDetails();

        // UI status text overrides
        let dotClass = "dot-green";
        let statusLabel = "Online";
        let desc = "Connection available, low latency, stable packets.";

        if (this.status.includes("Poor Network")) {
            dotClass = "dot-yellow";
            statusLabel = "Poor Network";
            desc = "High latency or reduced bandwidth detected.";
        } else if (this.status.includes("Unstable Network")) {
            dotClass = "dot-orange";
            statusLabel = "Unstable Network";
            desc = "Frequent disconnects, packet loss, or fluctuating latency.";
        } else if (this.status.includes("Offline")) {
            dotClass = "dot-red";
            statusLabel = "Offline";
            desc = "No internet connection detected.";
        }

        // Apply dot class
        els.dot.className = `network-indicator-dot ${dotClass}`;
        els.text.textContent = statusLabel;
        els.tooltipBadge.textContent = this.status.split(" ")[0]; // emoji only

        // Update accessibility label
        const ariaText = `Network Status: ${statusLabel}. Latency: ${details.navigatorOnLine ? details.latency + " ms" : "N/A"}. Packet Loss: ${details.packetLoss}%. Description: ${desc}`;
        this.containerElement.setAttribute("aria-label", ariaText);

        // Update tooltip rows
        els.latency.textContent = details.navigatorOnLine ? `${details.latency} ms` : "N/A";
        els.jitter.textContent = details.navigatorOnLine ? `${details.jitter} ms` : "N/A";
        els.loss.textContent = `${details.packetLoss}%`;
        els.bandwidth.textContent = typeof details.bandwidth === "number" ? `${details.bandwidth} Mbps` : details.bandwidth;
        els.disconnects.textContent = details.disconnects;
        els.desc.textContent = desc;
    }

    /**
     * Clean up resources, event listeners, intervals, and elements to prevent memory leaks.
     */
    destroy() {
        // 1. Clear intervals and timeouts
        if (this.probeInterval) {
            clearInterval(this.probeInterval);
            this.probeInterval = null;
        }
        if (this.nextProbeTimeoutId) {
            clearTimeout(this.nextProbeTimeoutId);
            this.nextProbeTimeoutId = null;
        }
        if (this.activeTimeoutId) {
            clearTimeout(this.activeTimeoutId);
            this.activeTimeoutId = null;
        }
        if (this.activeController) {
            try {
                this.activeController.abort();
            } catch (e) {}
            this.activeController = null;
        }

        // Disconnect header MutationObserver
        if (this.headerObserver) {
            this.headerObserver.disconnect();
            this.headerObserver = null;
        }

        // 2. Remove window and document event listeners
        window.removeEventListener('online', this.boundOnlineHandler);
        window.removeEventListener('offline', this.boundOfflineHandler);
        document.removeEventListener('DOMContentLoaded', this.boundDOMContentLoadedHandler);
        document.removeEventListener('visibilitychange', this.boundVisibilityChangeHandler);

        // Mark handlers as null to indicate destroyed state
        this.boundOnlineHandler = null;
        this.boundOfflineHandler = null;
        this.boundDOMContentLoadedHandler = null;
        this.boundVisibilityChangeHandler = null;

        if (this.containerElement) {
            this.containerElement.removeEventListener('focus', this.boundFocusHandler);
            this.containerElement.removeEventListener('blur', this.boundBlurHandler);
            this.containerElement.removeEventListener('keydown', this.boundKeydownHandler);
        }
        this.boundFocusHandler = null;
        this.boundBlurHandler = null;
        this.boundKeydownHandler = null;

        // 3. Remove injected CSS stylesheet and HTML element from DOM
        const styleSheet = document.getElementById("network-stability-styles");
        if (styleSheet) {
            styleSheet.remove();
        }
        if (this.containerElement && this.containerElement.parentNode) {
            this.containerElement.parentNode.removeChild(this.containerElement);
            this.containerElement = null;
        }

        // 4. Clear internal listeners and state arrays
        this.listeners.clear();
        this.probes = [];
        this.disconnects = [];
        this.uiElements = null;

        // Reset singleton references and initialization flag
        if (NetworkStabilityEngine.instance === this) {
            NetworkStabilityEngine.instance = null;
        }
        if (window.NetworkIndicator === this) {
            window.NetworkIndicator = null;
        }
        if (window.NetworkStabilityEngine === this) {
            window.NetworkStabilityEngine = null;
        }
        this.initialized = false;
    }
}

// Clean up any existing global instance before creating a new one
if (window.NetworkStabilityEngine) {
    try {
        window.NetworkStabilityEngine.destroy();
    } catch (e) {
        console.error('[NetworkStabilityEngine] Cleanup error during re-instantiation:', e);
    }
}

// Instantiate globally
window.NetworkStabilityEngine = new NetworkStabilityEngine();
window.NetworkIndicator = window.NetworkStabilityEngine;
