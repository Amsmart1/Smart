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
                    full_name: 'Professor Ghana',
                    role: 'teacher',
                    active: true
                }));
                sessionStorage.setItem('sessionId', 'mock_teacher_session_123');

                // Define mock window.supabaseClient to prevent initialization failures
                window.supabase = {
                    createClient: () => ({
                        from: () => ({
                            select: () => ({
                                eq: () => Promise.resolve({ data: [], error: null })
                            })
                        }),
                        functions: {
                            invoke: () => Promise.resolve({ data: { success: true, message: 'Successfully indexed!' }, error: null })
                        }
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
                                email: 'teacher@smartlms.edu',
                                full_name: 'Professor Ghana',
                                role: 'teacher',
                                active: true,
                                flagged: false,
                                session_id: 'mock_teacher_session_123',
                                reset_request: null
                            };
                        };
                        originalSupabaseDB.getMaintenance = async () => {
                            console.log('Mock getMaintenance called');
                            return { enabled: false, schedules: [] };
                        };
                        originalSupabaseDB.getCourses = async () => {
                            console.log('Mock getCourses called');
                            return {
                                data: [{ id: 'course-123', title: 'GES Biology 101' }]
                            };
                        };
                        originalSupabaseDB.getMaterials = async () => {
                            console.log('Mock getMaterials called');
                            return {
                                data: [{
                                    id: 'material-456',
                                    title: 'WASSCE Exam Prep Guide.pdf',
                                    file_url: 'https://supabase.co/materials/wassce.pdf',
                                    course_id: 'course-123',
                                    file_type: 'pdf'
                                }]
                            };
                        };
                        originalSupabaseDB.invokeFunction = async (name, payload) => {
                            console.log('Mock invokeFunction called:', name, payload);
                            return { success: true, message: 'Successfully indexed material!' };
                        };
                    },
                    configurable: true
                });
            """)

            url = "http://localhost:8000/teacher.html?page=materials"
            print(f"Navigating to {url}...")
            page.goto(url)
            page.wait_for_timeout(3000)

            print(f"Current page URL is: {page.url}")

            # Check materials are rendered
            print("Verifying materials page rendering...")
            assert page.is_visible("h2:has-text('Course Materials')"), "Materials page header not found"
            assert page.is_visible("h3:has-text('GES Biology 101')"), "Course card not found"
            assert page.is_visible(".small:has-text('WASSCE Exam Prep Guide.pdf')"), "Material item not found"

            # Check Index for AI button
            print("Verifying 'Index for AI' button is present and visible...")
            index_btn = page.locator("button:has-text('Index for AI')").first
            assert index_btn.is_visible(), "'Index for AI' button is not visible"

            # Take screenshot of materials page with button
            print("Taking screenshot of materials dashboard state...")
            page.screenshot(path="/home/jules/verification/screenshots/teacher_materials_page.png")

            # Click Index for AI button
            print("Clicking 'Index for AI' button to open dynamic options modal...")
            index_btn.click()
            page.wait_for_timeout(2000)

            # Check options modal is displayed
            assert page.is_visible(".modal-backdrop"), "Modal backdrop not found"
            assert page.is_visible("strong:has-text('Document Chunking Structure Options')"), "Modal header options not found"
            assert page.is_visible("#optChapters"), "Chapters checkbox not found"
            assert page.is_visible("#optSections"), "Sections checkbox not found"
            assert page.is_visible("#optTopics"), "Topics checkbox not found"
            assert page.is_visible("#optWeeks"), "Weeks checkbox not found"
            assert page.is_visible("#optLessons"), "Lessons checkbox not found"

            print("Verified: Options modal with Chapters, Sections, Topics, Weeks, and Lessons checkboxes rendered perfectly!")

            # Take screenshot of modal
            print("Taking screenshot of chunking options modal...")
            page.screenshot(path="/home/jules/verification/screenshots/teacher_chunking_options_modal.png")

            # Click Confirm
            confirm_btn = page.locator("#confirmYes").first
            print("Clicking confirm inside modal...")
            confirm_btn.click()
            page.wait_for_timeout(1000)

            # Verify modal was closed
            assert not page.is_visible(".modal-backdrop"), "Modal backdrop was not dismissed"
            print("Verified: Modal successfully dismissed after confirmation!")

            # Take final screenshot
            print("Taking final screenshot of completed state...")
            page.screenshot(path="/home/jules/verification/screenshots/teacher_materials_completed.png")

            context.close()
            browser.close()
            print("E2E Playwright Materials Indexing verification complete!")

    finally:
        print("Stopping HTTP server...")
        server_process.terminate()
        server_process.wait()
        print("Server stopped.")

if __name__ == "__main__":
    run_verification()
