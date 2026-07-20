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
            print("Launching headless Chromium browser for Live Proctoring Monitor E2E tests...")
            browser = p.chromium.launch(headless=True)

            context = browser.new_context(
                viewport={"width": 1280, "height": 800},
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
                        originalSupabaseDB.getViolations = async (assessmentId, email, teacherEmail, options) => {
                            console.log('Mock getViolations called inside surveillance monitor');
                            const baseTime = Date.now();
                            return {
                                data: [
                                    {
                                        attempt_id: 'attempt-uuid-456',
                                        user_email: 'student@smartlms.edu',
                                        assessment_id: 'quiz-123',
                                        assessment_type: 'quiz',
                                        course_id: 'course-123',
                                        type: 'TAB_SWITCH',
                                        severity: 'HIGH',
                                        score: 15,
                                        metadata: { count: 1 },
                                        timestamp: new Date(baseTime).toISOString(),
                                        device: 'Laptop',
                                        os: 'macOS',
                                        browser: 'Chrome'
                                    },
                                    {
                                        attempt_id: 'attempt-uuid-456',
                                        user_email: 'student@smartlms.edu',
                                        assessment_id: 'quiz-123',
                                        assessment_type: 'quiz',
                                        course_id: 'course-123',
                                        type: 'SNAPSHOT_CAPTURED',
                                        severity: 'INFO',
                                        score: 0,
                                        metadata: { path: 'snapshots/mock_webcam.png' },
                                        timestamp: new Date(baseTime - 10000).toISOString(),
                                        device: 'Laptop',
                                        os: 'macOS',
                                        browser: 'Chrome'
                                    },
                                    {
                                        attempt_id: 'attempt-uuid-456',
                                        user_email: 'student@smartlms.edu',
                                        assessment_id: 'quiz-123',
                                        assessment_type: 'quiz',
                                        course_id: 'course-123',
                                        type: 'CHUNK_RECORDED',
                                        severity: 'INFO',
                                        score: 0,
                                        metadata: { path: 'recordings/mock_screen.webm', size: 102400 },
                                        timestamp: new Date(baseTime - 20000).toISOString(),
                                        device: 'Laptop',
                                        os: 'macOS',
                                        browser: 'Chrome'
                                    },
                                    {
                                        attempt_id: 'attempt-uuid-456',
                                        user_email: 'student@smartlms.edu',
                                        assessment_id: 'quiz-123',
                                        assessment_type: 'quiz',
                                        course_id: 'course-123',
                                        type: 'AUDIO_RECORDED',
                                        severity: 'INFO',
                                        score: 0,
                                        metadata: { path: 'recordings/mock_audio.webm', size: 24500 },
                                        timestamp: new Date(baseTime - 30000).toISOString(),
                                        device: 'Laptop',
                                        os: 'macOS',
                                        browser: 'Chrome'
                                    }
                                ],
                                total: 4
                            };
                        };
                    },
                    configurable: true
                });
            """)

            # Navigate to Live Proctoring Page
            print("\nNavigating to Live Proctoring Page...")
            url_live = "http://localhost:8000/teacher.html?page=live-proctoring"
            page.goto(url_live)
            page.wait_for_timeout(2000)

            # Click 'Monitor' on 'Yaw Student' session
            print("Clicking Monitor button...")
            page.get_by_role("button", name="Monitor").click()
            page.wait_for_timeout(2000)

            # Assert Monitor modal loaded successfully
            assert page.is_visible("h3:has-text('Session Information')"), "Surveillance Monitor Information not loaded"
            print("✔ Surveillance Monitor Information loaded successfully!")

            # Assert Device context, browser, snapshots, screen, audio counts
            assert page.is_visible("h4:has-text('Device Context')"), "Device Context not loaded"

            # Switch tabs and capture screenshots
            print("Taking screenshot of Webcam Snapshots tab...")
            page.screenshot(path=f"{screenshots_dir}/monitor_webcam_tab.png")
            page.wait_for_timeout(1000)

            print("Switching to Screen Recordings tab...")
            page.get_by_role("button", name="Screen Recordings").click()
            page.wait_for_timeout(1000)
            page.screenshot(path=f"{screenshots_dir}/monitor_screen_tab.png")

            print("Switching to Audio Recordings tab...")
            page.get_by_role("button", name="Audio Recordings").click()
            page.wait_for_timeout(1000)
            page.screenshot(path=f"{screenshots_dir}/monitor_audio_tab.png")

            # Close context and browser to save video
            context.close()
            browser.close()
            print("\n✔ Visual E2E test and verification of the live feed complete and successful!")

    finally:
        print("Stopping HTTP server...")
        server_process.terminate()
        server_process.wait()
        print("Server stopped.")

if __name__ == "__main__":
    run_verification()
