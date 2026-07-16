import os
import subprocess
import time
from playwright.sync_api import sync_playwright

def run_network_stability_test():
    print("Starting background HTTP server on port 8000...")
    # Kill any existing process on port 8000 first
    try:
        subprocess.run("kill $(lsof -t -i :8000) 2>/dev/null || true", shell=True)
    except Exception as e:
        print(f"Warning cleaning port: {e}")

    server_process = subprocess.Popen(
        ["python3", "-m", "http.server", "8000"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    time.sleep(1.5)  # Let server boot up

    try:
        with sync_playwright() as p:
            print("Launching headless Chromium browser for network stability tests...")
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()

            url = "http://localhost:8000/test_ai_ui.html"
            print(f"Navigating to {url}...")
            page.goto(url)
            page.wait_for_timeout(1000)

            # 1. Test presence of NetworkStabilityEngine
            print("Verifying NetworkStabilityEngine is instantiated globally...")
            engine_exists = page.evaluate("() => typeof window.NetworkStabilityEngine !== 'undefined'")
            assert engine_exists, "NetworkStabilityEngine is not defined on window!"
            print("✔ NetworkStabilityEngine is defined on window.")

            # Force a stable state by mocking low latency probes and bypass navigator.connection
            page.evaluate("""() => {
                const engine = window.NetworkStabilityEngine;
                // Mock navigator.connection
                if (navigator.connection) {
                    Object.defineProperty(navigator, 'connection', {
                        value: { rtt: 50, downlink: 10 },
                        writable: true,
                        configurable: true
                    });
                }
                // Mock navigator.onLine to true initially
                Object.defineProperty(navigator, 'onLine', {
                    value: true,
                    writable: true,
                    configurable: true
                });
                engine.probes = [];
                engine.recordProbeResult(15, true, true);
            }""")

            # 2. Test default online state
            details = page.evaluate("() => window.NetworkStabilityEngine.getDetails()")
            print(f"Mocked Stable Details: {details}")
            assert details["connectionStatus"] == "Online", f"Expected Online, got {details['connectionStatus']}"
            assert details["stabilityStatus"] == "Stable", f"Expected Stable, got {details['stabilityStatus']}"
            print("✔ Default online state verified.")

            # 3. Test separation of connection and stability statuses when offline
            print("Mocking navigator.onLine to false and simulating offline state...")
            page.evaluate("""() => {
                Object.defineProperty(navigator, 'onLine', {
                    value: false,
                    writable: true,
                    configurable: true
                });
                window.NetworkStabilityEngine.handleConnectionChange(false);
            }""")
            details_offline = page.evaluate("() => window.NetworkStabilityEngine.getDetails()")
            print(f"Offline Details: {details_offline}")
            assert details_offline["connectionStatus"] == "Offline", f"Expected Offline, got {details_offline['connectionStatus']}"
            assert details_offline["stabilityStatus"] == "Unknown", f"Expected Unknown, got {details_offline['stabilityStatus']}"
            assert details_offline["status"] == "🔴 Offline", f"Expected 🔴 Offline, got {details_offline['status']}"
            print("✔ Separation of offline and unknown stability status verified.")

            # 4. Test transition to online clears probes AND immediately updates the status banner
            print("Mocking navigator.onLine to true and simulating transition back to online...")
            page.evaluate("""() => {
                Object.defineProperty(navigator, 'onLine', {
                    value: true,
                    writable: true,
                    configurable: true
                });
                window.NetworkStabilityEngine.handleConnectionChange(true);
            }""")

            # Immediately retrieve details before waiting for any intervals
            immediate_details = page.evaluate("() => window.NetworkStabilityEngine.getDetails()")
            print(f"Immediate details after going online: {immediate_details}")

            # The status must IMMEDIATELY switch to stable and online
            assert immediate_details["connectionStatus"] == "Online", "Expected connectionStatus to switch to Online immediately"
            assert immediate_details["stabilityStatus"] == "Stable", "Expected stabilityStatus to switch to Stable immediately"
            assert immediate_details["status"] == "🟢 Online", "Expected legacy status to switch to Online immediately"
            print("✔ verified: Status banner switches to stability status immediately on transitioning back online!")

            # 5. Test packet loss calculation excludes offline probes (fix flaw 1)
            print("Testing packet loss exclusion for offline probes...")
            page.evaluate("""() => {
                const engine = window.NetworkStabilityEngine;
                engine.probes = [];
                // Record an online probe that succeeded (0% packet loss)
                engine.recordProbeResult(40, true, true);
                // Record an offline probe that failed (should be excluded from calculation)
                engine.recordProbeResult(null, false, false);
            }""")
            pkt_loss = page.evaluate("() => window.NetworkStabilityEngine.getDetails().packetLoss")
            print(f"Calculated packet loss with excluded offline probe: {pkt_loss}%")
            assert pkt_loss == 0, f"Expected 0% packet loss (excluding offline probe), got {pkt_loss}%"
            print("✔ Misleading packet loss calculation fix verified.")

            # 6. Test evaluating unstable network quality
            print("Simulating unstable network state (e.g. 50% packet loss during active online)...")
            page.evaluate("""() => {
                const engine = window.NetworkStabilityEngine;
                engine.probes = [];
                engine.recordProbeResult(40, true, true);
                engine.recordProbeResult(null, false, true); // Active failure
            }""")
            details_unstable = page.evaluate("() => window.NetworkStabilityEngine.getDetails()")
            print(f"Unstable Details: {details_unstable}")
            assert details_unstable["stabilityStatus"] == "Unstable Network", f"Expected Unstable Network, got {details_unstable['stabilityStatus']}"
            assert details_unstable["status"] == "🟠 Unstable Network", f"Expected 🟠 Unstable Network, got {details_unstable['status']}"
            print("✔ Unstable network stability evaluation verified.")

            # 7. Test memory and DOM cleanup (fix flaw 2)
            print("Testing engine destroy() and resource cleanup...")
            # Check element presence first
            el_present_before = page.evaluate("() => document.querySelector('.network-indicator-container') !== null")
            css_present_before = page.evaluate("() => document.getElementById('network-stability-styles') !== null")
            assert el_present_before, "Indicator container not found before destroy"
            assert css_present_before, "Styles stylesheet not found before destroy"

            # Execute destroy
            page.evaluate("() => window.NetworkStabilityEngine.destroy()")

            # Check post-destroy state
            el_present_after = page.evaluate("() => document.querySelector('.network-indicator-container') !== null")
            css_present_after = page.evaluate("() => document.getElementById('network-stability-styles') !== null")
            probe_interval_null = page.evaluate("() => window.NetworkStabilityEngine.probeInterval === null")
            active_timeout_null = page.evaluate("() => window.NetworkStabilityEngine.activeTimeoutId === null")
            active_controller_null = page.evaluate("() => window.NetworkStabilityEngine.activeController === null")
            handlers_null = page.evaluate("() => window.NetworkStabilityEngine.boundOnlineHandler === null")

            print(f"Container element present after destroy: {el_present_after}")
            print(f"Styles element present after destroy: {css_present_after}")
            print(f"Probe interval is null after destroy: {probe_interval_null}")
            print(f"Active timeout is null after destroy: {active_timeout_null}")
            print(f"Active controller is null after destroy: {active_controller_null}")
            print(f"Handlers are null after destroy: {handlers_null}")

            assert not el_present_after, "Expected container to be removed from DOM"
            assert not css_present_after, "Expected CSS styles to be removed from DOM"
            assert probe_interval_null, "Expected probe interval to be cleared and set to null"
            assert active_timeout_null, "Expected active probe timeout to be cleared and set to null"
            assert active_controller_null, "Expected active fetch controller to be aborted and set to null"
            assert handlers_null, "Expected event handler reference bindings to be set to null"

            print("✔ Incomplete/broken memory cleanup fix verified.")
            print("\n🎉 ALL TESTS PASSED SUCCESSFULLY!")

            # Close context and browser
            context.close()
            browser.close()

    finally:
        print("Stopping HTTP server...")
        server_process.terminate()
        server_process.wait()
        print("Server stopped.")

if __name__ == "__main__":
    run_network_stability_test()
