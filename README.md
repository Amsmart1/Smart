# SmartLMS - Modern Learning Management System

SmartLMS is an enterprise-grade, high-fidelity learning management system designed to empower educators, students, and administrators with advanced digital tools. The platform seamlessly integrates live interactive virtual learning, secure event-driven proctoring, verifiable graduation certifications, rich discussion forums, and automated AI assistance (Course Tutoring, Assessment Generation, Grading, and public platform guide "Kofi AI").

## Comprehensive Documentation
For an exhaustive reference on all platform features, dashboards, manuals, security policies, and technical architectures, please refer to the dedicated platform guide:
👉 **[PLATFORM_DOCS.md](./PLATFORM_DOCS.md)**

## Core Features

- **Proctored Assessments**: Real-time event-driven integrity tracking (webcam snapshots, face detection, focus tracking, tab switches, copy-paste blockages) with extensive proctoring logs.
- **Live Virtual Classes**: Integrated virtual meeting rooms with localized timezone-aligned attendance heatmaps and recording playback.
- **Verified Certification**: Elegant PDF certificates of completion with unique Verification IDs, registrar digital signatures, and embedded QR validation codes.
- **Advanced Analytics**: Multi-dimensional student radar charts (using Chart.js), student risk predictive models, and automatic GitHub-style attendance grids.
- **Interactive Discussions**: Nested forum threads with badged staff badges and post viewport view-count tracking.
- **AI-Driven Tools**: AI Grading Assistants (caching responses to prevent HTML-injection), AI Assessment/Assignment Generators, and course-aware tutors.
- **Centralized Voice Engine**: High-quality TTS/STT voices with Chrome cutoff bug solutions, silence threshold guards, and permissions notifications.

## Technologies Used

- **Frontend**: Single-Page Application (SPA) architecture utilizing HTML5, CSS3, dynamic ES6 modules, Chart.js for analytics, and modular theme management.
- **Backend / API**: Vercel Serverless Functions (Node.js) acting as the centralized AI Gateway, integrated with external model endpoint normalization rules.
- **Database & Services**: Supabase PostgreSQL with Row-Level Security (RLS) policies, security triggers, and remote procedure calls (RPCs).
