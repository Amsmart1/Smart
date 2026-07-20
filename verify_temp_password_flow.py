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

            # Handle alert dialogs automatically so the test doesn't hang
            page.on("dialog", lambda dialog: (print(f"[Dialog] {dialog.type} - {dialog.message}"), dialog.accept()))

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

                        // High-fidelity stateful mock database
                        let userState = {
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

                        // Mock getUser
                        originalSupabaseDB.getUser = async (email) => {
                            if (email === 'student@smartlms.edu') {
                                return userState;
                            }
                            return null;
                        };

                        // Mock authenticateUser with enterprise-grade dynamic check
                        originalSupabaseDB.authenticateUser = async (email, passwordHash, sessionId) => {
                            console.log('Mock authenticateUser called with email:', email, 'hash:', passwordHash);

                            // Check if the input password matches the correct temporary password hash
                            const expectedTempHash = await window.hashPassword('TEMP-PWD-GhanaianPass123', email);
                            if (passwordHash === expectedTempHash) {
                                console.log('Mock authenticateUser: Authentication SUCCESS (temp password matched)');
                                return {
                                    success: true,
                                    user: userState
                                };
                            } else {
                                console.log('Mock authenticateUser: Authentication FAILED (wrong password)');
                                return {
                                    success: false,
                                    message: 'Invalid password. This account has an approved password reset. Please use the temporary password provided by your administrator to login.',
                                    temp_password: 'TEMP-PWD-GhanaianPass123'
                                };
                            }
                        };

                        // Mock finalizePasswordReset
                        originalSupabaseDB.finalizePasswordReset = async (email, passwordHash, sessionId) => {
                            console.log('Mock finalizePasswordReset called for:', email, 'new hash:', passwordHash);
                            // Atomically update user reset request state (clear it)
                            userState.reset_request = null;
                            if (userState.reset_data) {
                                userState.reset_data.temp_password_plain = null;
                            }
                            return {
                                success: true,
                                message: 'Password successfully reset. Please login with your new credentials.'
                            };
                        };

                        // Mock saveUser
                        originalSupabaseDB.saveUser = async (user) => {
                            userState = { ...userState, ...user };
                            return userState;
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

            # --- STEP 1: Attempt login with incorrect password ---
            print("--- STEP 1: Attempt login with incorrect password ---")
            page.fill("#loginEmail", "student@smartlms.edu")
            page.fill("#loginPassword", "WrongPasswordGhana")

            # Click login button
            print("Clicking login button...")
            page.click("#loginForm button[type='submit']")
            page.wait_for_timeout(1500)

            # Verify that the temporary password block is rendered
            print("Checking error container for temporary password...")
            error_html = page.inner_html("#loginPasswordError")
            print(f"Error HTML content: {error_html}")

            assert "TEMP-PWD-GhanaianPass123" in error_html, "Temporary password not found in error block"
            assert "approved password reset" in error_html, "Approved password reset message not found"

            # Take screenshot showing wrong password attempt
            screenshot_wrong_path = "/home/jules/verification/screenshots/temp_password_failed_attempt_verification.png"
            print(f"Saving failed attempt screenshot to {screenshot_wrong_path}...")
            os.makedirs(os.path.dirname(screenshot_wrong_path), exist_ok=True)
            page.screenshot(path=screenshot_wrong_path)

            # --- STEP 2: Attempt login with correct temporary password ---
            print("--- STEP 2: Attempt login with correct temporary password ---")
            page.fill("#loginPassword", "TEMP-PWD-GhanaianPass123")

            # Click login button again
            print("Clicking login button with correct temporary password...")
            page.click("#loginForm button[type='submit']")
            page.wait_for_timeout(2000)

            # Verify that the view has transitioned to the New Password section
            print("Checking that the 'New Password' section is now visible...")
            is_new_password_visible = page.is_visible("#newPasswordForm")
            print(f"New Password form visible: {is_new_password_visible}")
            assert is_new_password_visible, "Did not transition to New Password form after logging in with temporary password"

            # --- STEP 3: Attempt to reuse the temporary password ---
            print("--- STEP 3: Attempt to reuse the temporary password ---")
            page.fill("#newPass", "TEMP-PWD-GhanaianPass123")
            page.fill("#confirmNewPass", "TEMP-PWD-GhanaianPass123")

            # Click submit on the new password form
            print("Submitting the same temporary password...")
            page.click("#newPasswordForm button[type='submit']")
            page.wait_for_timeout(1500)

            # Verify that the temporary password reuse prevention error is displayed
            new_pass_error_html = page.inner_html("#newPasswordError")
            print(f"New Password error HTML content: {new_pass_error_html}")
            assert "New password cannot be the same as your temporary password." in new_pass_error_html, "Should block temporary password reuse"

            # --- STEP 4: Enter a valid, fresh new password and finalize ---
            print("--- STEP 4: Enter a valid, fresh new password and finalize ---")
            page.fill("#newPass", "NewPassGhanaian123!")
            page.fill("#confirmNewPass", "NewPassGhanaian123!")

            # Click submit to finalize
            print("Submitting valid new password to finalize reset...")
            page.click("#newPasswordForm button[type='submit']")
            page.wait_for_timeout(2000)

            # Verify that we transitioned back to the login view after finalization
            print("Checking that we have returned to the login view...")
            is_login_visible = page.is_visible("#loginForm")
            print(f"Login form visible again: {is_login_visible}")
            assert is_login_visible, "Did not return to login form after successful password reset finalization"

            # Take final screenshot showing successful transition
            screenshot_success_path = "/home/jules/verification/screenshots/temp_password_success_flow_verification.png"
            print(f"Saving success screenshot to {screenshot_success_path}...")
            page.screenshot(path=screenshot_success_path)

            print("High-fidelity visual verification test successfully completed and saved!")

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
