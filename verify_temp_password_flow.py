import os
import subprocess
import time
from playwright.sync_api import sync_playwright

def run_verification():
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

            context = browser.new_context(
                viewport={"width": 1280, "height": 800},
                record_video_dir="/home/jules/verification/videos"
            )

            page = context.new_page()

            # Setup browser console listeners
            page.on("console", lambda msg: print(f"[Browser Console] {msg.type}: {msg.text}"))
            page.on("pageerror", lambda err: print(f"[Browser PageError] {err}"))

            # Inject mock SupabaseDB and setup auth state BEFORE navigation
            print("Injecting custom SupabaseDB mocks...")
            page.add_init_script("""
                // Define mock window.supabaseClient to prevent initialization failures
                window.supabase = {
                    createClient: () => ({
                        from: () => ({
                            select: () => ({
                                eq: () => Promise.resolve({ data: [], error: null })
                            })
                        }),
                        functions: {
                            invoke: () => Promise.resolve({ data: { success: true }, error: null })
                        }
                    })
                };

                let originalSupabaseDB;
                Object.defineProperty(window, 'SupabaseDB', {
                    get() {
                        return originalSupabaseDB;
                    },
                    set(val) {
                        originalSupabaseDB = val;
                        // Mock getUser for student with an approved reset request
                        originalSupabaseDB.getUser = async (email) => {
                            if (email === 'student@smartlms.edu') {
                                return {
                                    email: 'student@smartlms.edu',
                                    full_name: 'Kwame Mensah',
                                    role: 'student',
                                    active: true,
                                    flagged: false,
                                    has_secret: true,
                                    reset_request: {
                                        status: 'approved',
                                        expires_at: new Date(Date.now() + 86400000).toISOString()
                                    },
                                    reset_data: {
                                        temp_password_plain: 'TEMP-PWD-GhanaianPass123'
                                    }
                                };
                            }
                            return null;
                        };

                        // Mock authenticateUser to fail and return the temp password
                        originalSupabaseDB.authenticateUser = async (email, passwordHash, sessionId) => {
                            return {
                                success: false,
                                message: 'Invalid password. This account has an approved password reset. Please use the temporary password provided by your administrator to login.',
                                temp_password: 'TEMP-PWD-GhanaianPass123'
                            };
                        };

                        // Mock checkMaintenance to not be active
                        originalSupabaseDB.getMaintenance = async () => {
                            return { enabled: false, schedules: [] };
                        };
                    },
                    configurable: true
                });
            """)

            url = "http://localhost:8000/index.html"
            print(f"Navigating to {url}...")
            page.goto(url)
            page.wait_for_timeout(1500)

            # Show the login modal first
            print("Triggering showLogin() to reveal login form...")
            page.evaluate("showLogin()")
            page.wait_for_timeout(500)

            # Ensure we are in the login view
            print("Interacting with login form...")
            page.fill("#loginEmail", "student@smartlms.edu")
            page.fill("#loginPassword", "WrongPasswordGhana")

            # Click login button
            print("Clicking login button...")
            page.click("#loginForm button[type='submit']")
            page.wait_for_timeout(2500)

            # Verify that the temporary password block is rendered
            print("Checking error container for temporary password...")
            error_html = page.inner_html("#loginPasswordError")
            print(f"Error HTML content: {error_html}")

            assert "TEMP-PWD-GhanaianPass123" in error_html, "Temporary password not found in error block"
            assert "approved password reset" in error_html, "Approved password reset message not found"

            # Take screenshot showing visual verification
            screenshot_path = "/home/jules/verification/screenshots/temp_password_failed_attempt_verification.png"
            print(f"Saving visual verification screenshot to {screenshot_path}...")
            os.makedirs(os.path.dirname(screenshot_path), exist_ok=True)
            page.screenshot(path=screenshot_path)

            print("Visual verification test successfully completed and saved!")

            context.close()
            browser.close()
            print("Browser closed.")

    finally:
        print("Stopping HTTP server...")
        server_process.terminate()
        server_process.wait()
        print("Server stopped.")

if __name__ == "__main__":
    run_verification()
