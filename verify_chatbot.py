import os
import subprocess
import time
from playwright.sync_api import sync_playwright

def run_verification():
    # 1. Start a simple python HTTP server in the background
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
            print("Launching headless Chromium browser...")
            browser = p.chromium.launch(headless=True)

            # Setup viewport of 320px width (down to 320px screen check)
            context = browser.new_context(
                viewport={"width": 320, "height": 600},
                record_video_dir="/home/jules/verification/videos"
            )

            page = context.new_page()
            url = "http://localhost:8000/test_ai_ui.html"
            print(f"Navigating to {url}...")
            page.goto(url)
            page.wait_for_timeout(1000)

            # 2. Check the layout elements are present
            print("Verifying chatbot elements are visible...")
            assert page.is_visible("#testChatContainer"), "testChatContainer not found"
            assert page.is_visible(".whatsapp-input-wrapper"), "whatsapp-input-wrapper not found"
            assert page.is_visible(".ai-mic-btn"), "ai-mic-btn not found"
            assert page.is_visible(".ai-input-field"), "ai-input-field not found"
            assert page.is_visible(".ai-send-btn"), "ai-send-btn not found"
            assert page.is_visible(".ai-tts-btn"), "ai-tts-btn not found"
            assert page.is_visible(".ai-handsfree-btn"), "ai-handsfree-btn not found"

            print("Verified: All target elements rendered successfully!")

            # 3. Simulate text interaction
            input_el = page.locator(".ai-input-field").first
            input_el.fill("Testing WhatsApp style send button and microphone inside input wrapper.")
            page.wait_for_timeout(500)

            # Take screenshot before sending
            print("Taking screenshot of input state at 320px...")
            page.screenshot(path="/home/jules/verification/screenshots/chatbot_input_320px.png")

            # Click send button
            print("Clicking the symbol send button...")
            send_btn = page.locator(".ai-send-btn").first
            send_btn.click()
            page.wait_for_timeout(1500)

            # Take final screenshot showing message sent & response
            print("Taking final screenshot showing dialogue and responsive layout at 320px...")
            page.screenshot(path="/home/jules/verification/screenshots/chatbot_final_320px.png")
            page.wait_for_timeout(1000)

            # Close context and browser to save the video
            context.close()
            browser.close()
            print("Playwright browser closed successfully.")

    finally:
        print("Stopping HTTP server...")
        server_process.terminate()
        server_process.wait()
        print("Server stopped.")

if __name__ == "__main__":
    run_verification()
