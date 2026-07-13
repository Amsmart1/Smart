# SmartLMS Platform Documentation & Manuals

Welcome to the comprehensive, enterprise-grade knowledge-base for the SmartLMS platform. This document serves as the primary source of truth for platform features, manuals, architecture, security policies, troubleshooting guides, role-based FAQs, and sidebar directories.

---

## 1. Platform Overview & Architecture
SmartLMS is architected as an enterprise-grade multi-layer application consisting of:
1. **Frontend Client-Side SPA Layer**: Built with modular ES6 JavaScript, HTML5, and CSS3. Interacts with Supabase using the client SDK and Vercel APIs. Controllers include:
   - `js/core.js`: Bootstrapping, PWA handling, offline assets, help desk subsystems.
   - `js/student.js`: Student panel views, quiz engines, study planners, live session joins.
   - `js/teacher.js`: Teacher panel views, course designers, gradebooks, AI-driven assistant modals.
   - `js/admin.js`: Administrative configurations, live proctoring monitors, database backup/restorations.
   - `js/ai-gateway.js` & `js/kofi-ai-manager.js`: Communication proxies for AI integrations.
2. **Backend Serverless API Layer (Vercel)**:
   - Relative API gateway routes `/api/ai-gateway` and `/api/kofi-assistant` that handle database-backed session validation, role parsing, and sanitize outbound context without exposing raw model details.
3. **Database and Security Layer (Supabase PostgreSQL)**:
   - Employs strict Row-Level Security (RLS) policies, security-definer RPCs, and custom triggers to lock down tables such as `users`, `enrollments`, `submissions`, `certificates`, and `logs`.

---

## 2. Platform Policies, Standards & Support (Landing Page Footer Resources)

### About SmartLMS
SmartLMS is a secure, next-generation learning platform designed for modern education. We focus on academic integrity, student engagement, and providing educators with the tools they need to succeed in a digital-first world. Our mission is to make education accessible and interactive for everyone, everywhere. We believe in the power of technology to transform learning and empower both students and teachers.
- **Security First**: 100% secure infrastructure with advanced anti-cheat systems.
- **Always Accessible**: 24/7 access through offline-enabled PWA design.
- **Insights-Driven**: Real-time multi-dimensional analytics for academic tracking.

### Privacy Policy
At SmartLMS, your privacy is our absolute priority. We only collect and process data necessary to provide a stable, productive learning environment.
- **Personal Information**: We store your name, email, and phone number securely for account management and authentication.
- **Learning Data**: We track your progress, grades, and attendance to help you and your teachers monitor performance.
- **Security Data**: During proctored assessments, we monitor browser activity, window focus, tab-switches, and webcam streams to maintain academic integrity.
- **Data Sharing**: We never sell your data or share it with unauthorized third parties. All serverless communication is encrypted.

### Terms of Service
By using SmartLMS, you agree to follow our professional code of conduct:
- **Academic Integrity**: Users must not engage in cheating, plagiarism, or unauthorized sharing of assessment answers.
- **Mutual Respect**: Users must maintain a polite and respectful tone in discussions, live virtual classes, and feedback threads.
- **Account Security**: You are responsible for keeping your password confidential. Any suspicious activity should be reported immediately.

### Support & Contact Information
Our technical and customer support team is committed to assisting you.
- **Email Support**: `eduquizlms@gmail.com`
- **Phone Support**: `+233 50 596 5310`
- **Availability**: Monday to Friday, 9 AM - 5 PM GMT
- **Technical Tickets**: Authenticated users can file structured support tickets directly from the Help section within their dashboards. Response times are generally under 24 hours.

### Teaching Standards
Our platform encourages and enforces high teaching standards through:
- **Clear Objectives**: Every course, topic, and lesson must list clearly defined learning outcomes and targets.
- **Active Engagement**: Educators are encouraged to leverage integrated live virtual classes, nested discussion forums, and speech utilities to optimize engagement.
- **Timely Feedback**: Detailed grading rubrics and AI-assisted grading feedback ensure swift and constructive evaluation.
- **Fair Assessments**: Incorporates anti-cheat proctoring tools and automated late penalties to guarantee an equal, transparent academic environment.

