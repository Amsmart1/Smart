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
                            invoke: () => Promise.resolve({ data: { success: true }, error: null })
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
                            return { enabled: false, schedules: [] };
                        };
                        originalSupabaseDB.getCount = async (table, filterFn, select) => {
                            return 0;
                        };
                        originalSupabaseDB.getViolations = async () => {
                            return { data: [], total: 0 };
                        };
                        originalSupabaseDB.getCourses = async () => {
                            return {
                                data: [{ id: 'a0f2b2c4-82fa-45b7-a068-123456789012', title: 'GES Biology 101' }]
                            };
                        };
                        originalSupabaseDB.getTopics = async (courseId) => {
                            return {
                                data: [{ id: 'b0f2b2c4-82fa-45b7-a068-123456789012', title: 'Cell Structure and Function', course_id: courseId }]
                            };
                        };
                        originalSupabaseDB.getLessons = async (courseId) => {
                            return { data: [] };
                        };
                        originalSupabaseDB.getAssignments = async (email, courseId) => {
                            return { data: [] };
                        };

                        // Paginated mock of knowledge embeddings: Total 3 items, Force Page size to 2 to test pagination
                        originalSupabaseDB.getKnowledgeEmbeddings = async (courseId, options = {}) => {
                            const pageNum = options.page || 1;
                            const size = 2; // FORCE mock size to 2 for testing
                            console.log(`Mock getKnowledgeEmbeddings called: page=${pageNum}, size=${size}`);

                            const allData = [
                                {
                                    id: 'd0f2b2c4-82fa-45b7-a068-123456789012',
                                    source_type: 'material',
                                    source_id: 'c0f2b2c4-82fa-45b7-a068-123456789012',
                                    course_id: courseId,
                                    content: 'Chloroplasts are organelles that conduct photosynthesis, where the photosynthetic pigment chlorophyll captures the energy from sunlight.',
                                    metadata: { title: 'WASSCE Biology Textbook Chapter 3.pdf' }
                                },
                                {
                                    id: 'e0f2b2c4-82fa-45b7-a068-123456789012',
                                    source_type: 'topic',
                                    source_id: 'b0f2b2c4-82fa-45b7-a068-123456789012',
                                    course_id: courseId,
                                    content: 'The cell is the basic structural, functional, and biological unit of all known organisms. Cells are the smallest units of life.',
                                    metadata: { title: 'Cell Biology Core Concepts' }
                                },
                                {
                                    id: 'f0f2b2c4-82fa-45b7-a068-123456789012',
                                    source_type: 'course',
                                    source_id: 'a0f2b2c4-82fa-45b7-a068-123456789012',
                                    course_id: courseId,
                                    content: 'This course provides a comprehensive introduction to molecular biology, ecology, and genetic inheritance systems.',
                                    metadata: { title: 'GES Biology 101 Course Syllabus' }
                                }
                            ];

                            const start = (pageNum - 1) * size;
                            const end = start + size;
                            const paginatedData = allData.slice(start, end);

                            return {
                                data: paginatedData,
                                total: allData.length,
                                page: pageNum,
                                pageSize: size
                            };
                        };
                        originalSupabaseDB.saveLesson = async (lesson) => {
                            console.log('Mock saveLesson called with payload:', JSON.stringify(lesson));
                            window.__savedLesson = lesson;
                            return [lesson];
                        };
                    },
                    configurable: true
                });
            """)

            url = "http://localhost:8000/teacher.html?page=courses"
            print(f"Navigating directly to {url}...")
            page.goto(url)
            page.wait_for_timeout(3000)

            # Ensure page is rendered and click 'Manage Lessons'
            print("Clicking 'Manage Lessons' on GES Biology 101...")
            page.click("button:has-text('Manage Lessons')")
            page.wait_for_timeout(2000)

            # Ensure we are on the Course Details page and click '+ Add Lesson'
            print("Clicking '+ Add Lesson'...")
            page.click("button:has-text('+ Add Lesson')")
            page.wait_for_timeout(2000)

            # Check if Lesson Form and Import Content side-panel are present
            print("Verifying page layouts and Side-Panel elements...")
            assert page.is_visible("h2:has-text('Add Lesson')"), "Add Lesson header not found"
            assert page.is_visible("#lessonForm"), "Lesson creation form not found"
            assert page.is_visible("h3:has-text('Import Content from Knowledge Base')"), "Knowledge Base Importer panel not found"

            # Check if dropdown has options
            print("Checking Knowledge Base dropdown options...")
            kb_select = page.locator("#kbSourceSelect")
            assert kb_select.is_enabled(), "Knowledge Base dropdown is disabled"

            # Since mock page size is 2 and total is 3, "Load More" button must be visible!
            print("Verifying 'Load More Content' button is visible...")
            load_more_btn = page.locator("#kbLoadMoreBtn")
            assert load_more_btn.is_visible(), "Load More button is not visible initially"

            # Check the initial option count in the dropdown
            # Dropdown options should be: 1 blank default + 2 loaded options = 3 options total.
            option_count = kb_select.locator("option").count()
            print(f"Initial option count in select: {option_count}")
            assert option_count == 3, "Incorrect initial option count"

            # Click 'Load More Content'
            print("Clicking 'Load More Content' to load page 2...")
            load_more_btn.click()
            page.wait_for_timeout(1000)

            # Now, option count should be: 1 blank default + 3 total items = 4 options.
            new_option_count = kb_select.locator("option").count()
            print(f"Option count after load-more: {new_option_count}")
            assert new_option_count == 4, "Load-more did not append new items to select"

            # 'Load More Content' button should now be hidden as all 3 items are loaded!
            assert not load_more_btn.is_visible(), "Load More button should be hidden after loading all items"
            print("Verified: Load More button successfully hid when no more items were available!")

            # Take screenshot of empty lesson creation form with importer panel loaded and expanded
            print("Taking screenshot of lesson form with paginated Importer Panel fully loaded...")
            page.screenshot(path="verification/screenshots/add_lesson_initial.png")

            # Select the third option (the course syllabus, index 2)
            print("Selecting third knowledge base item [COURSE] GES Biology 101 Course Syllabus...")
            kb_select.select_option("2")
            page.wait_for_timeout(1000)

            # Check if editable textarea is shown with the correct chunk content
            assert page.is_visible("#kbPreviewSection"), "KB Preview Section is not visible"
            preview_textarea = page.locator("#kbContentEdit")
            assert preview_textarea.is_visible(), "Editable preview textarea is not visible"
            preview_val = preview_textarea.input_value()
            print(f"Loaded content preview: {preview_val}")
            assert "comprehensive introduction to molecular biology" in preview_val, "Wrong chunk content loaded"

            # Edit the content slightly inside the preview textarea
            print("Modifying selected content inside preview textarea...")
            preview_textarea.fill(preview_val + " Edited by Professor Ghana.")
            page.wait_for_timeout(500)

            # Click Overwrite Lesson Content
            print("Clicking 'Overwrite Lesson Content'...")
            page.click("#kbApplyBtn")
            page.wait_for_timeout(1000)

            # Check if content textarea was populated
            lesson_content = page.locator("#lessonContent").input_value()
            assert "Edited by Professor Ghana" in lesson_content, "Content was not successfully overwritten"
            print("Verified: Content successfully overwritten into main Lesson Content field!")

            # Select first option (index 0)
            print("Selecting first knowledge base item [MATERIAL] WASSCE Biology Textbook Chapter 3.pdf...")
            kb_select.select_option("0")
            page.wait_for_timeout(1000)

            # Click Append to Lesson
            print("Clicking 'Append to Lesson'...")
            page.click("#kbAppendBtn")
            page.wait_for_timeout(1000)

            # Check if both are now present in main lesson content
            final_content = page.locator("#lessonContent").input_value()
            assert "comprehensive introduction to molecular biology" in final_content, "First content was lost during append"
            assert "Chloroplasts are organelles" in final_content, "Second content was not appended"
            print("Verified: Content successfully appended into main Lesson Content field!")

            # Take screenshot showing content transferred to main form
            print("Taking screenshot of lesson form with imported content...")
            page.screenshot(path="verification/screenshots/add_lesson_with_imported_content.png")

            # Fill in Lesson Title and select Topic
            print("Filling Lesson Title and selecting topic...")
            page.fill("#lessonTitle", "Advanced Cell Structures & Chloroplasts")
            page.select_option("#lessonTopicId", "b0f2b2c4-82fa-45b7-a068-123456789012")
            page.wait_for_timeout(500)

            # Save the lesson
            print("Clicking 'Save Lesson' to trigger save...")
            page.click("button:has-text('Save Lesson')")
            page.wait_for_timeout(2000)

            # Verify saved lesson payload matches what we input
            saved_lesson = page.evaluate("window.__savedLesson")
            assert saved_lesson is not None, "saveLesson was not called"
            assert saved_lesson["title"] == "Advanced Cell Structures & Chloroplasts", "Incorrect lesson title saved"
            assert saved_lesson["topic_id"] == "b0f2b2c4-82fa-45b7-a068-123456789012", "Incorrect topic_id saved"
            assert "Chloroplasts are organelles" in saved_lesson["content"], "Incorrect lesson content saved"
            print("Verified: Lesson successfully saved with accurate content and metadata!")

            # Take final screenshot showing return to course details page
            print("Taking final screenshot...")
            page.screenshot(path="verification/screenshots/add_lesson_completed.png")

            context.close()
            browser.close()
            print("E2E Playwright KB Lesson Import verification complete!")

    finally:
        print("Stopping HTTP server...")
        server_process.terminate()
        server_process.wait()
        print("Server stopped.")

if __name__ == "__main__":
    run_verification()
