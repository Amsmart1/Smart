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
        this.status = '🟢 Online'; // Default
        this.probes = []; // Rolling window of recent latency metrics
        this.maxProbes = 6; // last 60 seconds (with 10s intervals)
        this.disconnects = []; // Timestamps of offline transitions
        this.disconnectWindowMs = 120000; // 2 minutes window to track frequent disconnects
        this.probeIntervalMs = 10000; // Probe every 10 seconds
        this.probeTimeoutMs = 5000; // 5 seconds timeout
        this.listeners = new Set();
        this.containerElement = null;

        this.init();
    }

    init() {
        // Track disconnects via window events
        window.addEventListener('online', () => this.handleConnectionChange(true));
        window.addEventListener('offline', () => this.handleConnectionChange(false));

        // Start periodic active probing
        this.runProbe();
        this.probeInterval = setInterval(() => this.runProbe(), this.probeIntervalMs);

        // Inject UI
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.renderUI());
        } else {
            this.renderUI();
        }
    }

    /**
     * Records browser online/offline transitions.
     */
    handleConnectionChange(isOnline) {
        if (!isOnline) {
            this.disconnects.push(Date.now());
            // Filter old disconnects out of the tracking window
            this.cleanDisconnectHistory();
        }
        this.evaluateStatus();
    }

    cleanDisconnectHistory() {
        const now = Date.now();
        this.disconnects = this.disconnects.filter(time => now - time <= this.disconnectWindowMs);
    }

    /**
     * Active favicon probe check to measure precise RTT/latency & packet loss.
     */
    async runProbe() {
        // If navigator.onLine is false, don't even try to fetch
        if (navigator.onLine === false) {
            this.recordProbeResult(null, false);
            return;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.probeTimeoutMs);
        const startTime = performance.now();
        const cacheBuster = Date.now();

        try {
            // Using HEAD request is lighter than GET, fallback to GET if HEAD is not allowed
            const response = await fetch(`${window.location.origin}/favicon.ico?_cb=${cacheBuster}`, {
                method: 'HEAD',
                signal: controller.signal,
                cache: 'no-store',
                mode: 'same-origin'
            });

            clearTimeout(timeoutId);
            const endTime = performance.now();
            const latency = endTime - startTime;

            this.recordProbeResult(latency, response.ok || response.status < 400);
        } catch (error) {
            clearTimeout(timeoutId);
            // Fallback: If same-origin HEAD fetch fails but we're online, try a simple GET fetch
            let altTimeoutId;
            try {
                const altController = new AbortController();
                altTimeoutId = setTimeout(() => altController.abort(), this.probeTimeoutMs);
                const altStartTime = performance.now();

                const response = await fetch(`${window.location.origin}/favicon.ico?_cb=${cacheBuster}`, {
                    method: 'GET',
                    signal: altController.signal,
                    cache: 'no-store',
                    mode: 'same-origin'
                });

                clearTimeout(altTimeoutId);
                const altEndTime = performance.now();
                const latency = altEndTime - altStartTime;

                this.recordProbeResult(latency, response.ok);
            } catch (err) {
                if (altTimeoutId) clearTimeout(altTimeoutId);
                // Genuinely failed to reach server
                this.recordProbeResult(null, false);
            }
        }
    }

    recordProbeResult(latency, success) {
        this.probes.push({
            timestamp: Date.now(),
            latency: success ? latency : null,
            success
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

        // 1. Detect Offline
        if (navigator.onLine === false) {
            this.updateStatus('🔴 Offline');
            return;
        }

        // If we have probes, analyze them
        const validProbes = this.probes;
        const totalProbes = validProbes.length;

        if (totalProbes === 0) {
            this.updateStatus('🟢 Online');
            return;
        }

        const successfulProbes = validProbes.filter(p => p.success);
        const successCount = successfulProbes.length;
        const failureCount = totalProbes - successCount;
        const packetLossRate = totalProbes > 0 ? (failureCount / totalProbes) : 0;

        // If the latest probes consecutive failed (e.g., last 2 attempts failed) or all failed, mark offline
        if (totalProbes >= 2 && validProbes.slice(-2).every(p => !p.success)) {
            this.updateStatus('🔴 Offline');
            return;
        }

        // 2. Detect Unstable Network
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
            this.updateStatus('🟠 Unstable Network');
            return;
        }

        // 3. Detect Poor Network
        // High latency (avgLatency > 200ms or navRtt > 300ms) OR reduced bandwidth (downlink < 1.0 Mbps)
        const isHighLatency = avgLatency > 200 || (navRtt && navRtt > 300);
        const isReducedBandwidth = (navDownlink && navDownlink < 1.0);

        if (isHighLatency || isReducedBandwidth) {
            this.updateStatus('🟡 Poor Network');
            return;
        }

        // 4. Online (connection available, low latency, stable packets)
        this.updateStatus('🟢 Online');
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
        const successfulProbes = this.probes.filter(p => p.success);
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

        const totalProbes = this.probes.length;
        const packetLossRate = totalProbes > 0 ? ((totalProbes - successfulProbes.length) / totalProbes) * 100 : 0;

        let navRtt = null;
        let navDownlink = null;
        if (navigator.connection) {
            navRtt = navigator.connection.rtt;
            navDownlink = navigator.connection.downlink;
        }

        return {
            status: this.status,
            latency: rttValues.length > 0 ? Math.round(avgLatency) : (navRtt || 0),
            jitter: Math.round(jitter),
            packetLoss: Math.round(packetLossRate),
            bandwidth: navDownlink || 'N/A',
            disconnects: this.disconnects.length,
            navigatorOnLine: navigator.onLine
        };
    }

    renderUI() {
        if (this.containerElement) return;

        // Injected Styles
        const styles = `
            .network-indicator-container {
                position: fixed;
                bottom: 20px;
                left: 20px;
                z-index: 10001;
                display: flex;
                align-items: center;
                gap: 8px;
                background: rgba(255, 255, 255, 0.95);
                border: 1px solid #e2e8f0;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
                padding: 6px 14px;
                border-radius: 30px;
                font-family: 'Inter', system-ui, -apple-system, sans-serif;
                font-size: 12px;
                font-weight: 600;
                color: #1e293b;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                user-select: none;
            }
            .network-indicator-container:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
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
                bottom: calc(100% + 10px);
                left: 0;
                background: #0f172a;
                color: #f8fafc;
                border-radius: 12px;
                padding: 14px;
                box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
                width: 240px;
                opacity: 0;
                visibility: hidden;
                transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                transform: translateY(10px);
                pointer-events: none;
                z-index: 10002;
                border: 1px solid #1e293b;
            }
            .network-indicator-container:hover .network-tooltip {
                opacity: 1;
                visibility: visible;
                transform: translateY(0);
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

        const styleSheet = document.createElement("style");
        styleSheet.innerText = styles;
        document.head.appendChild(styleSheet);

        // Container element
        this.containerElement = document.createElement("div");
        this.containerElement.className = "network-indicator-container";
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

        document.body.appendChild(this.containerElement);
        this.updateUI();
    }

    updateUI() {
        if (!this.containerElement) return;

        const details = this.getDetails();
        const dot = this.containerElement.querySelector(".network-indicator-dot");
        const text = this.containerElement.querySelector(".network-indicator-text");
        const tooltipBadge = this.containerElement.querySelector(".network-indicator-badge");

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
        dot.className = `network-indicator-dot ${dotClass}`;
        text.textContent = statusLabel;
        tooltipBadge.textContent = this.status.split(" ")[0]; // emoji only

        // Update tooltip rows
        this.containerElement.querySelector("#net-val-latency").textContent = details.navigatorOnLine ? `${details.latency} ms` : "N/A";
        this.containerElement.querySelector("#net-val-jitter").textContent = details.navigatorOnLine ? `${details.jitter} ms` : "N/A";
        this.containerElement.querySelector("#net-val-loss").textContent = `${details.packetLoss}%`;
        this.containerElement.querySelector("#net-val-bandwidth").textContent = typeof details.bandwidth === "number" ? `${details.bandwidth} Mbps` : details.bandwidth;
        this.containerElement.querySelector("#net-val-disconnects").textContent = details.disconnects;
        this.containerElement.querySelector("#net-val-desc").textContent = desc;
    }
}

// Instantiate globally
window.NetworkStabilityEngine = new NetworkStabilityEngine();
window.NetworkIndicator = window.NetworkStabilityEngine;