---

## 3. Core Platform Features & Protocols

### Proctored Assessments & Anti-Cheat (ProctorEngine)
Academic integrity is enforced through an event-driven anti-cheat monitoring system managed by `ProctorEngine`:
- **Webcam Snapshot Capture**: Periodic camera captures with integrated face-detection to verify student presence.
- **Tracking Violations**: Monitors browser focus loss, tab switching, and copy-paste blocks.
- **Integrity Event Stream**: Real-time event uploads chunk-by-chunk to the server.
- **Standardization Whitelist**: Only logs validated under specific system events are recorded, which includes:
  - `ASSESSMENT_SESSION_STARTED`: Session startup log.
  - `ASSESSMENT_SESSION_ENDED`: Normal finalization log.
  - `MULTIPLE_FACES`: Capture event of extra individuals.
  - `NOISE_DETECTED`: Exceeded audio threshold limits.
  - `SCREEN_SHARE_STOPPED`: Unauthorized termination of screen streaming.
- **Violation reports**: Aggregates logs into comprehensive reports that teachers and admins can view on their dashboards.

### Live Virtual Classes & Attendance Heatmaps
Enables synchronous learning with seamless external integration:
- **Virtual Rooms**: Teachers can schedule and start classes, and extend live sessions dynamically in increments of minutes.
- **Continuous Attendance Tracking**: Automated client-side pings verify student participation.
- **GitHub-style Attendance Grid**: Student profile and class attendance is visualized as a 7-row attendance heatmap (representing weekdays over semesters).
- **Localized Timezones**: Meeting timestamps are automatically aligned to the student's browser local timezone.

### Verified Certification & PDF Validation
High-fidelity completion certificates are issued upon course mastery:
- **Issuance workflow**: Requested by student, approved or rejected by admin, signed digitally by registrar.
- **Certificate Designs**: Elegant golden borders, custom background watermark designs, registrar signature, and unique Verification ID.
- **Verification QR Code**: Embedded QR codes link to public verification routes where verification databases prove authenticity.

### Advanced Analytics & Multi-dimensional Profiling
Educators gain high-granularity data visibility:
- **Radar Charts**: Powered by Chart.js, visualizing multi-dimensional student performance metrics.
- **Predictive Risk Modeling**: Automatically flags students displaying academic risks based on submission rate delays, grade drops, or low attendance heatmaps.
- **Late Penalty Integrations**: Automatically updates grade auto-calculations when assignment submissions pass deadlines.

### Interactive Discussions & Thread Tracking
Fosters student engagement in course discussions:
- **Nested replies**: Threaded boards for structured discussion.
- **Viewport View-Counts**: Uses IntersectionObserver to record post views only when they are actually inside the viewport.
- **Staff Badges**: Visually recognizes official Teachers and Administrators in thread loops.

### Centralized Voice Engine & Voice Assistant
Centralized speech systems reside in `js/voice-engine.js`:
- **Speech Synthesis (TTS)**: Converts text responses to high-fidelity audio read-aloud.
- **Chrome Synthesis Cutoff Fix**: Retains active utterance references globally under `window._activeUtterance` to prevent Chrome's bug from abruptly silencing TTS after 15 seconds.
- **Speech Recognition (STT)**: Enables hands-free continuous dialogue dictation.
- **Silence Threshold Guard**: Automatically limits continuous speech recognition to 3 consecutive silent restarts to protect resources.
- **Error Hooks**: Propagates microphone denials, permissions blockages, and hardware errors to modal warning cards.

---

## 4. Student User Manual & Sidebar Feature Directory

The Student dashboard empowers learners to access files, take proctored tests, track progress, participate in live classes, and receive intelligent tutoring. Below is the operational guide for all 18 sidebar tabs:

