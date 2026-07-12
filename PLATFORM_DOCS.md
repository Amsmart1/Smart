# SmartLMS Platform Documentation & Manuals

Welcome to the comprehensive, first-hand knowledge-base for the SmartLMS platform. This document contains all details of the platform's features, manuals, architectures, security policies, troubleshooting guides, and RLS structures.

---

## Platform Overview & Architecture
SmartLMS is architected as an enterprise-grade multi-layer application consisting of:
1. **Frontend Client-Side SPA Layer**: Built with modular ES6 JavaScript, HTML5, and CSS3. Interacts with Supabase using the client SDK and Vercel APIs. Controllers include:
   - `js/core.js`: Bootstrapping, PWA handling, offline assets.
   - `js/student.js`: Student panel views, quiz engines, study planners, live session joins.
   - `js/teacher.js`: Teacher panel views, course designers, gradebooks, AI-driven assistant modals.
   - `js/admin.js`: Administrative configurations, live proctoring monitors, database backup/restorations.
   - `js/ai-gateway.js` & `js/kofi-ai-manager.js`: Communication proxies for AI integrations.
2. **Backend Serverless API Layer (Vercel)**:
   - Relative API gateway routes `/api/ai-gateway` and `/api/kofi-assistant` that handle database-backed session validation, role parsing, and sanitize outbound context without exposing raw model details.
3. **Database and Security Layer (Supabase PostgreSQL)**:
   - Employs strict Row-Level Security (RLS) policies, security-definer RPCs, and custom triggers to lock down tables such as `users`, `enrollments`, `submissions`, `certificates`, and `logs`.

---

## Proctored Assessments & Anti-Cheat (ProctorEngine)
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

---

## Live Virtual Classes & Attendance Heatmaps
Enables synchronous learning with seamless external integration:
- **Virtual Rooms**: Teachers can schedule and start classes, and extend live sessions dynamically in increments of minutes.
- **Continuous Attendance Tracking**: Automated client-side pings verify student participation.
- **GitHub-style Attendance Grid**: Student profile and class attendance is visualized as a 7-row attendance heatmap (representing weekdays over semesters).
- **Localized Timezones**: Meeting timestamps are automatically aligned to the student's browser local timezone.

---

## Verified Certification & PDF Validation
High-fidelity completion certificates are issued upon course mastery:
- **Issuance workflow**: Requested by student, approved or rejected by admin, signed digitally by registrar.
- **Certificate Designs**: Elegant golden borders, custom background watermark designs, registrar signature, and unique Verification ID.
- **Verification QR Code**: Embedded QR codes link to public verification routes where verification databases prove authenticity.

---

## Advanced Analytics & Multi-dimensional Profiling
Educators gain high-granularity data visibility:
- **Radar Charts**: Powered by Chart.js, visualizing multi-dimensional student performance metrics.
- **Predictive Risk Modeling**: Automatically flags students displaying academic risks based on submission rate delays, grade drops, or low attendance heatmaps.
- **Late Penalty Integrines**: Automatically updates grade auto-calculations when assignment submissions pass deadlines.

---

## Interactive Discussions & Thread Tracking
Fosters student engagement in course discussions:
- **Nested replies**: Threaded boards for structured discussion.
- **Viewport View-Counts**: Uses IntersectionObserver to record post views only when they are actually inside the viewport.
- **Staff Badges**: Visually recognizes official Teachers and Administrators in thread loops.

---

## Centralized Voice Engine & Voice Assistant
Centralized speech systems reside in `js/voice-engine.js`:
- **Speech Synthesis (TTS)**: Converts text responses to high-fidelity audio read-aloud.
- **Chrome Synthesis Cutoff Fix**: Retains active utterance references globally under `window._activeUtterance` to prevent Chrome's bug from abruptly silencing TTS after 15 seconds.
- **Speech Recognition (STT)**: Enables hands-free continuous dialogue dictation.
- **Silence Threshold Guard**: Automatically limits continuous speech recognition to 3 consecutive silent restarts to protect resources.
- **Error Hooks**: Propagates microphone denials, permissions blockages, and hardware errors to modal warning cards.

