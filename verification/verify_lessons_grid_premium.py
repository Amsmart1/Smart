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

            # Setup viewport of 1024px width
            context = browser.new_context(
                viewport={"width": 1024, "height": 768},
                record_video_dir="verification/videos"
            )

            page = context.new_page()

            # Enable page console logging to diagnose any runtime exceptions
            page.on("console", lambda msg: print(f"[Browser Console] {msg.type}: {msg.text}"))
            page.on("pageerror", lambda err: print(f"[Browser PageError] {err}"))

            # Inject mock student session and custom interceptor getter/setter on window.SupabaseDB
            page.add_init_script("""
                sessionStorage.setItem('currentUser', JSON.stringify({
                    email: 'student@smartlms.edu',
                    full_name: 'Kwame Mensah',
                    role: 'student',
                    active: true
                }));
                sessionStorage.setItem('sessionId', 'mock_student_session_123');

                // Define mock window.supabaseClient to prevent initialization failures
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
                            return {
                                email: 'student@smartlms.edu',
                                full_name: 'Kwame Mensah',
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
                        originalSupabaseDB.getCount = async (table, filterFn, select) => {
                            return 0;
                        };
                        originalSupabaseDB.getEnrolledCourses = async (email) => {
                            return {
                                data: [{ id: 'course-123', title: 'GES Chemistry 101', status: 'published', description: 'Basic chemistry course.', created_by: 'Dr. Mensah' }]
                            };
                        };
                        originalSupabaseDB.getEnrollments = async (email) => {
                            return {
                                data: [{
                                    course_id: 'course-123',
                                    student_email: email,
                                    progress: 50,
                                    completed_lessons: ['lesson-1'],
                                    completed: false
                                }]
                            };
                        };
                        originalSupabaseDB.getCourse = async (id) => {
                            return { id: 'course-123', title: 'GES Chemistry 101', status: 'published' };
                        };
                        originalSupabaseDB.getTopics = async (courseId) => {
                            return {
                                data: [
                                    { id: 'topic-1', title: 'Introduction to Organic Chemistry', course_id: courseId, order_index: 1, description: 'Learn the basic structures and nomenclature of carbon-based compounds.' }
                                ]
                            };
                        };
                        originalSupabaseDB.getLessons = async (courseId) => {
                            return {
                                data: [
                                    { id: 'lesson-1', title: 'Alkanes and Alkenes', topic_id: 'topic-1', course_id: courseId, order_index: 1, content: 'Introduction to alkanes...' },
                                    { id: 'lesson-2', title: 'Functional Groups', topic_id: 'topic-1', course_id: courseId, order_index: 2, content: 'Introduction to functional groups...' },
                                    { id: 'lesson-3', title: 'Isomerism', topic_id: 'topic-1', course_id: courseId, order_index: 3, content: 'Introduction to isomerism...' }
                                ]
                            };
                        };
                        originalSupabaseDB.getAssignments = async (email, courseId, enrolledCourseIds) => {
                            return { data: [] };
                        };
                    },
                    configurable: true
                });
            """)

            url = "http://localhost:8000/student.html?page=my-courses"
            print(f"Navigating to My Courses at {url}...")
            page.goto(url)
            page.wait_for_timeout(3000)

            # Click on 'Open Course' button
            print("Clicking 'Open Course' on GES Chemistry 101...")
            page.click("button:has-text('Open Course')")
            page.wait_for_timeout(3500)

            # Ensure we are in the enhanced Lessons section
            print("Verifying student lessons dashboard...")
            assert page.is_visible("h3:has-text('Lessons')"), "Lessons header not found"

            # Ensure the view toggles are rendered correctly
            assert page.is_visible(".view-mode-toggle"), "View Mode toggler not found"
            print("Verified: Persistent View-Mode Toggle is rendered!")

            # Verify premium card badges and progress elements
            assert page.is_visible(".premium-grid-card"), "Premium grid cards not found"
            assert page.is_visible(".premium-badge-completed"), "Completed badge not found"
            assert page.is_visible(".premium-badge-active"), "Active badge not found"
            assert page.is_visible(".premium-badge-locked"), "Locked badge not found"
            assert page.is_visible(".premium-progress-bar"), "Topic progress bar not found"
            print("Verified: Premium cards, progress tracking, and progression status badges render perfectly!")

            # Take screenshot of the Grid View
            print("Taking screenshot of student lessons Grid View...")
            page.screenshot(path="verification/screenshots/student_lessons_grid_premium.png")

            # Toggle to List view
            print("Toggling to List View...")
            page.click(".view-mode-toggle button:has-text('List')")
            page.wait_for_timeout(2000)

            # Take screenshot of the List View
            print("Taking screenshot of student lessons List View...")
            page.screenshot(path="verification/screenshots/student_lessons_list_premium.png")

            # Toggle back to Grid view
            print("Toggling back to Grid View...")
            page.click(".view-mode-toggle button:has-text('Grid')")
            page.wait_for_timeout(2000)

            context.close()
            browser.close()
            print("Student Lessons premium view verification complete!")

    finally:
        print("Stopping HTTP server...")
        server_process.terminate()
        server_process.wait()
        print("Server stopped.")

if __name__ == "__main__":
    run_verification()