1. **🏠 Dashboard**: The student homepage. Provides real-time highlights including current enrolled courses, upcoming due dates, overall XP score, and dynamic platform announcements.
2. **🛒 Course Catalog**: A public and private course marketplace. Students browse catalog listings, inspect syllabus plans, and enroll in active terms instantly (using an Enrollment ID if protected).
3. **📚 My Courses**: Lists all active enrollments. Clicking a course navigates to its central outline, showing a list of topics, lesson contents, and completed items.
4. **📝 Assignments**: Houses schoolwork tasks. Shows pending, submitted, and graded assignments. Students can save drafts locally or upload final files/text write-ups before deadlines.
5. **❓ Quizzes**: Interactive assessment hub. Houses modular quizzes equipped with timed limits, automated back-ups, and auto-grade calculations for true/false and multiple-choice questions.
6. **📊 Grades**: A transparent personal ledger. Students inspect detailed feedback, scores, and any late penalties applied to assignments or completed quizzes.
7. **📈 Analytics**: Interactive radar charts showing student performance metrics across multiple dimensions (like participation, assessment accuracy, attendance, and progress pace).
8. **💬 Discussions**: Course-specific forum threads. Allows students to start conversations, ask questions, post nested replies, and view view-counts for their community topics.
9. **🤖 AI Tutor**: Access to the academic Course Tutor, configured to act as a supportive tutor that prompts hints and interactive guidance rather than outputting raw solutions.
10. **📅 Calendar**: Localized dynamic planner. Automatically populates lesson schedules, virtual class slots, and assignment deadlines, aligned with the student's local timezone.
11. **📚 Materials**: The multimedia directory. Students can view and download slides, PDF texts, videos, and zip files uploaded by teachers for various enrolled subjects.
12. **🛡️ Anti-Cheat**: Transparency interface. Displays details about the active proctoring protocols, webcam capture permissions, and a list of any logged violation warnings for student awareness.
13. **📅 Planner**: A productivity system where students can define personal study goals, activate live study timers, and monitor continuous study streaks.
14. **📈 Progress**: Visualizes study achievements, showing completed topics, total hours spent studying, and modular percentage bars tracking syllabus coverage.
15. **📜 Certificates**: The graduation vault. Allows students to request completion certificates for finalized courses and retrieve authorized digital PDFs containing QR verification codes.
16. **Live Classes**: Virtual synchronized session directory. Students join scheduled Jitsi-based live classes, interact via chat, and record attendance automatic pings.
17. **⚙️ Settings**: Account profile manager. Students can adjust display settings, edit their phone number, customize interface themes, and configure notification rules.
18. **❓ Help**: The digital helpdesk. Hosts role-specific FAQs, detailed manual texts, and allows students to file support tickets and review previous resolutions.

---

## 5. Teacher User Manual & Sidebar Feature Directory

The Teacher dashboard is a unified command center for course design, grading, AI-driven evaluation, and synchronized class management. Below is the operational guide for all 16 sidebar tabs:

