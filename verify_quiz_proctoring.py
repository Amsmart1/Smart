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

    screenshots_dir = "/home/jules/verification/screenshots"
    os.makedirs(screenshots_dir, exist_ok=True)

    try:
        with sync_playwright() as p:
            print("Launching headless Chromium browser for Proctoring Quiz E2E tests...")
            browser = p.chromium.launch(headless=True)

            # Setup viewport of 1024x768 width
            context = browser.new_context(
                viewport={"width": 1024, "height": 768},
                record_video_dir="/home/jules/verification/videos"
            )

            # Use context-level initialization script so all pages inherit mocks
            context.add_init_script("""
                sessionStorage.setItem('currentUser', JSON.stringify({
                    email: 'student@smartlms.edu',
                    full_name: 'Student Yaw',
                    role: 'student',
                    active: true
                }));
                sessionStorage.setItem('sessionId', 'mock_student_session_123');

                // Mock navigator.mediaDevices APIs for ProctorEngine (Webcam, Screen share, Audio)
                if (navigator.mediaDevices) {
                    navigator.mediaDevices.getUserMedia = async (constraints) => {
                        console.log('[Mock MediaDevices] getUserMedia called with:', constraints);
                        const track = {
                            kind: 'video',
                            enabled: true,
                            stop: () => console.log('[Mock MediaDevices] Webcam stopped'),
                            addEventListener: () => {},
                            removeEventListener: () => {},
                            getSettings: () => ({ deviceId: 'mock-camera' })
                        };
                        const audioTrack = {
                            kind: 'audio',
                            enabled: true,
                            stop: () => console.log('[Mock MediaDevices] Microphone stopped'),
                            addEventListener: () => {},
                            removeEventListener: () => {},
                            getSettings: () => ({ deviceId: 'mock-mic' })
                        };
                        return {
                            getTracks: () => [track, audioTrack],
                            getVideoTracks: () => [track],
                            getAudioTracks: () => [audioTrack],
                            addTrack: () => {},
                            removeTrack: () => {},
                        };
                    };

                    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
                        console.log('[Mock MediaDevices] getDisplayMedia called with:', constraints);
                        const track = {
                            kind: 'video',
                            enabled: true,
                            stop: () => console.log('[Mock MediaDevices] Screen recording stopped'),
                            addEventListener: () => {},
                            removeEventListener: () => {},
                            getSettings: () => ({ deviceId: 'mock-screen' })
                        };
                        return {
                            getTracks: () => [track],
                            getVideoTracks: () => [track],
                            getAudioTracks: () => [],
                        };
                    };
                }

                // Mock MediaRecorder
                class MockMediaRecorder {
                    constructor(stream, options) {
                        console.log('[Mock MediaRecorder] Created with options:', options);
                        this.stream = stream;
                        this.options = options;
                        this.state = 'inactive';
                    }
                    start(interval) {
                        this.state = 'recording';
                        this.interval = interval;
                        console.log('[Mock MediaRecorder] Started recording with interval:', interval);
                        setTimeout(() => {
                            if (this.ondataavailable) {
                                this.ondataavailable({ data: new Blob(['mock-chunk'], { type: 'video/webm' }) });
                            }
                        }, 100);
                    }
                    stop() {
                        this.state = 'inactive';
                        console.log('[Mock MediaRecorder] Stopped');
                        if (this.onstop) this.onstop();
                    }
                }
                window.MediaRecorder = MockMediaRecorder;

                // Mock window.supabaseClient to prevent initialization failures
                window.supabase = {
                    createClient: () => ({
                        from: () => ({
                            select: () => ({
                                eq: () => Promise.resolve({ data: [], error: null })
                            })
                        })
                    })
                };

                // Enterprise Grade Getter/Setter Interceptor for globally declared ES6 SupabaseDB class
                let originalSupabaseDB;
                Object.defineProperty(window, 'SupabaseDB', {
                    get() {
                        return originalSupabaseDB;
                    },
                    set(val) {
                        originalSupabaseDB = val;
                        // Inject our secure high-fidelity mocks directly onto the constructor class
                        originalSupabaseDB.getUser = async (email) => {
                            console.log('Mock getUser called for:', email);
                            return {
                                email: 'student@smartlms.edu',
                                full_name: 'Student Yaw',
                                role: 'student',
                                active: true,
                                flagged: false,
                                session_id: 'mock_student_session_123',
                                reset_request: null
                            };
                        };
                        originalSupabaseDB.getMaintenance = async () => {
                            return { enabled: false, schedules: [] };
                        };
                        originalSupabaseDB.getSystemSettings = async (key) => {
                            console.log('Mock getSystemSettings called for:', key);
                            if (key === 'proctoring_control') {
                                return { status: 'active' };
                            }
                            return {};
                        };
                        originalSupabaseDB.getEnrollments = async (email) => {
                            console.log('Mock getEnrollments called for:', email);
                            return {
                                data: [{ id: 'enroll-1', course_id: 'course-123' }]
                            };
                        };
                        originalSupabaseDB.getEnrolledCourses = async (email) => {
                            console.log('Mock getEnrolledCourses called for:', email);
                            return {
                                data: [{ id: 'course-123', title: 'Enterprise Software Engineering' }]
                            };
                        };
                        originalSupabaseDB.getQuizzes = async (a, b, courseIds) => {
                            console.log('Mock getQuizzes called');
                            return {
                                data: [
                                    {
                                        id: 'quiz-123',
                                        title: 'Physics & Software Security Finals',
                                        description: 'Comprehensive evaluation with live proctoring enabled.',
                                        course_id: 'course-123',
                                        attempts_allowed: 3,
                                        passing_score: 75,
                                        time_limit: 10, // 10 minutes
                                        shuffle_questions: false,
                                        status: 'published',
                                        anti_cheat_config: {
                                            FULLSCREEN_REQUIRED: false, // DO NOT tie live proctoring to only full screen mode
                                            PROCTORING_WEBCAM: true,
                                            PROCTORING_SCREEN: true,
                                            PROCTORING_AUDIO: false,
                                            PROCTORING_FACE_DETECTION: false,
                                            PROCTORING_NOISE_DETECTION: false
                                        },
                                        questions: [
                                            {
                                                type: 'mcq',
                                                text: 'What is the primary benefit of decoupling live proctoring from full screen mode?',
                                                points: 10,
                                                options: [
                                                    'It enforces complete window lock',
                                                    'It allows flexible proctoring contexts without disrupting desktop workflows',
                                                    'It disables webcam recording',
                                                    'It disables copy paste protection'
                                                ],
                                                correct: 1
                                            }
                                        ]
                                    },
                                    {
                                        id: 'quiz-timeout',
                                        title: 'Short Time Limit Quiz Test',
                                        description: 'Time limit is only 3 seconds for E2E validation.',
                                        course_id: 'course-123',
                                        attempts_allowed: 3,
                                        passing_score: 75,
                                        time_limit: 0.05, // 0.05 minutes = 3 seconds deadline!
                                        shuffle_questions: false,
                                        status: 'published',
                                        anti_cheat_config: {
                                            FULLSCREEN_REQUIRED: false,
                                            PROCTORING_WEBCAM: true,
                                            PROCTORING_SCREEN: false,
                                            PROCTORING_AUDIO: false,
                                            PROCTORING_FACE_DETECTION: false,
                                            PROCTORING_NOISE_DETECTION: false
                                        },
                                        questions: [
                                            {
                                                type: 'short',
                                                text: 'Answer quickly!',
                                                points: 5
                                            }
                                        ]
                                    }
                                ],
                                total: 2
                            };
                        };
                        originalSupabaseDB.getQuiz = async (quizId) => {
                            console.log('Mock getQuiz called for:', quizId);
                            if (quizId === 'quiz-timeout') {
                                return {
                                    id: 'quiz-timeout',
                                    title: 'Short Time Limit Quiz Test',
                                    course_id: 'course-123',
                                    attempts_allowed: 3,
                                    passing_score: 75,
                                    time_limit: 0.05, // 3 seconds
                                    shuffle_questions: false,
                                    status: 'published',
                                    anti_cheat_config: {
                                        FULLSCREEN_REQUIRED: false,
                                        PROCTORING_WEBCAM: true,
                                        PROCTORING_SCREEN: false,
                                        PROCTORING_AUDIO: false,
                                        PROCTORING_FACE_DETECTION: false,
                                        PROCTORING_NOISE_DETECTION: false
                                    },
                                    questions: [{ type: 'short', text: 'Answer quickly!', points: 5 }]
                                };
                            }
                            return {
                                id: 'quiz-123',
                                title: 'Physics & Software Security Finals',
                                description: 'Comprehensive evaluation with live proctoring enabled.',
                                course_id: 'course-123',
                                attempts_allowed: 3,
                                passing_score: 75,
                                time_limit: 10, // 10 minutes
                                shuffle_questions: false,
                                status: 'published',
                                anti_cheat_config: {
                                    FULLSCREEN_REQUIRED: false, // DO NOT tie live proctoring to only full screen mode
                                    PROCTORING_WEBCAM: true,
                                    PROCTORING_SCREEN: true,
                                    PROCTORING_AUDIO: false,
                                    PROCTORING_FACE_DETECTION: false,
                                    PROCTORING_NOISE_DETECTION: false
                                },
                                questions: [
                                    {
                                        type: 'mcq',
                                        text: 'What is the primary benefit of decoupling live proctoring from full screen mode?',
                                        points: 10,
                                        options: [
                                            'It enforces complete window lock',
                                            'It allows flexible proctoring contexts without disrupting desktop workflows',
                                            'It disables webcam recording',
                                            'It disables copy paste protection'
                                        ],
                                        correct: 1
                                    }
                                ]
                            };
                        };
                        originalSupabaseDB.getQuizSubmissions = async (quizId, email, option, filters) => {
                            console.log('Mock getQuizSubmissions called');
                            return { data: [], error: null };
                        };
                        originalSupabaseDB.reconcileQuizAttempts = async () => {
                            return { success: true };
                        };
                        originalSupabaseDB.startQuizAttempt = async (quizId) => {
                            console.log('Mock startQuizAttempt called for:', quizId);
                            if (quizId === 'quiz-timeout') {
                                return {
                                    id: 'sub-timeout-789',
                                    quiz_id: 'quiz-timeout',
                                    student_email: 'student@smartlms.edu',
                                    status: 'in-progress',
                                    started_at: new Date().toISOString(),
                                    answers: {}
                                };
                            }
                            return {
                                id: 'sub-yaw-456',
                                quiz_id: 'quiz-123',
                                student_email: 'student@smartlms.edu',
                                status: 'in-progress',
                                started_at: new Date().toISOString(),
                                answers: {}
                            };
                        };
                        originalSupabaseDB.saveQuizSubmission = async (submission) => {
                            console.log('Mock saveQuizSubmission called:', submission);
                            return submission;
                        };
                        originalSupabaseDB.submitQuizAttempt = async (submissionId, answers, timeSpent) => {
                            console.log('Mock submitQuizAttempt called:', submissionId, answers, timeSpent);
                            const quizId = submissionId === 'sub-timeout-789' ? 'quiz-timeout' : 'quiz-123';
                            return {
                                id: submissionId,
                                quiz_id: quizId,
                                student_email: 'student@smartlms.edu',
                                status: 'submitted',
                                started_at: new Date().toISOString(),
                                submitted_at: new Date().toISOString(),
                                answers: answers,
                                score: submissionId === 'sub-timeout-789' ? 0 : 100,
                                total_points: submissionId === 'sub-timeout-789' ? 5 : 10,
                                time_spent: timeSpent
                            };
                        };
                        originalSupabaseDB.updateCourseProgress = async (courseId, email) => {
                            console.log('Mock updateCourseProgress called');
                            return { success: true };
                        };
                        originalSupabaseDB.saveViolation = async (v) => {
                            console.log('Mock saveViolation logged:', v.type, v);
                            return { success: true };
                        };
                    },
                    configurable: true
                });
            """)

            # -------------------------------------------------------------
            # TEST 1: MANUAL SUBMISSION FLOW WITH LIVE PROCTORING
            # -------------------------------------------------------------
            print("\n--- Test 1: Manual Submission Flow with Live Proctoring ---")
            page = context.new_page()

            # Enable page console logging to diagnose any runtime exceptions
            page.on("console", lambda msg: print(f"[Browser Console] {msg.type}: {msg.text}"))
            page.on("pageerror", lambda err: print(f"[Browser PageError] {err}"))
            # Auto-accept dialogs (like confirm() for submitting quiz)
            page.on("dialog", lambda dialog: (print(f"[Browser Dialog] {dialog.type}: {dialog.message}"), dialog.accept()))

            # Navigate to student dashboard (Quizzes page)
            url = "http://localhost:8000/student.html?page=quizzes"
            print(f"Navigating to {url}...")
            page.goto(url)
            page.wait_for_timeout(3000)

            # Verify Quizzes list is visible
            print("Verifying quizzes page content is rendered...")
            assert page.is_visible("h2:has-text('My Quizzes')"), "Quizzes page header not found"
            assert page.is_visible("h3:has-text('Physics & Software Security Finals')"), "Quiz card not found"

            # Capture initial quiz list state
            print("Taking screenshot of initial proctored quiz list state...")
            page.screenshot(path=f"{screenshots_dir}/1_proctored_quiz_list.png")

            # Click start attempt for quiz-123
            start_btn = page.locator("button[id='quiz-btn-quiz-123']").first
            assert start_btn.is_visible(), "Start button not visible"
            print("Clicking 'Start New Attempt' button...")
            start_btn.click()
            page.wait_for_timeout(2000)

            # Verify the security gesture check page (live proctoring but NO forced fullscreen)
            print("Verifying Security Check Required gesture page is rendered...")
            assert page.is_visible("h3:has-text('Security Check Required')"), "Security Check Required header not found"
            # Since FULLSCREEN_REQUIRED is false, check that it mentions "Advanced Proctoring"
            assert page.locator("p:has-text('Advanced Proctoring')").is_visible(), "Should mention Advanced Proctoring"

            # Capture the gesture/permission verification step
            print("Taking screenshot of proctoring secure start gesture page...")
            page.screenshot(path=f"{screenshots_dir}/2_proctoring_secure_start_gesture.png")

            # Click Secure & Start Quiz
            secure_start_btn = page.locator("#confirmQuizStartBtn").first
            assert secure_start_btn.is_visible(), "Secure & Start button not found"
            print("Clicking 'Secure & Start Quiz' inside the active user gesture handler...")
            secure_start_btn.click()
            page.wait_for_timeout(2000)

            # Check that fullscreen mode is NOT active (since FULLSCREEN_REQUIRED was configured to false)
            is_fullscreen = page.evaluate("() => document.fullscreenElement !== null")
            print(f"Is browser in fullscreen mode? {is_fullscreen}")
            assert not is_fullscreen, "Error: Live proctoring should run perfectly without tying to fullscreen mode!"
            print("✔ Decoupling verified: Live proctoring started correctly without forcing full screen.")

            # Check that the first question is rendered
            assert page.is_visible("h2:has-text('What is the primary benefit of decoupling live proctoring from full screen mode?')"), "First quiz question not found"

            # Capture quiz in-progress screen
            print("Taking screenshot of quiz in progress with live proctoring running...")
            page.screenshot(path=f"{screenshots_dir}/3_quiz_in_progress.png")

            # Select correct answer option (the second option)
            option_b = page.locator(".quiz-option-card").nth(1)
            print("Selecting Option B...")
            option_b.click()
            page.wait_for_timeout(1000)

            # Capture state after selecting option
            print("Taking screenshot of answered option...")
            page.screenshot(path=f"{screenshots_dir}/4_quiz_option_selected.png")

            # Click Submit Quiz
            submit_btn = page.locator("#finalSubmitBtn").first
            assert submit_btn.is_visible(), "Final Submit button not found"
            print("Clicking manual 'Submit Quiz' button...")
            submit_btn.click()
            page.wait_for_timeout(3000)

            # Check that quiz is submitted successfully and score page is displayed
            assert page.is_visible("h2:has-text('Quiz Submitted!')"), "Quiz Submitted results not found"
            assert page.is_visible(".bold:has-text('100%')"), "Quiz score not rendered correctly"

            # Capture final manual submit success screen
            print("Taking screenshot of manual submission results page...")
            page.screenshot(path=f"{screenshots_dir}/5_manual_submit_results.png")


            # -------------------------------------------------------------
            # TEST 2: AUTO-SUBMIT ON TIMEOUT FLOW
            # -------------------------------------------------------------
            print("\n--- Test 2: Auto-Submit on Timeout Flow ---")
            page_timeout = context.new_page()

            # Enable page console logging to diagnose any runtime exceptions
            page_timeout.on("console", lambda msg: print(f"[Browser Console Timeout] {msg.type}: {msg.text}"))
            page_timeout.on("pageerror", lambda err: print(f"[Browser PageError Timeout] {err}"))
            page_timeout.on("dialog", lambda dialog: (print(f"[Browser Dialog Timeout] {dialog.type}: {dialog.message}"), dialog.accept()))

            # Navigate to quizzes
            print("Navigating to quizzes page on timeout browser session...")
            page_timeout.goto(url)
            page_timeout.wait_for_timeout(3000)

            # Start the timeout test attempt for quiz-timeout
            timeout_start_btn = page_timeout.locator("button[id='quiz-btn-quiz-timeout']").first
            assert timeout_start_btn.is_visible(), "Start button for timeout quiz not visible"
            print("Starting attempt on Short Time Limit Quiz...")
            timeout_start_btn.click()
            page_timeout.wait_for_timeout(1000)

            # Click gesture secure button
            page_timeout.locator("#confirmQuizStartBtn").first.click()
            print("Attempt started, awaiting countdown timer expiration (3 seconds)...")

            # Take screenshot during countdown
            page_timeout.wait_for_timeout(1000)
            print("Taking screenshot of countdown timer ticking...")
            page_timeout.screenshot(path=f"{screenshots_dir}/6_quiz_countdown_ticking.png")

            # Wait additional 3-4 seconds to trigger the onEnd countdown callback automatically
            page_timeout.wait_for_timeout(4000)

            # Verify that quiz is automatically submitted on timeout
            print("Verifying automatic submission on timeout...")
            assert page_timeout.is_visible("h2:has-text('Quiz Submitted!')"), "Quiz was not automatically submitted on countdown end!"
            assert page_timeout.is_visible("p:has-text('Your attempt has been recorded successfully.')"), "Successful recording statement missing"

            # Capture timeout auto-submitted results page
            print("Taking screenshot of auto-submitted timeout results page...")
            page_timeout.screenshot(path=f"{screenshots_dir}/7_timeout_auto_submitted.png")

            # Cleanup contexts and browser
            context.close()
            browser.close()
            print("\n✔ E2E Quiz Proctoring and Submission Flow verified successfully on both paths!")

    finally:
        print("Stopping HTTP server...")
        server_process.terminate()
        server_process.wait()
        print("Server stopped.")

if __name__ == "__main__":
    run_verification()
