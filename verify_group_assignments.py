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

    screenshots_dir = "verification/screenshots"
    os.makedirs(screenshots_dir, exist_ok=True)

    try:
        with sync_playwright() as p:
            print("Launching headless Chromium browser for Group Assignments E2E verification...")
            browser = p.chromium.launch(headless=True)

            # Common JS mock template to inject
            def get_mock_js(user_email, user_fullname, user_role, session_id):
                template = """
                console.log('MOCK INIT START: setting up user __USER_EMAIL__');
                sessionStorage.setItem('currentUser', JSON.stringify({
                    email: '__USER_EMAIL__',
                    full_name: '__USER_FULLNAME__',
                    role: '__USER_ROLE__',
                    active: true
                }));
                sessionStorage.setItem('sessionId', '__SESSION_ID__');
                console.log('MOCK INIT: currentUser set to:', sessionStorage.getItem('currentUser'));

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
                    configurable: true,
                    get() { return originalSupabaseDB; },
                    set(val) {
                        originalSupabaseDB = val;
                        originalSupabaseDB.getUser = async (email) => {
                            let curr = { email: '__USER_EMAIL__', full_name: '__USER_FULLNAME__', role: '__USER_ROLE__' };
                            try {
                                curr = JSON.parse(sessionStorage.getItem('currentUser')) || curr;
                            } catch(e) {}
                            return {
                                email: curr.email,
                                full_name: curr.full_name || 'Test User',
                                role: curr.role,
                                active: true,
                                flagged: false,
                                session_id: sessionStorage.getItem('sessionId') || '__SESSION_ID__'
                            };
                        };
                        originalSupabaseDB.getMaintenance = async () => {
                            return { enabled: false, schedules: [] };
                        };
                        originalSupabaseDB.getCourses = async () => {
                            return {
                                data: [{ id: 'course-999', title: 'Calculus III' }]
                            };
                        };
                        originalSupabaseDB.getEnrollmentsByCourses = async (courseIds) => {
                            return {
                                data: [
                                    { student_email: 'student1@smartlms.edu', users: { full_name: 'Isaac Newton' } },
                                    { student_email: 'student2@smartlms.edu', users: { full_name: 'Albert Einstein' } },
                                    { student_email: 'student3@smartlms.edu', users: { full_name: 'Marie Curie' } }
                                ]
                            };
                        };
                        originalSupabaseDB.getAssignments = async () => {
                            return {
                                data: [{
                                    id: 'assign-group-1',
                                    course_id: 'course-999',
                                    title: 'Special Relativity Project',
                                    assignment_type: 'group',
                                    groups: [{
                                        id: 'group-alpha',
                                        title: 'Group Alpha',
                                        members: ['student1@smartlms.edu', 'student2@smartlms.edu'],
                                        leader: 'student1@smartlms.edu'
                                    }],
                                    due_date: '2026-12-31T23:59:59Z',
                                    points_possible: 100,
                                    status: 'published',
                                    questions: [{ text: 'Derive E=mc^2', points: 100 }]
                                }]
                            };
                        };
                        originalSupabaseDB.getAssignment = async () => {
                            return {
                                id: 'assign-group-1',
                                course_id: 'course-999',
                                title: 'Special Relativity Project',
                                assignment_type: 'group',
                                groups: [{
                                    id: 'group-alpha',
                                    title: 'Group Alpha',
                                    members: ['student1@smartlms.edu', 'student2@smartlms.edu'],
                                    leader: 'student1@smartlms.edu'
                                }],
                                due_date: '2026-12-31T23:59:59Z',
                                points_possible: 100,
                                status: 'published',
                                questions: [{ text: 'Derive E=mc^2', points: 100 }]
                            };
                        };
                        originalSupabaseDB.getSubmissions = async () => {
                            return {
                                data: [
                                    {
                                        id: 'sub-leader',
                                        assignment_id: 'assign-group-1',
                                        student_email: 'student1@smartlms.edu',
                                        status: 'submitted',
                                        submitted_at: '2026-07-21T12:00:00Z',
                                        answers: { "0": { type: "essay", value: "E=mc^2 derivation text" } },
                                        users: { full_name: 'Isaac Newton' }
                                    },
                                    {
                                        id: 'sub-member',
                                        assignment_id: 'assign-group-1',
                                        student_email: 'student2@smartlms.edu',
                                        status: 'submitted',
                                        submitted_at: '2026-07-21T12:00:00Z',
                                        answers: { "0": { type: "essay", value: "E=mc^2 derivation text" } },
                                        users: { full_name: 'Albert Einstein' }
                                    }
                                ],
                                total: 2
                            };
                        };
                        originalSupabaseDB.getSubmission = async (assignmentId, email) => {
                            return {
                                id: email === 'student1@smartlms.edu' ? 'sub-leader' : 'sub-member',
                                assignment_id: 'assign-group-1',
                                student_email: email,
                                status: 'submitted',
                                submitted_at: '2026-07-21T12:00:00Z',
                                answers: { "0": { type: "essay", value: "E=mc^2 derivation text" } }
                            };
                        };
                        originalSupabaseDB.saveAssignment = async (data) => {
                            console.log('Mock saveAssignment called:', JSON.stringify(data));
                            return data;
                        };
                        originalSupabaseDB.saveSubmission = async (data) => {
                            console.log('Mock saveSubmission called:', JSON.stringify(data));
                            return data;
                        };
                    }
                });
                """
                return template.replace('__USER_EMAIL__', user_email).replace('__USER_FULLNAME__', user_fullname).replace('__USER_ROLE__', user_role).replace('__SESSION_ID__', session_id)

            # ---- TEST 1: Teacher Dashboard Group Assignment Form ----
            print("\n--- TEST 1: Teacher Group Assignment Form ---")
            context1 = browser.new_context(viewport={"width": 1024, "height": 768}, record_video_dir="/home/jules/verification/videos")
            context1.add_init_script(get_mock_js('teacher@smartlms.edu', 'Professor Ghana', 'teacher', 'mock_teacher_1'))
            page1 = context1.new_page()
            page1.on("console", lambda msg: print(f"[Teacher Console] {msg.type}: {msg.text}"))
            page1.on("pageerror", lambda err: print(f"[Teacher PageError] {err}"))

            print("Navigating to teacher assignments page...")
            page1.goto("http://localhost:8000/teacher.html?page=assignments")
            page1.wait_for_selector("button:has-text('Create Assignment')")
            page1.click("button:has-text('Create Assignment')")

            # Verify presence of Assignment Type dropdown
            print("Verifying Assignment Type selector is present...")
            page1.wait_for_selector("#assignmentType")
            assert page1.is_visible("#assignmentType")
            print("Successfully verified Assignment Type selector!")

            # Select 'group' type
            print("Selecting Group assignment type...")
            page1.select_option("#assignmentType", "group")
            page1.wait_for_selector("#groupConfigSection")
            assert page1.is_visible("#groupConfigSection")
            print("Successfully verified interactive Group Management section is rendered!")

            # Click Add Group
            print("Clicking '+ Add Group' button...")
            page1.click("button:has-text('+ Add Group')")
            page1.wait_for_selector(".group-title-input")
            print("Successfully verified dynamic group card addition!")
            page1.screenshot(path=f"{screenshots_dir}/teacher_group_creator.png")
            context1.close()

            # ---- TEST 2: Student Dashboard Permissions (Leader) ----
            print("\n--- TEST 2: Student Group Leader View ---")
            context2 = browser.new_context(viewport={"width": 1024, "height": 768}, record_video_dir="/home/jules/verification/videos")
            context2.add_init_script(get_mock_js('student1@smartlms.edu', 'Isaac Newton', 'student', 'mock_student_1'))
            page2 = context2.new_page()
            page2.on("console", lambda msg: print(f"[Leader Console] {msg.type}: {msg.text}"))
            page2.on("pageerror", lambda err: print(f"[Leader PageError] {err}"))

            page2.goto("http://localhost:8000/student.html?page=assignments")
            print("Opening group assignment as Leader...")
            page2.wait_for_selector("button:has-text('View/Edit')")
            page2.click("button:has-text('View/Edit')")

            page2.wait_for_selector(".success-text:has-text('GROUP LEADER')")
            assert page2.is_visible(".success-text:has-text('GROUP LEADER')")
            # Submit button should be enabled
            assert page2.is_enabled("#submitAssignBtn")
            print("Successfully verified Group Leader banner and edit permissions!")
            page2.screenshot(path=f"{screenshots_dir}/student_leader_view.png")
            context2.close()

            # ---- TEST 3: Student Dashboard Permissions (Regular Member) ----
            print("\n--- TEST 3: Student Regular Member Read-Only View ---")
            context3 = browser.new_context(viewport={"width": 1024, "height": 768}, record_video_dir="/home/jules/verification/videos")
            context3.add_init_script(get_mock_js('student2@smartlms.edu', 'Albert Einstein', 'student', 'mock_student_2'))
            page3 = context3.new_page()
            page3.on("console", lambda msg: print(f"[Member Console] {msg.type}: {msg.text}"))
            page3.on("pageerror", lambda err: print(f"[Member PageError] {err}"))

            page3.goto("http://localhost:8000/student.html?page=assignments")
            print("Opening group assignment as regular Member...")
            page3.wait_for_selector("button:has-text('View/Edit')")
            page3.click("button:has-text('View/Edit')")

            page3.wait_for_selector(".warning-text:has-text('READ ONLY')")
            assert page3.is_visible(".warning-text:has-text('READ ONLY')")
            # Read-only text should be present
            assert page3.is_visible(".italic:has-text('Read-Only Mode')")
            print("Successfully verified Read-Only permissions for non-leader group members!")
            page3.screenshot(path=f"{screenshots_dir}/student_member_readonly.png")
            context3.close()

            # ---- TEST 4: Teacher Grading Queue Deduplication & Grading Sync ----
            print("\n--- TEST 4: Teacher Deduplicated Grading Queue ---")
            context4 = browser.new_context(viewport={"width": 1024, "height": 768}, record_video_dir="/home/jules/verification/videos")
            context4.add_init_script(get_mock_js('teacher@smartlms.edu', 'Professor Ghana', 'teacher', 'mock_teacher_2'))
            page4 = context4.new_page()
            page4.on("console", lambda msg: print(f"[Grading Console] {msg.type}: {msg.text}"))
            page4.on("pageerror", lambda err: print(f"[Grading PageError] {err}"))

            page4.goto("http://localhost:8000/teacher.html?page=grading")

            # Wait for grading cards to load
            print("Waiting for Grading Queue deduplicated cards...")
            page4.wait_for_selector("strong:has-text('Group:')")
            # Deduplication check: there are two submittedSubs in mock database, but since they belong to the same Group, there should be exactly ONE card shown!
            group_cards_count = page4.locator("strong:has-text('Group:')").count()
            print(f"Deduplicated Group Cards rendered: {group_cards_count}")
            assert group_cards_count == 1
            print("Successfully verified Grading Queue deduplication for Group Assignments!")
            page4.screenshot(path=f"{screenshots_dir}/teacher_deduplicated_grading.png")

            # Review submission
            print("Clicking Review on Deduplicated Group Submission...")
            page4.click("button:has-text('Review')")
            page4.wait_for_selector("strong:has-text('Group Assignment:')")
            assert page4.is_visible("strong:has-text('Group Assignment:')")
            print("Successfully verified Group metadata rendering in Grading view!")
            page4.screenshot(path=f"{screenshots_dir}/teacher_grade_submission_view.png")
            context4.close()

            browser.close()

            print("\n" + "="*50)
            print("  ALL GROUP ASSIGNMENT E2E VERIFICATIONS PASSED PERFECTLY!")
            print("="*50 + "\n")

    finally:
        print("Stopping HTTP server...")
        server_process.terminate()
        server_process.wait()
        print("Server stopped.")

if __name__ == "__main__":
    run_verification()