1. **🏠 Dashboard**: The teacher homepage. Summarizes metrics such as total active student enrollments, pending assignments waiting in the grading queue, and immediate calendar events.
2. **📚 Courses**: The Course Designer studio. Teachers can build new course modules, structure topics, write lessons, publish content, or set status to "Draft".
3. **📂 Materials**: The files repository. Allows instructors to upload slide decks, PDF readings, external reference links, and sample code files for specific courses.
4. **📝 Assignments**: Creation panel for course projects and homework. Teachers define detailed instructions, grading weights, due dates, late penalty structures, and custom rubrics.
5. **📊 Grading Queue**: Interactive grading bench. Teachers evaluate pending student drafts, view submitted documents, and write overall or question-specific comments.
6. **📒 Grade Book**: Comprehensive database grid displaying grades for all students in all published courses. Features export triggers for downloading grade files in CSV or PDF formats.
7. **📈 Analytics**: Multi-dimensional radar charts, risk modeling indicators, and student attendance heatmaps which identify students who may require academic interventions.
8. **👥 Students**: Complete catalog of enrolled students across the teacher's courses. Teachers can manage course roster approvals, view individual student sheets, or remove students.
9. **💬 Discussions**: Moderated discussion forum. Teachers can answer students, start community threads, highlight announcements, and receive staff badges on replies.
10. **🎓 Certificates**: Approvals center. Instructors review student completion certification requests, verify prerequisite scores, and endorse them for final registrar signing.
11. **📅 Calendar**: Fully synchronized academic timeline. Teachers schedule live sessions, map out project due dates, and manage their own instructional timetable.
12. **❓ Quizzes**: Quiz creator. Teachers build timed tests, specify multiple-choice alternatives, true/false parameters, and configure automated grading rules.
13. **🛡️ Anti-Cheat**: Proctoring monitoring center. Review comprehensive violation logs, tracking records, tab-switch alerts, and captured webcam frames for students during quiz sessions.
14. **Live Classes**: Video management system. Schedule new live streams, launch virtual rooms, extend ongoing classes in real-time, and download automatically-calculated attendance logs.
15. **⚙️ Settings**: Account management. Edit profile info, reset authentication keys, configure email notifications, and toggle grading preferences.
16. **❓ Help**: Help system. Read instructor guides, review teacher FAQs, and submit priority technical tickets to administrators.

---

## 6. Admin Dashboard, Guides & Manual

The Admin panel is the central administrative core for security, backups, user directories, and system configuration. Below is the operational guide for all 17 sidebar tabs:

1. **📊 Dashboard**: Global metrics console. Displays active user statistics, database query health, server load parameters, and real-time maintenance badges.
2. **📈 Analytics**: Platform-wide aggregate analytics. Tracks registration trends, general course success rates, and cross-platform student performance charts.
3. **👥 Users**: Directory containing all registered student, teacher, and admin accounts. Admins can create new users, toggle profile active states, or adjust system security flags.
4. **📚 Courses**: Academic control directory. Inspects, approves, archives, or deletes courses across the entire platform to guarantee curriculum quality.
5. **📋 Academic Reports**: Centralized compliance center. Admins review student feedback, reported course issues, grade adjustments, and official transcript verifications.
6. **✉️ Invitations**: Administrative registration management. Generate and track system invitation links with secure pre-set roles (e.g. Teacher roles).
7. **🎫 Support Tickets**: System-wide support desk. Admins review technical complaints, troubleshoot issues, write resolution updates, and close open tickets.
8. **🔄 Security Resets**: Password reset command deck. Manually inspect and approve password reset requests submitted by users facing login blockages.
9. **🎥 Live Proctoring**: Real-time academic supervisor desk. Admins can view active assessment sessions live, monitor proctoring snapshots, and broadcast alert messages.
10. **🛡️ Security Violations**: Consolidated archive of anti-cheat violations. Filterable by date, severity, and student. Houses documentation required for formal honor council cases.
11. **📢 Broadcasts**: Mass-notification engine. Allows administrators to send real-time system alerts, maintenance bulletins, and general updates to specific or all user categories.
12. **🛡️ Maintenance & Access**: Global access gates. Admins toggle platform maintenance mode (blocking access with warning banners), adjust RBAC privileges, and apply brute-force lockout rules.
13. **🏥 System Health**: Server monitoring dashboard. Displays client-to-database latency statistics, active session logs, Edge Function health metrics, and storage capacities.
14. **Database & Backups**: Disaster recovery suite. Run immediate manual backups, download system-wide JSON databases, or restore configurations from remote repositories.
15. **ℹ️ System Info**: Technical software specifications. Lists platform version numbers, connected API endpoints, Supabase configuration parameters, and Vercel route settings.
16. **⚙️ Admin Settings**: Technical customization tools. Customize institution branding, adjust default email smtp credentials, edit theme policies, and update security keys.
17. **❓ Help Center**: Help portal. Accessible knowledge resources, admin-specific system FAQs, and platform development manuals.

---

