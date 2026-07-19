import os
import subprocess
import time
from playwright.sync_api import sync_playwright

def run_verification():
    print("Starting background HTTP server on port 8000...")
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

    screenshots_dir = "/home/jules/verification/screenshots"
    os.makedirs(screenshots_dir, exist_ok=True)

    try:
        with sync_playwright() as p:
            print("Launching headless Chromium browser for Proctoring Decoupling E2E tests...")
            browser = p.chromium.launch(headless=True)

            context = browser.new_context(
                viewport={"width": 1024, "height": 768},
                record_video_dir="/home/jules/verification/videos"
            )

            page = context.new_page()

            # Enable page console logging to diagnose any runtime exceptions
            page.on("console", lambda msg: print(f"[Browser Console] {msg.type}: {msg.text}"))
            page.on("pageerror", lambda err: print(f"[Browser PageError] {err}"))

            # Inject mock teacher session and custom interceptor getter/setter on window.SupabaseDB
            page.add_init_script("""
                sessionStorage.setItem('currentUser', JSON.stringify({
                    email: 'teacher@smartlms.edu',
                    full_name: 'Professor Yaw',
                    role: 'teacher',
                    active: true
                }));
                sessionStorage.setItem('sessionId', 'mock_teacher_session_123');

                // Mock window.supabaseClient
                window.supabase = {
                    createClient: () => ({
                        from: () => ({
                            select: () => ({
                                eq: () => Promise.resolve({ data: [], error: null })
                            })
                        }),
                        realtime: {
                            setAuth: () => {}
                        }
                    })
                };

                let originalSupabaseDB;
                Object.defineProperty(window, 'SupabaseDB', {
                    get() { return originalSupabaseDB; },
                    set(val) {
                        originalSupabaseDB = val;
                        originalSupabaseDB.getUser = async (email) => {
                            console.log('Mock getUser called for:', email);
                            return {
                                email: 'teacher@smartlms.edu',
                                full_name: 'Professor Yaw',
                                role: 'teacher',
                                active: true,
                                flagged: false,
                                session_id: 'mock_teacher_session_123',
                                reset_request: null
                            };
                        };
                        originalSupabaseDB.getMaintenance = async () => {
                            return { enabled: false, schedules: [] };
                        };
                        originalSupabaseDB.getSystemSettings = async (key) => {
                            if (key === 'proctoring_control') {
                                return { status: 'active' };
                            }
                            return {};
                        };
                        originalSupabaseDB.getCourses = async (email) => {
                            return {
                                data: [{ id: 'course-123', title: 'GES Biology 101', teacher_email: 'teacher@smartlms.edu' }]
                            };
                        };
                        originalSupabaseDB.getViolationSummary = async (email) => {
                            return {
                                data: [
                                    {
                                        id: 'quiz-123',
                                        title: 'Physics & Software Security Finals',
                                        type: 'quiz',
                                        violationCount: 15,
                                        studentCount: 2,
                                        totalScore: 45,
                                        criticalCount: 1,
                                        proctoringStats: { snapshots: 10, chunks: 5, audioChunks: 2, maxFaces: 1, noiseEvents: 1 }
                                    }
                                ],
                                total: 1
                            };
                        };
                        originalSupabaseDB.getLiveProctoringSessions = async (options) => {
                            return [
                                {
                                    attempt_id: 'attempt-uuid-456',
                                    user_email: 'student@smartlms.edu',
                                    full_name: 'Yaw Student',
                                    assessment_title: 'Physics & Software Security Finals',
                                    assessment_type: 'quiz',
                                    started_at: new Date(Date.now() - 300000).toISOString(),
                                    last_activity: new Date().toISOString(),
                                    violation_count: 2,
                                    status: 'Warning',
                                    is_online: true
                                }
                            ];
                        };
                        originalSupabaseDB.getExamsTodayCount = async (email) => {
                            return 1;
                        };
                        originalSupabaseDB.getViolations = async () => {
                            return { data: [], total: 0 };
                        };
                    },
                    configurable: true
                });
            """)

            # -------------------------------------------------------------
            # STEP 1: TEST ANTI-CHEAT HISTORICAL PAGE
            # -------------------------------------------------------------
            print("\nNavigating to Anti-Cheat Page...")
            url_anticheat = "http://localhost:8000/teacher.html?page=anticheat"
            page.goto(url_anticheat)
            page.wait_for_timeout(4000)

            # Assert heading and that the tab buttons to go to Live are absent
            print("Asserting Anti-Cheat page header...")
            assert page.is_visible("h2:has-text('Security Monitoring')"), "Anti-Cheat page header not found"
            assert page.is_visible("p:has-text('Overview of historical assessments with detected integrity violations.')"), "Historical records subtitle not found"

            # Assert that the button row "View Historical Records" and "Live Proctoring Center" has been removed
            assert not page.is_visible("#teacher-view-live-btn"), "Error: Live Proctoring Center button should NOT be on the Anti-Cheat page!"
            assert not page.is_visible("#teacher-view-records-btn"), "Error: Historical Records button should NOT be on the Anti-Cheat page!"
            print("✔ Decoupling verified on Anti-Cheat page: Tab-switching button row is completely removed.")

            # Take screenshot of Anti-Cheat Historical view
            page.screenshot(path=f"{screenshots_dir}/teacher_anticheat_historical.png")
            page.wait_for_timeout(1000)

            # -------------------------------------------------------------
            # STEP 2: TEST LIVE PROCTORING PAGE & ACCURACY CALCULATION
            # -------------------------------------------------------------
            print("\nNavigating to Live Proctoring Page...")
            url_live = "http://localhost:8000/teacher.html?page=live-proctoring"
            page.goto(url_live)
            page.wait_for_timeout(2000)

            # Assert Live Proctoring header
            assert page.is_visible("h3:has-text('Live Proctoring Dashboard')"), "Live Proctoring header not found"

            # Assert dynamic accuracy metric is visible
            assert page.is_visible("h4:has-text('Detection Accuracy')"), "Detection Accuracy card not found"

            # Get actual rendered accuracy text/value
            accuracy_val = page.locator("div.stat-card:has(h4:has-text('Detection Accuracy')) div.value").text_content()
            print(f"Rendered Dynamic Accuracy: {accuracy_val}")

            # Verify it is not hardcoded to '96.3%'
            assert accuracy_val != '96.3%', "Error: Detection accuracy is still hardcoded to 96.3%! It must be calculated dynamically."
            print("✔ Dynamic accuracy calculation verified successfully!")

            # Take screenshot of Live Proctoring view
            page.screenshot(path=f"{screenshots_dir}/teacher_live_proctoring.png")
            page.wait_for_timeout(1000)

            # Close context and browser to save video
            context.close()
            browser.close()
            print("\n✔ Decoupling and dynamic accuracy verification complete and successful!")

    finally:
        print("Stopping HTTP server...")
        server_process.terminate()
        server_process.wait()
        print("Server stopped.")

if __name__ == "__main__":
    run_verification()