---

## Student Dashboard, Guides & Manual
**Student manual and capabilities**:
- **Onboarding**: Students complete signup, sign in, and view the central overview dashboard featuring quick metrics.
- **Course Enrollment**: Search courses via the dynamic catalog and enroll instantly.
- **Lessons and Materials**: Read lessons, download course files, and view multimedia files in the dynamic material viewer.
- **Assignments & Drafts**: Save assignments as drafts or submit them as final submissions.
- **Quizzes**: Take modular quizzes featuring timers, multiple-choice, true/false, and short answer inputs with auto-save backups.
- **Planner & Study Tracker**: Add personal goals, track study sessions with active timer tracking, and see overall progress charts.

---

## Teacher Dashboard, Guides & Manual
**Teacher manual and capabilities**:
- **Course Designer**: Create courses, add topics, and organize lessons.
- **Asynchronous Dashboards**: Dynamic filters for topics and lessons load without page flashes.
- **AI Assessment Generator**: Dynamically generates context-aware quizzes and assignments matching Bloom's Taxonomy cognitive complexity scales (Remembering, Understanding, Applying, Analyzing, Evaluating, Creating) mapped according to difficulty.
- **AI Grading Assistant**: Analyzes student essay submissions against rubrics. Feedback is stored securely inside memory windows (`window.currentAIGradingData`) and injected dynamically, preventing unsafe HTML script runs or string clashing inside inline DOM event attributes.
- **GradeBook**: View grades in a unified grid, apply late penalties, and export records as CSV or PDF documents.

---

## Admin Dashboard, Guides & Manual
**Admin manual and capabilities**:
- **User Directory**: View all registered users, create new accounts, and toggle active/inactive status.
- **Brute Force Lockout Lock**: Admins can manually lock or unlock compromised student/teacher accounts.
- **Certificate Consolidator**: Approve requested certificates, assign unique verification hashes, and edit parameters.
- **Live Proctor Monitor**: Monitor active assessment session logs in real-time, terminate suspicious sessions, or send warning messages to proctored screens.
- **Backups & Disaster Recovery**: Run manual database backups, export JSON configurations, or restore systems from secure cloud storage.

---

## Security Policies, Access Controls & RLS
- **Same-Origin Referer Locking**: The public Kofi AI Gateway requires requests to originate from matching domains or Vercel production hosts, blocking external hotlinking.
- **Sliding-Window Rate Limiting**: Limit transactions on public endpoints to 30 requests per minute per IP.
- **Centralized Authorization**: Database RPC `get_ai_access_context` validates RBAC roles, ABAC flags, and enrollment status before serverless endpoints execute any downstream commands.
- **User Lockout Protection Trigger**: Database trigger `tr_protect_user_lockout` blocks malicious updates to lockout or authentication tables. Changes are permitted only to admins or postgres security-definer procedures, resolving unauthorized modification vulnerabilities during logins.

---

## Troubleshooting & FAQs
- **Q: Why does my Speech Synthesis stop after 15 seconds?**
  - *A: This is a known Chrome browser engine bug. SmartLMS corrects this by retaining active synthesis references in `window._activeUtterance` to prevent premature garbage collection.*
- **Q: How do I resolve webcam/microphone access errors?**
  - *A: Grant permissions in your browser's security settings. If access is blocked, SmartLMS Voice Engine triggers the `onError` hook to render warning notification cards on your screen.*
- **Q: What is the PWA install warning?**
  - *A: The PWA install warning is prevented from firing unnecessarily on reload. It is configured to show install prompts only to unauthenticated visitors.*
- **Q: Why did my dashboard fail to render updates when switching views rapidly?**
  - *A: SmartLMS applies asynchronous `window.currentRenderId` checks to ignore stale rendered promises, preventing rendering race conditions.*