## 7. Troubleshooting, Platform FAQs & Knowledgebase

### Role-Based FAQ Directory (HELP_DATA Source)

#### Student FAQs

- **Category: ACCOUNT**
  - **Q: How do I reset my password?**
    - *A: Click on 'Forgot Password' on the login screen and follow the instructions to request a reset.*
  - **Q: Can I change my email address?**
    - *A: Email addresses are currently locked to your account. Contact an administrator if you need a change.*
  - **Q: How do I earn XP?**
    - *A: You earn XP by completing lessons, assignments, and quizzes across your enrolled courses.*
- **Category: COURSES**
  - **Q: How do I enroll in a course?**
    - *A: Browse the catalog and click 'Enroll'. Some courses may require an Enrollment ID from your teacher.*
  - **Q: Where can I find my course materials?**
    - *A: Navigate to your course dashboard and look under the 'Materials' tab.*
  - **Q: How is my progress calculated?**
    - *A: Your progress is based on the percentage of lessons and assignments completed in the course.*
- **Category: TECHNICAL**
  - **Q: Does SmartLMS work offline?**
    - *A: You can access some materials offline if you have installed the PWA app on your device.*
  - **Q: What file types are supported for assignments?**
    - *A: We support PDF, DOCX, ZIP, and common image formats (JPG, PNG).*
  - **Q: Why can't I access a live class?**
    - *A: Ensure the teacher has started the session and you have a stable internet connection.*

#### Teacher FAQs

- **Category: COURSE MANAGEMENT**
  - **Q: How do I create a new course?**
    - *A: Click 'Create Course' in your teacher dashboard and fill in the required details.*
  - **Q: Can I hide a course while building it?**
    - *A: Yes, set the course status to 'Draft' until you are ready to publish it.*
  - **Q: How do I manage enrollments?**
    - *A: You can view and manage students in the 'Students' section of your course dashboard.*
- **Category: GRADING & ASSESSMENTS**
  - **Q: How do I grade assignments?**
    - *A: Go to the 'Grading' tab to view pending submissions and provide feedback and scores.*
  - **Q: What are regrade requests?**
    - *A: Students can request a review of their grade if they believe there was an error in assessment.*
  - **Q: How do quizzes work?**
    - *A: Quizzes are automatically graded based on the correct answers you provide during creation.*
- **Category: LIVE INTERACTION**
  - **Q: How do I start a live class?**
    - *A: Create a session and click 'Start Meeting' at the scheduled time.*

#### Admin FAQs

- **Category: SYSTEM**
  - **Q: How do I manage system maintenance?**
    - *A: Use the 'Maintenance' tab in the admin dashboard to schedule or toggle maintenance mode.*
  - **Q: How do I view system health?**
    - *A: The 'Overview' tab provides real-time health metrics and server status.*
- **Category: USER MANAGEMENT**
  - **Q: How do I create teacher accounts?**
    - *A: Go to 'User Management' and use the 'Invite User' or 'Create User' function.*
  - **Q: Can I reactivate a deactivated user?**
    - *A: Yes, find the user in the management list and toggle their 'Active' status.*

---

### Technical & System Troubleshooting Guide

- **Q: Why does my Speech Synthesis stop after 15 seconds?**
  - *A: This is a known Chrome browser engine bug. SmartLMS corrects this by retaining active synthesis references in `window._activeUtterance` to prevent premature garbage collection.*
- **Q: How do I resolve webcam/microphone access errors?**
  - *A: Grant permissions in your browser's security settings. If access is blocked, SmartLMS Voice Engine triggers the `onError` hook to render warning notification cards on your screen.*
- **Q: What is the PWA install warning?**
  - *A: The PWA install warning is prevented from firing unnecessarily on reload. It is configured to show install prompts only to unauthenticated visitors.*
- **Q: Why did my dashboard fail to render updates when switching views rapidly?**
  - *A: SmartLMS applies asynchronous `window.currentRenderId` checks to ignore stale rendered promises, preventing rendering race conditions.*
