-- SmartLMS Supabase Schema (Comprehensive Replacement Script)
-- This script replaces the entire schema while preserving ALL existing features,
-- fixing RLS for the custom auth system, and initializing storage buckets.

SET client_min_messages TO WARNING;
SET client_min_messages TO NOTICE;

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 0. Internal Auth Helpers (Defined early for use in triggers and RPCs)

-- Internal helper to retrieve session ID from headers (DRY)
CREATE OR REPLACE FUNCTION _get_session_id() RETURNS VARCHAR AS $$
DECLARE
  v_headers JSONB;
BEGIN
  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
    RETURN v_headers->>'x-session-id';
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END;
$$ LANGUAGE plpgsql STABLE;

-- Raw helpers that bypass reset-state blocking (Internal use only)
CREATE OR REPLACE FUNCTION get_auth_email_raw() RETURNS VARCHAR AS $$
DECLARE
  v_session_id VARCHAR;
  v_email VARCHAR;
BEGIN
  v_session_id := _get_session_id();
  IF v_session_id IS NOT NULL AND v_session_id <> '' THEN
    SELECT email INTO v_email FROM user_secrets WHERE session_id = v_session_id LIMIT 1;
    RETURN v_email;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_auth_role_raw() RETURNS VARCHAR AS $$
DECLARE
  v_session_id VARCHAR;
  v_role VARCHAR;
BEGIN
  v_session_id := _get_session_id();
  IF v_session_id IS NOT NULL AND v_session_id <> '' THEN
    SELECT u.role INTO v_role
    FROM users u
    JOIN user_secrets s ON u.email = s.email
    WHERE s.session_id = v_session_id
    LIMIT 1;
    RETURN v_role;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Public helpers with mandatory status and reset blocking
-- Returns NULL if user is inactive, flagged, or has an active 'approved' password reset
CREATE OR REPLACE FUNCTION get_auth_email() RETURNS VARCHAR AS $$
DECLARE
  v_email_raw VARCHAR;
  v_email VARCHAR;
  v_active BOOLEAN;
  v_flagged BOOLEAN;
  v_reset_status TEXT;
BEGIN
  v_email_raw := get_auth_email_raw();
  IF v_email_raw IS NOT NULL THEN
    SELECT email, active, flagged, reset_request->>'status'
    INTO v_email, v_active, v_flagged, v_reset_status
    FROM users WHERE email = v_email_raw;

    IF v_email IS NOT NULL AND v_active = TRUE AND v_flagged = FALSE AND (v_reset_status IS NULL OR v_reset_status != 'approved') THEN
        RETURN v_email;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_auth_role() RETURNS VARCHAR AS $$
DECLARE
  v_email_raw VARCHAR;
  v_role VARCHAR;
  v_active BOOLEAN;
  v_flagged BOOLEAN;
  v_reset_status TEXT;
BEGIN
  v_email_raw := get_auth_email_raw();
  IF v_email_raw IS NOT NULL THEN
    SELECT role, active, flagged, reset_request->>'status'
    INTO v_role, v_active, v_flagged, v_reset_status
    FROM users WHERE email = v_email_raw;

    IF v_role IS NOT NULL AND v_active = TRUE AND v_flagged = FALSE AND (v_reset_status IS NULL OR v_reset_status != 'approved') THEN
        RETURN v_role;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN AS $$
  SELECT get_auth_role() = 'admin';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_teacher() RETURNS BOOLEAN AS $$
  SELECT get_auth_role() = 'teacher';
$$ LANGUAGE sql STABLE;

-- Restoration / Migration Mode Helper (SECURED)
CREATE OR REPLACE FUNCTION _is_migration_mode() RETURNS BOOLEAN AS $$
DECLARE
  v_headers JSONB;
BEGIN
  -- Security: Only authenticated administrators can activate migration mode
  -- This prevents malicious users from sending the header to bypass logic.
  IF NOT is_admin() THEN RETURN FALSE; END IF;

  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
    RETURN COALESCE(v_headers->>'x-migration-mode' = 'true', false);
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;
END;
$$ LANGUAGE plpgsql STABLE;


-- 0. Internal helper for notification creation (bypasses RLS)
-- Defined early as it is used by triggers and RPCs
-- We drop it first to handle potential parameter name/type changes (ERROR 42P13)
DROP FUNCTION IF EXISTS notify_user(VARCHAR, TEXT, TEXT, TEXT, TEXT) CASCADE;
CREATE OR REPLACE FUNCTION notify_user(p_email VARCHAR, p_title TEXT, p_message TEXT, p_link TEXT DEFAULT NULL, p_type TEXT DEFAULT 'system')
RETURNS VOID AS $$
BEGIN
  INSERT INTO notifications (user_email, title, message, link, type)
  VALUES (p_email, p_title, p_message, p_link, p_type);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Utility Functions
CREATE OR REPLACE FUNCTION validate_email_format(email VARCHAR)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql' SECURITY DEFINER;

-- Audit Logging Helper
-- 1. Tables Creation (With all columns integrated)

CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT uuid_generate_v4() UNIQUE,
  email VARCHAR(255) PRIMARY KEY CHECK (email = LOWER(email)),
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  role VARCHAR(50) NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_login TIMESTAMP WITH TIME ZONE,
  failed_attempts INTEGER DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMP WITH TIME ZONE,
  lockouts INTEGER DEFAULT 0 CHECK (lockouts >= 0),
  flagged BOOLEAN DEFAULT FALSE,
  reset_request JSONB,
  active BOOLEAN DEFAULT TRUE,
  notification_preferences JSONB DEFAULT '{"email": true, "push": true, "inApp": true}'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Table for sensitive authentication data (Hidden from public SELECT)
CREATE TABLE IF NOT EXISTS user_secrets (
  email VARCHAR(255) PRIMARY KEY REFERENCES users(email) ON UPDATE CASCADE ON DELETE CASCADE CHECK (email = LOWER(email)),
  password_hash VARCHAR(255) NOT NULL,
  session_id VARCHAR(255),
  reset_data JSONB, -- Stores sensitive reset metadata (e.g., temp_password_plain)
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS courses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  created_by VARCHAR(255), -- Stores teacher's full name
  enrollment_id VARCHAR(255), -- Optional ID required for student enrollment
  status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS topics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  order_index INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lessons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES topics(id) ON DELETE CASCADE,
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  title VARCHAR(255) NOT NULL,
  content TEXT,
  video_url TEXT,
  order_index INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS enrollments (
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  student_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE CASCADE CHECK (student_email = LOWER(student_email)),
  enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  progress INTEGER DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  completed BOOLEAN DEFAULT FALSE,
  completed_lessons JSONB DEFAULT '[]'::jsonb,
  PRIMARY KEY (course_id, student_email)
);

CREATE TABLE IF NOT EXISTS assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  start_at TIMESTAMP WITH TIME ZONE,
  due_date TIMESTAMP WITH TIME ZONE,
  points_possible INTEGER DEFAULT 100 CHECK (points_possible > 0),
  allow_late_submissions BOOLEAN DEFAULT TRUE,
  late_penalty_per_day INTEGER DEFAULT 0,
  allowed_extensions TEXT[] DEFAULT '{pdf, doc, docx, zip, jpg, png}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  questions JSONB DEFAULT '[]'::jsonb,
  attachments JSONB DEFAULT '[]'::jsonb,
  status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  anti_cheat_config JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS submissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  assignment_id UUID REFERENCES assignments(id) ON DELETE CASCADE,
  student_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE CASCADE CHECK (student_email = LOWER(student_email)),
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  answers JSONB DEFAULT '{}'::jsonb,
  question_scores JSONB DEFAULT '{}'::jsonb,
  question_feedback JSONB DEFAULT '{}'::jsonb,
  late_penalty_applied INTEGER DEFAULT 0,
  attachments JSONB DEFAULT '[]'::jsonb,
  grade INTEGER CHECK (grade >= 0),
  final_grade INTEGER CHECK (final_grade >= 0),
  feedback TEXT,
  regrade_request TEXT,
  graded_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(50) DEFAULT 'submitted' CHECK (status IN ('draft', 'submitted', 'graded', 'returned')),
  UNIQUE(assignment_id, student_email)
);

CREATE TABLE IF NOT EXISTS live_classes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  start_at TIMESTAMP WITH TIME ZONE NOT NULL,
  end_at TIMESTAMP WITH TIME ZONE NOT NULL CHECK (end_at > start_at),
  room_name VARCHAR(255) NOT NULL,
  meeting_url TEXT,
  recording_url TEXT,
  recurring_config JSONB DEFAULT '{}'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  status VARCHAR(50) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'completed', 'cancelled')),
  actual_end_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  live_class_id UUID REFERENCES live_classes(id) ON DELETE CASCADE,
  student_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE CASCADE CHECK (student_email = LOWER(student_email)),
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  join_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  leave_time TIMESTAMP WITH TIME ZONE,
  duration INTEGER DEFAULT 0,
  is_present BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(live_class_id, student_email)
);

CREATE TABLE IF NOT EXISTS quizzes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  time_limit INTEGER DEFAULT 0 CHECK (time_limit >= 0),
  start_at TIMESTAMP WITH TIME ZONE,
  end_at TIMESTAMP WITH TIME ZONE CHECK (end_at > start_at),
  attempts_allowed INTEGER DEFAULT 1 CHECK (attempts_allowed > 0),
  passing_score INTEGER DEFAULT 60 CHECK (passing_score BETWEEN 0 AND 100),
  questions JSONB DEFAULT '[]'::jsonb,
  shuffle_questions BOOLEAN DEFAULT FALSE,
  status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  anti_cheat_config JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quiz_submissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  quiz_id UUID REFERENCES quizzes(id) ON DELETE CASCADE,
  student_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE CASCADE CHECK (student_email = LOWER(student_email)),
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  attempt_number INTEGER,
  score INTEGER CHECK (score >= 0),
  total_points INTEGER CHECK (total_points >= 0),
  answers JSONB DEFAULT '{}'::jsonb,
  analytics JSONB DEFAULT '{}'::jsonb,
  status VARCHAR(50) DEFAULT 'in-progress' CHECK (status IN ('in-progress', 'submitted')),
  time_spent INTEGER DEFAULT 0,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  submitted_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (quiz_id, student_email, attempt_number)
);

CREATE TABLE IF NOT EXISTS materials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  file_url TEXT,
  file_type VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS discussions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  user_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE CASCADE CHECK (user_email = LOWER(user_email)),
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  parent_id UUID REFERENCES discussions(id) ON DELETE CASCADE,
  title VARCHAR(255),
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE CASCADE CHECK (user_email = LOWER(user_email)),
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  type VARCHAR(50) DEFAULT 'system' CHECK (type IN ('system', 'broadcast', 'assignment_published', 'quiz_published', 'submission_received', 'grade_posted', 'live_class', 'teacher_left', 'class_ended', 'reset_requested', 'password_updated', 'cert_requested', 'cert_issued', 'cert_approved', 'cert_rejected')),
  is_read BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '90 days'),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  target_role VARCHAR(50) CHECK (target_role IS NULL OR target_role IN ('student', 'teacher', 'admin')),
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  type VARCHAR(50) DEFAULT 'system',
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '30 days'),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maintenance (
  id UUID PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000000',
  enabled BOOLEAN DEFAULT FALSE,
  manual_until TIMESTAMP WITH TIME ZONE,
  message TEXT DEFAULT 'System is undergoing maintenance.',
  schedules JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planner (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE CASCADE CHECK (user_email = LOWER(user_email)),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  due_date TIMESTAMP WITH TIME ZONE,
  priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS certificates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  student_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE CASCADE CHECK (student_email = LOWER(student_email)),
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  issued_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  certificate_url TEXT,
  status VARCHAR(50) DEFAULT 'pending_approval' CHECK (status IN ('requested', 'pending_approval', 'approved', 'rejected')),
  type VARCHAR(50) DEFAULT 'single' CHECK (type IN ('single', 'consolidated')),
  request_reason TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE CASCADE CHECK (user_email = LOWER(user_email)),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  duration INTEGER NOT NULL CHECK (duration > 0),
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ended_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) CHECK (email IS NULL OR email = LOWER(email)),
  role VARCHAR(50) NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_by VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (created_by = LOWER(created_by))
);

CREATE TABLE IF NOT EXISTS violations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  user_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE CASCADE CHECK (user_email = LOWER(user_email)),
  teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL CHECK (teacher_email = LOWER(teacher_email)),
  assessment_id UUID NOT NULL,
  assessment_type VARCHAR(50) NOT NULL CHECK (assessment_type IN ('assignment', 'quiz')),
  type VARCHAR(100) NOT NULL,
  browser VARCHAR(100),
  device VARCHAR(50),
  os VARCHAR(50),
  elapsed_time INTEGER, -- in milliseconds
  score INTEGER,
  severity VARCHAR(20),
  metadata JSONB DEFAULT '{}'::jsonb,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '90 days')
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_email VARCHAR(255) NOT NULL CHECK (user_email = LOWER(user_email)),
  role VARCHAR(50) CHECK (role IN ('student', 'teacher', 'admin')),
  subject VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  resolution_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Migrations for existing tables (Idempotent)

DO $$
BEGIN
    -- Separate top-level ALTER statements inside DO block to ensure columns exist for subsequent script parsing
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_check;
    ALTER TABLE users ADD CONSTRAINT users_email_check CHECK (validate_email_format(email));

    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

    -- Maintenance ID constraint cleanup for production-readiness
    ALTER TABLE maintenance DROP CONSTRAINT IF EXISTS maintenance_id_check;

    -- Case-Insensitive Email Constraints for existing tables
    BEGIN
        ALTER TABLE users ADD CONSTRAINT users_email_lower_check CHECK (email = LOWER(email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE user_secrets ADD CONSTRAINT secrets_email_lower_check CHECK (email = LOWER(email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE courses ADD CONSTRAINT courses_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE topics ADD CONSTRAINT topics_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE lessons ADD CONSTRAINT lessons_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE enrollments ADD CONSTRAINT enroll_student_email_lower_check CHECK (student_email = LOWER(student_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE assignments ADD CONSTRAINT assign_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE submissions ADD CONSTRAINT sub_student_email_lower_check CHECK (student_email = LOWER(student_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE submissions ADD CONSTRAINT sub_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE live_classes ADD CONSTRAINT lc_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE attendance ADD CONSTRAINT att_student_email_lower_check CHECK (student_email = LOWER(student_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE attendance ADD CONSTRAINT att_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE quizzes ADD CONSTRAINT quiz_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE quiz_submissions ADD CONSTRAINT qs_student_email_lower_check CHECK (student_email = LOWER(student_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE quiz_submissions ADD CONSTRAINT qs_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE materials ADD CONSTRAINT mat_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE discussions ADD CONSTRAINT disc_user_email_lower_check CHECK (user_email = LOWER(user_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE discussions ADD CONSTRAINT disc_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE notifications ADD CONSTRAINT notif_user_email_lower_check CHECK (user_email = LOWER(user_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE broadcasts ADD CONSTRAINT bc_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE planner ADD CONSTRAINT plan_user_email_lower_check CHECK (user_email = LOWER(user_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE certificates ADD CONSTRAINT cert_student_email_lower_check CHECK (student_email = LOWER(student_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE certificates ADD CONSTRAINT cert_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE study_sessions ADD CONSTRAINT ss_user_email_lower_check CHECK (user_email = LOWER(user_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE study_sessions ADD CONSTRAINT ss_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE invites ADD CONSTRAINT invite_email_lower_check CHECK (email IS NULL OR email = LOWER(email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE invites ADD CONSTRAINT invite_created_by_lower_check CHECK (created_by = LOWER(created_by));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE violations ADD CONSTRAINT vio_user_email_lower_check CHECK (user_email = LOWER(user_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE violations ADD CONSTRAINT vio_teacher_email_lower_check CHECK (teacher_email = LOWER(teacher_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
        ALTER TABLE support_tickets ADD CONSTRAINT ticket_user_email_lower_check CHECK (user_email = LOWER(user_email));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '30 days');
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '90 days');
    ALTER TABLE quiz_submissions ADD COLUMN IF NOT EXISTS attempt_number INTEGER;
    ALTER TABLE quiz_submissions ALTER COLUMN attempt_number DROP NOT NULL;
    ALTER TABLE quiz_submissions ALTER COLUMN status SET DEFAULT 'in-progress';
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS assessment_id UUID;
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS assessment_type VARCHAR(50);
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS type VARCHAR(100);
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS browser VARCHAR(100);
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS device VARCHAR(50);
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS os VARCHAR(50);
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS elapsed_time INTEGER;
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS score INTEGER;
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS severity VARCHAR(20);
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE violations DROP COLUMN IF EXISTS details;
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '90 days');
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Migration step failed: %', SQLERRM;
END $$;

-- Fix quiz_submissions status check constraint if it was incorrectly initialized
DO $$
BEGIN
    ALTER TABLE quiz_submissions DROP CONSTRAINT IF EXISTS quiz_submissions_status_check;
    ALTER TABLE quiz_submissions ADD CONSTRAINT quiz_submissions_status_check CHECK (status IN ('in-progress', 'submitted'));
END $$;

DO $$
BEGIN
    -- users (Move sensitive data if it exists)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS id UUID DEFAULT uuid_generate_v4() UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{"email": true, "push": true, "inApp": true}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER DEFAULT 0 CHECK (failed_attempts >= 0);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS lockouts INTEGER DEFAULT 0 CHECK (lockouts >= 0);

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password') THEN
        INSERT INTO user_secrets (email, password_hash, session_id)
        SELECT email, password, session_id FROM users
        ON CONFLICT (email) DO NOTHING;

        ALTER TABLE users DROP COLUMN IF EXISTS password;
        ALTER TABLE users DROP COLUMN IF EXISTS session_id;
    END IF;

    -- user_secrets
    ALTER TABLE user_secrets ADD COLUMN IF NOT EXISTS reset_data JSONB;
    ALTER TABLE user_secrets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

    -- Migrate existing sensitive reset data (ensure secrets record exists)
    INSERT INTO user_secrets (email, password_hash, reset_data)
    SELECT email, 'MIGRATION_PENDING', jsonb_build_object(
        'temp_password', reset_request->>'temp_password',
        'temp_password_plain', reset_request->>'temp_password_plain'
    )
    FROM users
    WHERE reset_request->>'temp_password' IS NOT NULL
    ON CONFLICT (email) DO UPDATE SET
        reset_data = EXCLUDED.reset_data;

    -- Strip sensitive data from public users table
    UPDATE users
    SET reset_request = reset_request - 'temp_password' - 'temp_password_plain'
    WHERE reset_request IS NOT NULL;

    -- courses
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS enrollment_id VARCHAR(255);
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

    -- topics
    ALTER TABLE topics ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE topics ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL;

    -- lessons
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS topic_id UUID REFERENCES topics(id) ON DELETE CASCADE;

    -- enrollments
    ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0 CHECK (progress BETWEEN 0 AND 100);

    -- assignments
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS points_possible INTEGER DEFAULT 100 CHECK (points_possible > 0);
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS anti_cheat_config JSONB DEFAULT '{}'::jsonb;

    -- submissions
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES courses(id) ON DELETE CASCADE;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS question_feedback JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS question_scores JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS late_penalty_applied INTEGER DEFAULT 0;

    -- Ensure UUID PK for submissions
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'submissions' AND column_name = 'id') THEN
        ALTER TABLE submissions ADD COLUMN id UUID DEFAULT uuid_generate_v4();
    END IF;

    -- Migration to UUID PK if it's still composite
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'submissions' AND tc.constraint_type = 'PRIMARY KEY'
        GROUP BY tc.constraint_name HAVING COUNT(*) > 1
    ) THEN
        ALTER TABLE submissions DROP CONSTRAINT submissions_pkey;
        ALTER TABLE submissions ADD PRIMARY KEY (id);
    END IF;

    -- live_classes
    ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE live_classes ADD COLUMN IF NOT EXISTS end_at TIMESTAMP WITH TIME ZONE;
    -- Note: Adding CHECK constraints to existing columns via ALTER TABLE
    BEGIN
        ALTER TABLE live_classes ADD CONSTRAINT live_classes_end_at_check CHECK (end_at > start_at);
    EXCEPTION WHEN OTHERS THEN NULL; END;

    -- attendance
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES courses(id) ON DELETE CASCADE;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL;

    -- quizzes
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS time_limit INTEGER DEFAULT 0 CHECK (time_limit >= 0);
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS attempts_allowed INTEGER DEFAULT 1 CHECK (attempts_allowed > 0);
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS passing_score INTEGER DEFAULT 60 CHECK (passing_score BETWEEN 0 AND 100);
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS anti_cheat_config JSONB DEFAULT '{}'::jsonb;
    BEGIN
        ALTER TABLE quizzes ADD CONSTRAINT quizzes_end_at_check CHECK (end_at > start_at);
    EXCEPTION WHEN OTHERS THEN NULL; END;

    -- quiz_submissions
    ALTER TABLE quiz_submissions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE quiz_submissions ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES courses(id) ON DELETE CASCADE;
    ALTER TABLE quiz_submissions ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL;
    ALTER TABLE quiz_submissions ADD COLUMN IF NOT EXISTS attempt_number INTEGER;

    -- Migrate quiz_submissions attempt numbers if needed
    -- (Used EXECUTE to ensure it works even if attempt_number was just added)
    EXECUTE '
    UPDATE quiz_submissions SET attempt_number = NULL WHERE status = ''in-progress'';
    WITH numbered_attempts AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY quiz_id, student_email ORDER BY started_at ASC) as row_num
        FROM quiz_submissions
        WHERE status = ''submitted''
    )
    UPDATE quiz_submissions
    SET attempt_number = numbered_attempts.row_num
    FROM numbered_attempts
    WHERE quiz_submissions.id = numbered_attempts.id';

    -- Removed forced NOT NULL/DEFAULT for attempt_number to allow drafts to have NULL attempts

    -- materials
    ALTER TABLE materials ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE materials ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL;

    -- discussions
    ALTER TABLE discussions ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL;

    -- notifications
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    BEGIN
        ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
        ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN ('system', 'broadcast', 'assignment_published', 'quiz_published', 'submission_received', 'grade_posted', 'live_class', 'teacher_left', 'class_ended', 'reset_requested', 'password_updated', 'cert_requested', 'cert_issued', 'cert_approved', 'cert_rejected'));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    -- broadcasts
    ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL;

    -- maintenance
    ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

    -- planner
    ALTER TABLE planner ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

    -- certificates
    ALTER TABLE certificates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE certificates ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL;
    ALTER TABLE certificates ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending_approval';
    ALTER TABLE certificates ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'single';
    ALTER TABLE certificates ADD COLUMN IF NOT EXISTS request_reason TEXT;
    ALTER TABLE certificates ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
    BEGIN
        ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_status_check;
        ALTER TABLE certificates ADD CONSTRAINT certificates_status_check CHECK (status IN ('requested', 'pending_approval', 'approved', 'rejected'));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN
        ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_type_check;
        ALTER TABLE certificates ADD CONSTRAINT certificates_type_check CHECK (type IN ('single', 'consolidated'));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    -- study_sessions
    ALTER TABLE study_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE study_sessions ADD COLUMN IF NOT EXISTS duration INTEGER;
    ALTER TABLE study_sessions ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL;
    BEGIN
        ALTER TABLE study_sessions ADD CONSTRAINT study_sessions_duration_check CHECK (duration > 0);
    EXCEPTION WHEN OTHERS THEN NULL; END;

    -- invites
    ALTER TABLE invites ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

    -- violations
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES courses(id) ON DELETE CASCADE;
    ALTER TABLE violations ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(255) REFERENCES users(email) ON UPDATE CASCADE ON DELETE SET NULL;

    -- Backfill course_id and teacher_email for existing records
    UPDATE submissions s SET course_id = a.course_id, teacher_email = a.teacher_email FROM assignments a WHERE s.assignment_id = a.id AND s.course_id IS NULL;
    UPDATE quiz_submissions s SET course_id = q.course_id, teacher_email = q.teacher_email FROM quizzes q WHERE s.quiz_id = q.id AND s.course_id IS NULL;
    UPDATE attendance a SET course_id = lc.course_id, teacher_email = lc.teacher_email FROM live_classes lc WHERE a.live_class_id = lc.id AND a.course_id IS NULL;
    UPDATE violations v SET course_id = a.course_id, teacher_email = a.teacher_email FROM assignments a WHERE v.assessment_id = a.id AND v.assessment_type = 'assignment' AND v.course_id IS NULL;
    UPDATE violations v SET course_id = q.course_id, teacher_email = q.teacher_email FROM quizzes q WHERE v.assessment_id = q.id AND v.assessment_type = 'quiz' AND v.course_id IS NULL;
    UPDATE topics t SET teacher_email = c.teacher_email FROM courses c WHERE t.course_id = c.id AND t.teacher_email IS NULL;
    UPDATE lessons l SET teacher_email = c.teacher_email FROM courses c WHERE l.course_id = c.id AND l.teacher_email IS NULL;
    UPDATE discussions d SET teacher_email = c.teacher_email FROM courses c WHERE d.course_id = c.id AND d.teacher_email IS NULL;
    UPDATE broadcasts b SET teacher_email = c.teacher_email FROM courses c WHERE b.course_id = c.id AND b.teacher_email IS NULL;
    UPDATE certificates ct SET teacher_email = c.teacher_email FROM courses c WHERE ct.course_id = c.id AND ct.teacher_email IS NULL;
    UPDATE study_sessions ss SET teacher_email = c.teacher_email FROM courses c WHERE ss.course_id = c.id AND ss.teacher_email IS NULL;
END $$;

-- Ensure composite unique constraints exist for idempotent upserts
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'submissions_assignment_id_student_email_key') THEN
        ALTER TABLE submissions ADD CONSTRAINT submissions_assignment_id_student_email_key UNIQUE(assignment_id, student_email);
    END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_live_class_id_student_email_key') THEN
        ALTER TABLE attendance ADD CONSTRAINT attendance_live_class_id_student_email_key UNIQUE(live_class_id, student_email);
    END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quiz_submissions_composite_key') THEN
        ALTER TABLE quiz_submissions ADD CONSTRAINT quiz_submissions_composite_key UNIQUE(quiz_id, student_email, attempt_number);
    END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 3. Triggers for updated_at

DO $$
DECLARE
    t text;
BEGIN
    FOR t IN
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name IN ('users', 'user_secrets', 'courses', 'topics', 'lessons', 'enrollments', 'assignments', 'submissions', 'live_classes', 'attendance', 'quizzes', 'quiz_submissions', 'materials', 'discussions', 'notifications', 'broadcasts', 'maintenance', 'planner', 'certificates', 'study_sessions', 'invites', 'violations', 'support_tickets')
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS update_%I_updated_at ON %I', t, t);
        EXECUTE format('CREATE TRIGGER update_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column()', t, t);
    END LOOP;
END $$;

-- 4. Functional Triggers

-- Trigger to ensure security context for all users (critical for restoration and RLS)
CREATE OR REPLACE FUNCTION tr_ensure_user_secrets() RETURNS TRIGGER AS $$
BEGIN
    -- Use MIGRATION_PENDING as established placeholder for records without active passwords
    INSERT INTO user_secrets (email, password_hash)
    VALUES (NEW.email, 'MIGRATION_PENDING')
    ON CONFLICT (email) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_users_ensure_secrets ON users;
CREATE TRIGGER tr_users_ensure_secrets
AFTER INSERT OR UPDATE OF email ON users
FOR EACH ROW EXECUTE PROCEDURE tr_ensure_user_secrets();

CREATE OR REPLACE FUNCTION create_broadcast(
    p_course_id UUID DEFAULT NULL,
    p_target_role VARCHAR DEFAULT NULL,
    p_title TEXT DEFAULT 'Notification',
    p_message TEXT DEFAULT '',
    p_link TEXT DEFAULT NULL,
    p_type TEXT DEFAULT 'system',
    p_expires_in INTERVAL DEFAULT INTERVAL '30 days'
) RETURNS VOID AS $$
BEGIN
  -- Security: Only authorized roles or system triggers (SECURITY DEFINER) can create broadcasts
  -- Note: p_target_role 'all' is normalized to NULL in the table
  INSERT INTO broadcasts (course_id, target_role, title, message, link, type, expires_at)
  VALUES (p_course_id, NULLIF(p_target_role, 'all'), p_title, p_message, p_link, p_type, NOW() + p_expires_in);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION tr_notify_live_class() RETURNS TRIGGER AS $$
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  IF (TG_OP = 'INSERT') THEN
    IF (NEW.status = 'scheduled') THEN
      PERFORM create_broadcast(NEW.course_id, 'student', 'Live Class Scheduled', 'A new live class "' || NEW.title || '" has been scheduled for ' || NEW.start_at, 'student.html?page=live', 'live_class');
    END IF;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF (NEW.status = 'live' AND OLD.status != 'live') THEN
      PERFORM create_broadcast(NEW.course_id, 'student', 'Live Class Started', 'The class "' || NEW.title || '" has started! Join now.', 'student.html?page=live', 'live_class');
    ELSIF (NEW.status = 'scheduled' AND OLD.status = 'live') THEN
      PERFORM create_broadcast(NEW.course_id, 'student', 'Teacher Left Room', 'The teacher has left the session for "' || NEW.title || '". Please wait for them to rejoin.', 'student.html?page=live', 'teacher_left');
    ELSIF (NEW.status = 'completed' AND OLD.status = 'live') THEN
      PERFORM create_broadcast(NEW.course_id, 'student', 'Class Ended', 'The live class "' || NEW.title || '" has ended.', 'student.html?page=live', 'class_ended');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_live_class_event ON live_classes;
CREATE TRIGGER tr_live_class_event AFTER INSERT OR UPDATE ON live_classes FOR EACH ROW EXECUTE PROCEDURE tr_notify_live_class();

CREATE OR REPLACE FUNCTION tr_notify_assignment() RETURNS TRIGGER AS $$
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  IF (NEW.status = 'published' AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status != 'published'))) THEN
    PERFORM create_broadcast(NEW.course_id, 'student', 'New Assignment', 'A new assignment "' || NEW.title || '" has been published.', 'student.html?page=assignments', 'assignment_published');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_assignment_published ON assignments;
CREATE TRIGGER tr_assignment_published AFTER INSERT OR UPDATE ON assignments FOR EACH ROW EXECUTE PROCEDURE tr_notify_assignment();

CREATE OR REPLACE FUNCTION tr_notify_quiz() RETURNS TRIGGER AS $$
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  IF (NEW.status = 'published' AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status != 'published'))) THEN
    PERFORM create_broadcast(NEW.course_id, 'student', 'New Quiz Available', 'A new quiz "' || NEW.title || '" has been published.', 'student.html?page=quizzes', 'quiz_published');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_quiz_published ON quizzes;
CREATE TRIGGER tr_quiz_published AFTER INSERT OR UPDATE ON quizzes FOR EACH ROW EXECUTE PROCEDURE tr_notify_quiz();

CREATE OR REPLACE FUNCTION tr_notify_submission() RETURNS TRIGGER AS $$
DECLARE
  v_teacher_email VARCHAR(255);
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  SELECT c.teacher_email INTO v_teacher_email FROM courses c JOIN assignments a ON c.id = a.course_id WHERE a.id = NEW.assignment_id;
  IF (NEW.status = 'submitted' AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status != 'submitted'))) THEN
    IF v_teacher_email IS NOT NULL THEN
      PERFORM notify_user(v_teacher_email, 'New Submission', 'A student has submitted an assignment.', 'teacher.html?page=grading', 'submission_received');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_submission_received ON submissions;
CREATE TRIGGER tr_submission_received AFTER INSERT OR UPDATE ON submissions FOR EACH ROW EXECUTE PROCEDURE tr_notify_submission();

CREATE OR REPLACE FUNCTION tr_notify_regrade_request() RETURNS TRIGGER AS $$
DECLARE
  v_teacher_email VARCHAR(255);
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  -- Only trigger if regrade_request is newly added or changed and not null
  IF (NEW.regrade_request IS NOT NULL AND (OLD.regrade_request IS NULL OR OLD.regrade_request != NEW.regrade_request)) THEN
    SELECT teacher_email INTO v_teacher_email FROM courses WHERE id = NEW.course_id;
    IF v_teacher_email IS NOT NULL THEN
      PERFORM notify_user(v_teacher_email, 'Regrade Requested', 'A student has requested a regrade for an assignment.', 'teacher.html?page=grading', 'submission_received');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_submission_regrade_request ON submissions;
CREATE TRIGGER tr_submission_regrade_request AFTER UPDATE ON submissions FOR EACH ROW EXECUTE PROCEDURE tr_notify_regrade_request();

CREATE OR REPLACE FUNCTION tr_notify_grade() RETURNS TRIGGER AS $$
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  IF (NEW.status = 'graded' AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status != 'graded'))) THEN
    PERFORM notify_user(NEW.student_email, 'Assignment Graded', 'Your assignment has been graded. Score: ' || NEW.final_grade || '%', 'student.html?page=assignments', 'grade_posted');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_grade_posted ON submissions;
CREATE TRIGGER tr_grade_posted AFTER INSERT OR UPDATE ON submissions FOR EACH ROW EXECUTE PROCEDURE tr_notify_grade();

CREATE OR REPLACE FUNCTION tr_notify_material_published() RETURNS TRIGGER AS $$
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  IF (TG_OP = 'INSERT') THEN
    PERFORM create_broadcast(NEW.course_id, 'student', 'New Material Added', 'New learning material "' || NEW.title || '" has been uploaded.', 'student.html?page=materials', 'system');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_material_published ON materials;
CREATE TRIGGER tr_material_published AFTER INSERT ON materials FOR EACH ROW EXECUTE PROCEDURE tr_notify_material_published();

CREATE OR REPLACE FUNCTION tr_sync_course_teacher_name() RETURNS TRIGGER AS $$
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  SELECT full_name INTO NEW.created_by FROM users WHERE email = NEW.teacher_email;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_course_teacher_name_sync ON courses;
CREATE TRIGGER tr_course_teacher_name_sync
BEFORE INSERT OR UPDATE OF teacher_email ON courses
FOR EACH ROW EXECUTE PROCEDURE tr_sync_course_teacher_name();

CREATE OR REPLACE FUNCTION tr_update_courses_teacher_name() RETURNS TRIGGER AS $$
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  IF (TG_OP = 'UPDATE' AND OLD.full_name IS DISTINCT FROM NEW.full_name) THEN
    UPDATE courses SET created_by = NEW.full_name WHERE teacher_email = NEW.email;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_users_teacher_name_sync ON users;
CREATE TRIGGER tr_users_teacher_name_sync
AFTER UPDATE OF full_name ON users
FOR EACH ROW EXECUTE PROCEDURE tr_update_courses_teacher_name();

CREATE OR REPLACE FUNCTION tr_sync_course_children_owner() RETURNS TRIGGER AS $$
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  IF (TG_OP = 'UPDATE' AND OLD.teacher_email IS DISTINCT FROM NEW.teacher_email) THEN
    UPDATE assignments SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE quizzes SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE live_classes SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE materials SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE topics SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE lessons SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE submissions SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE quiz_submissions SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE attendance SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE discussions SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE broadcasts SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE certificates SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE study_sessions SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
    UPDATE violations SET teacher_email = NEW.teacher_email WHERE course_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_course_owner_sync_children ON courses;
CREATE TRIGGER tr_course_owner_sync_children
AFTER UPDATE OF teacher_email ON courses
FOR EACH ROW EXECUTE PROCEDURE tr_sync_course_children_owner();

CREATE OR REPLACE FUNCTION tr_inherit_course_data() RETURNS TRIGGER AS $$
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  -- 1. Populate course_id from parent assessments/classes if missing
  IF NEW.course_id IS NULL THEN
    IF TG_TABLE_NAME = 'submissions' THEN
      SELECT course_id INTO NEW.course_id FROM assignments WHERE id = NEW.assignment_id;
    ELSIF TG_TABLE_NAME = 'quiz_submissions' THEN
      SELECT course_id INTO NEW.course_id FROM quizzes WHERE id = NEW.quiz_id;
    ELSIF TG_TABLE_NAME = 'attendance' THEN
      SELECT course_id INTO NEW.course_id FROM live_classes WHERE id = NEW.live_class_id;
    ELSIF TG_TABLE_NAME = 'violations' THEN
      IF NEW.assessment_type = 'assignment' THEN
        SELECT course_id INTO NEW.course_id FROM assignments WHERE id = NEW.assessment_id;
      ELSIF NEW.assessment_type = 'quiz' THEN
        SELECT course_id INTO NEW.course_id FROM quizzes WHERE id = NEW.assessment_id;
      END IF;
    END IF;
  END IF;

  -- 2. Populate teacher_email from course if missing
  IF NEW.teacher_email IS NULL AND NEW.course_id IS NOT NULL THEN
    SELECT teacher_email INTO NEW.teacher_email FROM courses WHERE id = NEW.course_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_topic_data_inherit ON topics;
CREATE TRIGGER tr_topic_data_inherit BEFORE INSERT ON topics FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_lesson_data_inherit ON lessons;
CREATE TRIGGER tr_lesson_data_inherit BEFORE INSERT ON lessons FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_assignment_data_inherit ON assignments;
CREATE TRIGGER tr_assignment_data_inherit BEFORE INSERT ON assignments FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_submission_data_inherit ON submissions;
CREATE TRIGGER tr_submission_data_inherit BEFORE INSERT ON submissions FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_quiz_data_inherit ON quizzes;
CREATE TRIGGER tr_quiz_data_inherit BEFORE INSERT ON quizzes FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_quiz_submission_data_inherit ON quiz_submissions;
CREATE TRIGGER tr_quiz_submission_data_inherit BEFORE INSERT ON quiz_submissions FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_live_class_data_inherit ON live_classes;
CREATE TRIGGER tr_live_class_data_inherit BEFORE INSERT ON live_classes FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_attendance_data_inherit ON attendance;
CREATE TRIGGER tr_attendance_data_inherit BEFORE INSERT ON attendance FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_material_data_inherit ON materials;
CREATE TRIGGER tr_material_data_inherit BEFORE INSERT ON materials FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_discussion_data_inherit ON discussions;
CREATE TRIGGER tr_discussion_data_inherit BEFORE INSERT ON discussions FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_broadcast_data_inherit ON broadcasts;
CREATE TRIGGER tr_broadcast_data_inherit BEFORE INSERT ON broadcasts FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_certificate_data_inherit ON certificates;
CREATE TRIGGER tr_certificate_data_inherit BEFORE INSERT ON certificates FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_study_session_data_inherit ON study_sessions;
CREATE TRIGGER tr_study_session_data_inherit BEFORE INSERT ON study_sessions FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

DROP TRIGGER IF EXISTS tr_violation_data_inherit ON violations;
CREATE TRIGGER tr_violation_data_inherit BEFORE INSERT ON violations FOR EACH ROW EXECUTE PROCEDURE tr_inherit_course_data();

-- 5. Validation Triggers

CREATE OR REPLACE FUNCTION validate_submission_time()
RETURNS TRIGGER AS $$
DECLARE
    v_start_at TIMESTAMP WITH TIME ZONE;
    v_due_date TIMESTAMP WITH TIME ZONE;
    v_allow_late BOOLEAN;
BEGIN
    -- Bypass check for migration mode to allow data restoration and historical record management
    IF _is_migration_mode() THEN
        RETURN NEW;
    END IF;

    SELECT start_at, due_date, allow_late_submissions
    INTO v_start_at, v_due_date, v_allow_late
    FROM assignments
    WHERE id = NEW.assignment_id;

    IF (NEW.status = 'submitted' AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status != 'submitted'))) THEN
        IF v_start_at IS NOT NULL AND NOW() < v_start_at THEN
            RAISE EXCEPTION 'Assignment is not open for submission yet.';
        END IF;

        IF v_due_date IS NOT NULL AND v_allow_late = FALSE AND NOW() > v_due_date THEN
            RAISE EXCEPTION 'Late submissions are not allowed for this assignment.';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_validate_submission_time ON submissions;
CREATE TRIGGER tr_validate_submission_time
BEFORE INSERT OR UPDATE ON submissions
FOR EACH ROW EXECUTE PROCEDURE validate_submission_time();

CREATE OR REPLACE FUNCTION validate_quiz_submission_time()
RETURNS TRIGGER AS $$
DECLARE
    v_start_at TIMESTAMP WITH TIME ZONE;
    v_end_at TIMESTAMP WITH TIME ZONE;
    v_time_limit INTEGER;
    v_is_reconciling BOOLEAN := FALSE;
BEGIN
    -- Bypass check for migration mode to allow data restoration
    IF _is_migration_mode() THEN
        RETURN NEW;
    END IF;

    -- Detect if this update is coming from a trusted authoritative RPC via session metadata if needed,
    -- but for now we just rely on relaxing the late submission check for status transitions to 'submitted'.
    -- The authoritative scoring and timing logic is now handled in reconcile_quiz_attempts and submit_quiz_attempt.

    SELECT start_at, end_at, time_limit
    INTO v_start_at, v_end_at, v_time_limit
    FROM quizzes
    WHERE id = NEW.quiz_id;

    IF (NEW.status = 'submitted' AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (OLD.status IS NULL OR OLD.status != 'submitted')))) THEN
        IF v_start_at IS NOT NULL AND NEW.started_at < v_start_at THEN
             RAISE EXCEPTION 'Quiz was started before the allowed window.';
        END IF;

        -- We allow a larger grace period for 'submitted' transition to support auto-submission and reconciliation.
        -- Authoritative timing is handled in the RPCs.
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_validate_quiz_submission_time ON quiz_submissions;
CREATE TRIGGER tr_validate_quiz_submission_time
BEFORE INSERT OR UPDATE ON quiz_submissions
FOR EACH ROW EXECUTE PROCEDURE validate_quiz_submission_time();

CREATE OR REPLACE FUNCTION validate_quiz_attempts()
RETURNS TRIGGER AS $$
DECLARE
    v_attempts_allowed INTEGER;
    v_next_attempt INTEGER;
BEGIN
    -- Bypass logic for migration mode during restoration, or if attempt_number is already provided
    IF _is_migration_mode() OR NEW.attempt_number IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- Force attempt_number to NULL if it's in-progress to ensure it doesn't count towards used attempts
    IF (NEW.status = 'in-progress') THEN
        NEW.attempt_number := NULL;
    END IF;

    -- Only allocate attempt number when status transition to 'submitted'
    IF (NEW.status = 'submitted' AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM 'submitted')))) THEN
        SELECT attempts_allowed INTO v_attempts_allowed FROM quizzes WHERE id = NEW.quiz_id;

        -- Atomically allocate next attempt number among ALREADY SUBMITTED attempts
        -- We exclude the current row's ID to ensure fresh numbering regardless of previous state
        SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_next_attempt
        FROM quiz_submissions
        WHERE quiz_id = NEW.quiz_id AND student_email = NEW.student_email AND status = 'submitted' AND id != NEW.id;

        IF v_attempts_allowed IS NOT NULL AND v_attempts_allowed > 0 THEN
            IF v_next_attempt > v_attempts_allowed THEN
                RAISE EXCEPTION 'You have reached the maximum number of attempts allowed for this quiz.';
            END IF;
        END IF;

        NEW.attempt_number := v_next_attempt;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_validate_quiz_attempts ON quiz_submissions;
CREATE TRIGGER tr_validate_quiz_attempts
BEFORE INSERT OR UPDATE ON quiz_submissions
FOR EACH ROW EXECUTE PROCEDURE validate_quiz_attempts();

-- Prevent regression from submitted to in-progress
CREATE OR REPLACE FUNCTION prevent_submission_regression()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'submitted' AND NEW.status = 'in-progress' THEN
        RAISE EXCEPTION 'Cannot change status from submitted back to in-progress';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_prevent_submission_regression ON quiz_submissions;
CREATE TRIGGER tr_prevent_submission_regression
BEFORE UPDATE ON quiz_submissions
FOR EACH ROW EXECUTE PROCEDURE prevent_submission_regression();

-- Ensure only one in-progress attempt exists per student per quiz to prevent duplicate start records.
-- This combined with validate_quiz_attempts ensures a clean "one-in-progress-at-a-time" flow.
CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_submissions_in_progress_unique ON quiz_submissions (quiz_id, student_email) WHERE (status = 'in-progress');

-- JSONB Validation Functions
CREATE OR REPLACE FUNCTION validate_jsonb_metadata() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.metadata IS NOT NULL AND jsonb_typeof(NEW.metadata) != 'object' THEN
        RAISE EXCEPTION 'metadata must be a JSON object';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_jsonb_object() RETURNS TRIGGER AS $$
BEGIN
    IF TG_TABLE_NAME = 'submissions' THEN
        IF NEW.answers IS NOT NULL AND jsonb_typeof(NEW.answers) != 'object' THEN
            RAISE EXCEPTION 'answers must be a JSON object';
        END IF;
    ELSIF TG_TABLE_NAME = 'quiz_submissions' THEN
        IF NEW.answers IS NOT NULL AND jsonb_typeof(NEW.answers) != 'object' THEN
            RAISE EXCEPTION 'answers must be a JSON object';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_jsonb_questions() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.questions IS NOT NULL AND jsonb_typeof(NEW.questions) != 'array' THEN
        RAISE EXCEPTION 'questions must be a JSON array';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_validate_users_metadata ON users;
CREATE TRIGGER tr_validate_users_metadata BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE PROCEDURE validate_jsonb_metadata();

DROP TRIGGER IF EXISTS tr_validate_courses_metadata ON courses;
CREATE TRIGGER tr_validate_courses_metadata BEFORE INSERT OR UPDATE ON courses FOR EACH ROW EXECUTE PROCEDURE validate_jsonb_metadata();

DROP TRIGGER IF EXISTS tr_validate_assignments_questions ON assignments;
CREATE TRIGGER tr_validate_assignments_questions BEFORE INSERT OR UPDATE ON assignments FOR EACH ROW EXECUTE PROCEDURE validate_jsonb_questions();

DROP TRIGGER IF EXISTS tr_validate_quizzes_questions ON quizzes;
CREATE TRIGGER tr_validate_quizzes_questions BEFORE INSERT OR UPDATE ON quizzes FOR EACH ROW EXECUTE PROCEDURE validate_jsonb_questions();

DROP TRIGGER IF EXISTS tr_validate_submissions_answers ON submissions;
CREATE TRIGGER tr_validate_submissions_answers BEFORE INSERT OR UPDATE ON submissions FOR EACH ROW EXECUTE PROCEDURE validate_jsonb_object();

DROP TRIGGER IF EXISTS tr_validate_quiz_submissions_answers ON quiz_submissions;
CREATE TRIGGER tr_validate_quiz_submissions_answers BEFORE INSERT OR UPDATE ON quiz_submissions FOR EACH ROW EXECUTE PROCEDURE validate_jsonb_object();

CREATE OR REPLACE FUNCTION tr_populate_reset_request_metadata() RETURNS TRIGGER AS $$
DECLARE
    v_reason TEXT;
    v_category TEXT;
    v_level TEXT;
    v_tip TEXT;
BEGIN
    IF _is_migration_mode() THEN RETURN NEW; END IF;
    -- Only run when reset_request is present and transitioning to 'pending'
    IF NEW.reset_request IS NOT NULL AND
       (OLD.reset_request IS NULL OR OLD.reset_request->>'status' IS DISTINCT FROM 'pending') AND
       NEW.reset_request->>'status' = 'pending' THEN

       v_reason := NEW.reset_request->>'reason';

       -- Server-side taxonomy mapping
       CASE v_reason
           WHEN 'I''m having trouble logging in' THEN
               v_category := 'User Self-Service'; v_level := 'Low'; v_tip := '-Check caps lock.\n-Check the special character used.\n-Try another device.';
           WHEN 'Forgotten Password' THEN
               v_category := 'User Self-Service'; v_level := 'Low'; v_tip := 'Use a password manager to keep your credentials safe.';
           WHEN 'Regular Update' THEN
               v_category := 'User Self-Service'; v_level := 'Low'; v_tip := 'Regularly changing passwords helps maintain account health.';
           WHEN 'Compromised Account' THEN
               v_category := 'Security Incident'; v_level := 'Critical'; v_tip := 'Check your active sessions and enable 2FA after resetting.';
           WHEN 'Suspicious Activity' THEN
               v_category := 'Security Incident'; v_level := 'High'; v_tip := 'Review your login history for unrecognized devices.';
           WHEN 'Policy Enforcement' THEN
               v_category := 'Administrative'; v_level := 'Medium'; v_tip := 'Your organization requires a password update for compliance.';
           WHEN 'Account Recovery' THEN
               v_category := 'Administrative'; v_level := 'Medium'; v_tip := 'Ensure your recovery email and phone are up to date.';
           WHEN 'Lost/Stolen Device' THEN
               v_category := 'Device Management'; v_level := 'High'; v_tip := 'Revoke access for the old device in your security settings.';
           WHEN 'New Primary Device' THEN
               v_category := 'Device Management'; v_level := 'Medium'; v_tip := 'Always set up new devices on a trusted, secure network.';
           ELSE
               v_category := 'Other'; v_level := 'Medium'; v_tip := 'Please contact an administrator for further assistance.';
       END CASE;

       -- Update the JSONB object with derived metadata
       NEW.reset_request := NEW.reset_request || jsonb_build_object(
           'category', v_category,
           'security_level', v_level,
           'tips', v_tip
       );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_users_reset_populate ON users;
CREATE TRIGGER tr_users_reset_populate
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE PROCEDURE tr_populate_reset_request_metadata();

-- 6. Indexes

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);
CREATE INDEX IF NOT EXISTS idx_users_auth_lookup ON users(active, flagged, locked_until);
CREATE INDEX IF NOT EXISTS idx_courses_teacher ON courses(teacher_email);
CREATE INDEX IF NOT EXISTS idx_topics_course ON topics(course_id);
CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id);
CREATE INDEX IF NOT EXISTS idx_lessons_topic ON lessons(topic_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_email);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_email);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_email, is_read);
CREATE INDEX IF NOT EXISTS idx_study_sessions_user ON study_sessions(user_email);
CREATE INDEX IF NOT EXISTS idx_attendance_class ON attendance(live_class_id);
CREATE INDEX IF NOT EXISTS idx_discussions_parent ON discussions(parent_id);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_quiz ON quiz_submissions(quiz_id);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_student ON quiz_submissions(student_email);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_status ON quiz_submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_materials_course ON materials(course_id);
CREATE INDEX IF NOT EXISTS idx_planner_user_date ON planner(user_email, due_date);
CREATE INDEX IF NOT EXISTS idx_broadcasts_expiry ON broadcasts(expires_at);
CREATE INDEX IF NOT EXISTS idx_notifications_expiry ON notifications(expires_at);
CREATE INDEX IF NOT EXISTS idx_violations_expiry ON violations(expires_at);
CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status);
CREATE INDEX IF NOT EXISTS idx_live_classes_status ON live_classes(status);
CREATE INDEX IF NOT EXISTS idx_quizzes_status ON quizzes(status);
CREATE INDEX IF NOT EXISTS idx_assignments_status ON assignments(status);
CREATE INDEX IF NOT EXISTS idx_violations_assessment ON violations(assessment_id);
CREATE INDEX IF NOT EXISTS idx_violations_user ON violations(user_email);
CREATE INDEX IF NOT EXISTS idx_violations_reporting ON violations(assessment_id, user_email);

-- Ensure uniqueness for certificates to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_certificates_unique_single ON certificates (student_email, course_id) WHERE (type = 'single');
CREATE UNIQUE INDEX IF NOT EXISTS idx_certificates_unique_consolidated ON certificates (student_email) WHERE (type = 'consolidated');

-- Missing Foreign-Key Indexes
CREATE INDEX IF NOT EXISTS idx_topics_teacher_email ON topics(teacher_email);
CREATE INDEX IF NOT EXISTS idx_lessons_teacher_email ON lessons(teacher_email);
CREATE INDEX IF NOT EXISTS idx_assignments_teacher_email ON assignments(teacher_email);
CREATE INDEX IF NOT EXISTS idx_submissions_course_id ON submissions(course_id);
CREATE INDEX IF NOT EXISTS idx_submissions_teacher_email ON submissions(teacher_email);
CREATE INDEX IF NOT EXISTS idx_live_classes_course_id ON live_classes(course_id);
CREATE INDEX IF NOT EXISTS idx_live_classes_teacher_email ON live_classes(teacher_email);
CREATE INDEX IF NOT EXISTS idx_attendance_course_id ON attendance(course_id);
CREATE INDEX IF NOT EXISTS idx_attendance_teacher_email ON attendance(teacher_email);
CREATE INDEX IF NOT EXISTS idx_attendance_student_email ON attendance(student_email);
CREATE INDEX IF NOT EXISTS idx_quizzes_course_id ON quizzes(course_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_teacher_email ON quizzes(teacher_email);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_course_id ON quiz_submissions(course_id);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_teacher_email ON quiz_submissions(teacher_email);
CREATE INDEX IF NOT EXISTS idx_materials_teacher_email ON materials(teacher_email);
CREATE INDEX IF NOT EXISTS idx_discussions_course_id ON discussions(course_id);
CREATE INDEX IF NOT EXISTS idx_discussions_user_email ON discussions(user_email);
CREATE INDEX IF NOT EXISTS idx_discussions_teacher_email ON discussions(teacher_email);
CREATE INDEX IF NOT EXISTS idx_broadcasts_course_id ON broadcasts(course_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_teacher_email ON broadcasts(teacher_email);
CREATE INDEX IF NOT EXISTS idx_certificates_course_id ON certificates(course_id);
CREATE INDEX IF NOT EXISTS idx_certificates_student_email ON certificates(student_email);
CREATE INDEX IF NOT EXISTS idx_certificates_teacher_email ON certificates(teacher_email);
CREATE INDEX IF NOT EXISTS idx_study_sessions_course_id ON study_sessions(course_id);
CREATE INDEX IF NOT EXISTS idx_study_sessions_teacher_email ON study_sessions(teacher_email);
CREATE INDEX IF NOT EXISTS idx_violations_course_id ON violations(course_id);
CREATE INDEX IF NOT EXISTS idx_violations_teacher_email ON violations(teacher_email);
CREATE INDEX IF NOT EXISTS idx_invites_created_by ON invites(created_by);

-- Support Tickets Indexes
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_email ON support_tickets(user_email);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);

-- Notification/Broadcast Sorting Optimization
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcasts_course_role ON broadcasts(course_id, target_role);

-- Index for performant RLS identity resolution
CREATE INDEX IF NOT EXISTS idx_user_secrets_session_id ON user_secrets(session_id);

-- Explicit FK Index for Topics
CREATE INDEX IF NOT EXISTS idx_topics_course_id ON topics(course_id);

-- Composite Indexes for Foreign Key Pairs & Common Lookups
CREATE INDEX IF NOT EXISTS idx_enrollments_composite ON enrollments(course_id, student_email);
CREATE INDEX IF NOT EXISTS idx_submissions_composite ON submissions(assignment_id, student_email);
CREATE INDEX IF NOT EXISTS idx_attendance_composite ON attendance(live_class_id, student_email);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_composite ON quiz_submissions(quiz_id, student_email);

-- Composite Indexes for Dashboard Filters
CREATE INDEX IF NOT EXISTS idx_courses_teacher_status ON courses(teacher_email, status);
CREATE INDEX IF NOT EXISTS idx_assignments_course_status ON assignments(course_id, status);
CREATE INDEX IF NOT EXISTS idx_quizzes_course_status ON quizzes(course_id, status);
CREATE INDEX IF NOT EXISTS idx_live_classes_course_status ON live_classes(course_id, status);

-- JSONB GIN Indexes for Search Performance
CREATE INDEX IF NOT EXISTS idx_users_metadata_gin ON users USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_courses_metadata_gin ON courses USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_assignments_questions_gin ON assignments USING GIN (questions);
CREATE INDEX IF NOT EXISTS idx_assignments_anti_cheat_gin ON assignments USING GIN (anti_cheat_config);
CREATE INDEX IF NOT EXISTS idx_quizzes_questions_gin ON quizzes USING GIN (questions);
CREATE INDEX IF NOT EXISTS idx_quizzes_anti_cheat_gin ON quizzes USING GIN (anti_cheat_config);
CREATE INDEX IF NOT EXISTS idx_submissions_answers_gin ON submissions USING GIN (answers);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_answers_gin ON quiz_submissions USING GIN (answers);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_analytics_gin ON quiz_submissions USING GIN (analytics);
CREATE INDEX IF NOT EXISTS idx_violations_metadata_gin ON violations USING GIN (metadata);

-- 7. Helper Functions

-- Auth helpers strictly using Custom x-session-id header (Redundant - moved to Section 0)

-- Internal helper for atomic metadata updates
-- Safely appends or removes values from user metadata tracking arrays
CREATE OR REPLACE FUNCTION update_user_metadata_atomic(
    p_email VARCHAR,
    p_key TEXT,
    p_value JSONB, -- Can be a single string/number or an array of values
    p_operation TEXT -- 'append' or 'remove'
) RETURNS VOID AS $$
BEGIN
    -- Security: Only authorized roles or self can update metadata
    IF NOT (is_admin() OR get_auth_email_raw() = p_email) THEN
        RAISE EXCEPTION 'Unauthorized metadata update.';
    END IF;

    UPDATE users
    SET metadata = CASE
        WHEN p_operation = 'append' THEN
            metadata || jsonb_build_object(p_key,
                COALESCE((
                    SELECT jsonb_agg(DISTINCT x)
                    FROM (
                        SELECT jsonb_array_elements_text(COALESCE(metadata->p_key, '[]'::jsonb)) x
                        UNION ALL
                        SELECT * FROM jsonb_array_elements_text(
                            CASE WHEN jsonb_typeof(p_value) = 'array' THEN p_value ELSE jsonb_build_array(p_value) END
                        )
                    ) t
                ), '[]'::jsonb)
            )
        WHEN p_operation = 'remove' THEN
            metadata || jsonb_build_object(p_key,
                COALESCE((
                    SELECT jsonb_agg(x)
                    FROM jsonb_array_elements_text(COALESCE(metadata->p_key, '[]'::jsonb)) x
                    WHERE x NOT IN (
                        SELECT * FROM jsonb_array_elements_text(
                            CASE WHEN jsonb_typeof(p_value) = 'array' THEN p_value ELSE jsonb_build_array(p_value) END
                        )
                    )
                ), '[]'::jsonb)
            )
        ELSE metadata
    END
    WHERE email = p_email;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Secure Auth Logic
CREATE OR REPLACE FUNCTION authenticate_user(p_email VARCHAR, p_password_hash VARCHAR, p_session_id VARCHAR)
RETURNS JSONB AS $$
DECLARE
  v_user RECORD;
  v_secret RECORD;
BEGIN
  SELECT
    id, email, full_name, phone, role, created_at, updated_at, last_login,
    failed_attempts, locked_until, lockouts, flagged, reset_request,
    active, notification_preferences, metadata
  INTO v_user FROM users WHERE email = p_email;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Account not found');
  END IF;

  IF NOT v_user.active THEN
    RETURN jsonb_build_object('success', false, 'message', 'Account deactivated');
  END IF;

  IF v_user.flagged THEN
    RETURN jsonb_build_object('success', false, 'message', 'Account flagged');
  END IF;

  IF v_user.locked_until IS NOT NULL AND v_user.locked_until > NOW() THEN
    RETURN jsonb_build_object('success', false, 'message', 'Account locked until ' || v_user.locked_until);
  END IF;

  SELECT password_hash, session_id, reset_data INTO v_secret FROM user_secrets WHERE email = p_email;

  -- 1. Handle Missing Secrets (Lazy creation for imported users)
  IF NOT FOUND THEN
      -- Note: Since our migration and administrative approval now ensure a user_secrets record,
      -- this block is primarily for users created via legacy direct-to-db methods.
      IF v_user.reset_request IS NOT NULL AND
         v_user.reset_request->>'status' = 'approved' AND
         (v_user.reset_request->>'expires_at')::TIMESTAMP WITH TIME ZONE > NOW() AND
         (v_user.reset_request->>'temp_password' = p_password_hash) THEN

          -- Create the missing secret (Gateway)
          INSERT INTO user_secrets (email, password_hash, session_id)
          VALUES (p_email, p_password_hash, p_session_id)
          RETURNING * INTO v_secret;
      ELSE
          IF v_user.reset_request IS NOT NULL AND v_user.reset_request->>'status' = 'approved' THEN
             DECLARE
                v_temp_plain TEXT;
             BEGIN
                SELECT reset_data->>'temp_password_plain' INTO v_temp_plain FROM user_secrets WHERE email = p_email;
                RETURN jsonb_build_object(
                    'success', false,
                    'message', 'Invalid password. This account has an approved password reset. Please use the temporary password provided by your administrator to login.',
                    'temp_password', COALESCE(v_temp_plain, v_user.reset_request->>'temp_password_plain', '[Contact Admin]')
                );
             END;
          END IF;
          RETURN jsonb_build_object('success', false, 'message', 'Invalid password or account requires activation');
      END IF;
  END IF;

  -- 2. Handle Existing Secrets (Regular, updated, or just-created gateway)
  IF v_secret.password_hash = p_password_hash OR (v_secret.reset_data->>'temp_password' = p_password_hash) THEN
    -- Special Check: If the password matches the temp password in an active reset request,
    -- or if it matches the main password_hash while a reset is STILL active (meaning it was just updated but not finalized),
    -- check for expiry if it's the temp password.
    IF v_user.reset_request IS NOT NULL AND
       v_user.reset_request->>'status' = 'approved' THEN

        -- If they are using the temp password, enforce expiry
        IF (v_secret.reset_data->>'temp_password' = p_password_hash OR v_user.reset_request->>'temp_password' = p_password_hash) THEN
            IF (v_user.reset_request->>'expires_at')::TIMESTAMP WITH TIME ZONE < NOW() THEN
                 RETURN jsonb_build_object('success', false, 'message', 'Temporary password expired');
            END IF;
        END IF;

        -- If they are using the main password_hash but the reset_request is still there,
        -- it means they successfully updated it but haven't called finalize yet (or it failed).
        -- We allow this "transitional" authentication to facilitate the finalization flow.
    END IF;

    -- Update session and login stats
    UPDATE user_secrets SET session_id = p_session_id WHERE email = p_email;
    UPDATE users SET
      last_login = NOW(),
      failed_attempts = 0,
      locked_until = NULL,
      metadata = COALESCE(metadata, '{}'::jsonb) || '{"last_invalidation_reason": "new_login"}'::jsonb
    WHERE email = p_email
    RETURNING last_login, failed_attempts, locked_until, metadata INTO v_user.last_login, v_user.failed_attempts, v_user.locked_until, v_user.metadata;

    RETURN jsonb_build_object(
      'success', true,
      'user', jsonb_build_object(
        'id', v_user.id,
        'email', v_user.email,
        'full_name', v_user.full_name,
        'phone', v_user.phone,
        'role', v_user.role,
        'created_at', v_user.created_at,
        'updated_at', v_user.updated_at,
        'last_login', v_user.last_login,
        'failed_attempts', v_user.failed_attempts,
        'locked_until', v_user.locked_until,
        'lockouts', v_user.lockouts,
        'flagged', v_user.flagged,
        'reset_request', v_user.reset_request,
        'active', v_user.active,
        'notification_preferences', v_user.notification_preferences,
        'metadata', v_user.metadata,
        'session_id', p_session_id
      )
    );
  ELSE
    -- Increment failed attempts
    UPDATE users SET failed_attempts = failed_attempts + 1 WHERE email = p_email;

    -- Lock account if too many attempts
    IF v_user.failed_attempts + 1 >= 5 THEN
        UPDATE users SET locked_until = NOW() + INTERVAL '30 minutes', failed_attempts = 0, lockouts = lockouts + 1 WHERE email = p_email;
        -- Flag if too many lockouts
        IF v_user.lockouts + 1 >= 3 THEN
            UPDATE users SET flagged = TRUE WHERE email = p_email;
        END IF;

        RETURN jsonb_build_object('success', false, 'message', 'Too many failed attempts. Account locked for 30 minutes.');
    END IF;

    -- If there is an approved reset request, return the temp password separately
    IF v_user.reset_request IS NOT NULL AND v_user.reset_request->>'status' = 'approved' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Invalid password. This account has an approved password reset. Please use the temporary password provided by your administrator to login.',
            'temp_password', COALESCE(v_secret.reset_data->>'temp_password_plain', '[Contact Admin]')
        );
    END IF;

    RETURN jsonb_build_object('success', false, 'message', 'Invalid password. ' || (5 - (v_user.failed_attempts + 1)) || ' attempts remaining.');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Secure User Creation RPC
CREATE OR REPLACE FUNCTION create_user_secure(
    p_email VARCHAR,
    p_full_name VARCHAR,
    p_phone VARCHAR DEFAULT NULL,
    p_password_hash VARCHAR DEFAULT NULL,
    p_role VARCHAR DEFAULT NULL,
    p_session_id VARCHAR DEFAULT NULL,
    p_invite_token VARCHAR DEFAULT NULL,
    p_active BOOLEAN DEFAULT TRUE,
    p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE
    v_actual_role VARCHAR := 'student';
    v_invite JSONB;
BEGIN
    -- 0. Server-side Validation
    p_email := lower(trim(p_email));
    IF NOT validate_email_format(p_email) THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid email format');
    END IF;

    IF p_full_name IS NULL OR length(trim(p_full_name)) < 2 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Full name is required (min 2 chars)');
    END IF;

    IF p_password_hash IS NULL OR length(p_password_hash) < 8 THEN
         RETURN jsonb_build_object('success', false, 'message', 'Invalid password hash');
    END IF;

    -- 1. Check if user fully exists (User record + Secret record)
    -- If user exists in users table but lacks a secret, we allow "reclaiming" the account.
    IF EXISTS (SELECT 1 FROM users WHERE email = p_email) AND
       EXISTS (SELECT 1 FROM user_secrets WHERE email = p_email) THEN
        RETURN jsonb_build_object('success', false, 'message', 'User with this email already exists');
    END IF;

    -- 2. Role Validation
    IF p_role IN ('admin', 'teacher') THEN
        IF is_admin() THEN
            -- Admins can create any role
            v_actual_role := p_role;
        ELSIF p_invite_token IS NULL THEN
            -- Public signups for admin/teacher limited to 1
            IF (SELECT COUNT(*) FROM users WHERE role = p_role) >= 1 THEN
                RETURN jsonb_build_object('success', false, 'message', 'Maximum number of ' || p_role || ' accounts reached. Invitation required.');
            END IF;
            v_actual_role := p_role;
        ELSE
            -- Validate invite
            SELECT to_jsonb(i.*) INTO v_invite FROM invites i WHERE token = p_invite_token AND (email IS NULL OR email = p_email) AND used_at IS NULL AND expires_at > NOW();
            IF v_invite IS NULL THEN
                RETURN jsonb_build_object('success', false, 'message', 'Invalid or expired invitation');
            END IF;
            v_actual_role := v_invite->>'role';
            -- Mark invite as used
            UPDATE invites SET used_at = NOW() WHERE token = p_invite_token;
        END IF;
    ELSE
        v_actual_role := 'student';
    END IF;

    -- 3. Create or Update User record
    INSERT INTO users (email, full_name, phone, role, active, metadata)
    VALUES (p_email, p_full_name, p_phone, v_actual_role, p_active, p_metadata)
    ON CONFLICT (email) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        phone = EXCLUDED.phone,
        active = EXCLUDED.active,
        metadata = users.metadata || EXCLUDED.metadata,
        updated_at = NOW();

    -- 4. Create or Update Secrets
    INSERT INTO user_secrets (email, password_hash, session_id)
    VALUES (p_email, p_password_hash, p_session_id)
    ON CONFLICT (email) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        session_id = EXCLUDED.session_id,
        updated_at = NOW();

    RETURN jsonb_build_object('success', true, 'user', (
        SELECT to_jsonb(t.*) FROM (
            SELECT u.*, s.session_id
            FROM users u
            JOIN user_secrets s ON u.email = s.email
            WHERE u.email = p_email
        ) t
    ));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Secure Password Reset Finalization RPC
CREATE OR REPLACE FUNCTION finalize_password_reset_secure(
    p_email VARCHAR,
    p_new_password_hash VARCHAR,
    p_session_id VARCHAR
) RETURNS JSONB AS $$
DECLARE
    v_user RECORD;
BEGIN
    -- 1. Validate User
    SELECT * INTO v_user FROM users WHERE email = p_email;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Account not found');
    END IF;

    -- 2. Verify Reset Status
    IF v_user.reset_request IS NULL OR v_user.reset_request->>'status' IS DISTINCT FROM 'approved' THEN
        RETURN jsonb_build_object('success', false, 'message', 'No approved password reset found for this account.');
    END IF;

    -- 3. Update User Table: Clear reset_request and set session
    UPDATE users SET
        reset_request = NULL,
        last_login = NOW(),
        failed_attempts = 0,
        locked_until = NULL,
        metadata = COALESCE(metadata, '{}'::jsonb) || '{"last_invalidation_reason": "password_change_finalized"}'::jsonb
    WHERE email = p_email;

    -- 4. Update/Create Secret: Set new password and clear reset_data
    INSERT INTO user_secrets (email, password_hash, session_id, reset_data)
    VALUES (p_email, p_new_password_hash, p_session_id, NULL)
    ON CONFLICT (email) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        session_id = EXCLUDED.session_id,
        reset_data = NULL,
        updated_at = NOW();

    -- 5. Create Success Notification
    PERFORM notify_user(p_email, 'Password Updated', 'Your password has been successfully reset and finalized.', null, 'password_updated');

    RETURN jsonb_build_object('success', true, 'message', 'Password successfully reset. Please login with your new credentials.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Secure Secret Update RPC
CREATE OR REPLACE FUNCTION update_user_secret_secure(
    p_email VARCHAR,
    p_password_hash VARCHAR DEFAULT NULL,
    p_session_id VARCHAR DEFAULT NULL,
    p_reset_data JSONB DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    -- Validation
    IF p_password_hash IS NOT NULL AND length(p_password_hash) < 8 THEN
        RAISE EXCEPTION 'Invalid password hash length';
    END IF;

    -- Check permissions: User can only update own secret unless admin
    -- Uses get_auth_email_raw() to allow password updates during gateway window
    IF NOT (is_admin() OR get_auth_email_raw() = p_email) THEN
        RAISE EXCEPTION 'Unauthorized to update secrets for this user.';
    END IF;

    -- Use UPSERT to handle cases where secret record might be missing during migration/update
    INSERT INTO user_secrets (email, password_hash, session_id, reset_data)
    VALUES (p_email, COALESCE(p_password_hash, 'MIGRATION_PENDING'), p_session_id, p_reset_data)
    ON CONFLICT (email) DO UPDATE SET
        password_hash = CASE WHEN p_password_hash IS NOT NULL THEN EXCLUDED.password_hash ELSE user_secrets.password_hash END,
        session_id = CASE WHEN p_session_id IS NOT NULL THEN EXCLUDED.session_id ELSE user_secrets.session_id END,
        -- reset_data relocation logic: If EXCLUDED.reset_data is provided, it replaces.
        -- To CLEAR reset_data, we must pass a specific object or have an explicit p_clear_reset flag.
        -- For this project, if p_reset_data is provided as an EMPTY object, we consider it a clear request.
        reset_data = CASE
            WHEN p_reset_data IS NOT NULL THEN (CASE WHEN p_reset_data = '{}'::jsonb THEN NULL ELSE EXCLUDED.reset_data END)
            ELSE user_secrets.reset_data
        END,
        updated_at = NOW();

END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_current_session_id()
RETURNS VARCHAR AS $$
DECLARE
    v_session_id VARCHAR;
    v_email VARCHAR;
BEGIN
    v_email := get_auth_email();
    IF v_email IS NULL THEN RETURN NULL; END IF;

    SELECT session_id INTO v_session_id FROM user_secrets WHERE email = v_email;
    RETURN v_session_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_user_secure(p_email VARCHAR)
RETURNS JSONB AS $$
DECLARE
    v_user RECORD;
    v_session_id VARCHAR;
    v_reset_data JSONB;
    v_has_secret BOOLEAN;
BEGIN
    SELECT * INTO v_user FROM users WHERE email = p_email;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT EXISTS (SELECT 1 FROM user_secrets WHERE email = p_email) INTO v_has_secret;

    -- Only include session_id and reset_data if requester is admin or the user themselves
    -- Uses get_auth_email_raw() to allow self-profile access during gateway window
    IF (is_admin() OR get_auth_email_raw() = p_email) THEN
        SELECT session_id, reset_data INTO v_session_id, v_reset_data FROM user_secrets WHERE email = p_email;
    END IF;

    RETURN to_jsonb(v_user) || jsonb_build_object(
        'session_id', v_session_id,
        'reset_data', v_reset_data,
        'has_secret', v_has_secret
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_server_time()
RETURNS TIMESTAMP WITH TIME ZONE AS $$
  SELECT NOW();
$$ LANGUAGE sql STABLE;

-- Public Certificate Verification RPC
-- Returns public metadata for a certificate by verification_id or UUID
-- SECURITY DEFINER allows unauthenticated users to verify certificates
CREATE OR REPLACE FUNCTION verify_certificate(p_verification_id TEXT)
RETURNS JSONB AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'student_name', u.full_name,
    'course_title', COALESCE(c.title, cert.metadata->>'course_title', CASE WHEN cert.type = 'consolidated' THEN 'All Enrolled Courses' ELSE 'Course Certificate' END),
    'issued_at', cert.issued_at,
    'verification_id', COALESCE(cert.metadata->>'verification_id', cert.id::text),
    'type', cert.type,
    'status', cert.status,
    'certificate_url', CASE WHEN cert.status = 'approved' THEN cert.certificate_url ELSE NULL END
  ) INTO v_result
  FROM certificates cert
  LEFT JOIN users u ON cert.student_email = u.email
  LEFT JOIN courses c ON cert.course_id = c.id
  WHERE (LOWER(cert.metadata->>'verification_id') = LOWER(p_verification_id)
     OR (CASE WHEN p_verification_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN cert.id = p_verification_id::uuid
              ELSE false END))
    AND cert.status = 'approved'
  LIMIT 1;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Secure RPC for password reset request (unauthenticated)
CREATE OR REPLACE FUNCTION request_password_reset_secure(
    p_email VARCHAR,
    p_reason TEXT,
    p_custom_reason TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_user RECORD;
BEGIN
    SELECT * INTO v_user FROM users WHERE email = p_email;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Account not found');
    END IF;

    IF NOT v_user.active THEN
        RETURN jsonb_build_object('success', false, 'message', 'Account deactivated');
    END IF;

    IF v_user.flagged THEN
        RETURN jsonb_build_object('success', false, 'message', 'Account flagged');
    END IF;

    IF v_user.locked_until IS NOT NULL AND v_user.locked_until > NOW() THEN
        RETURN jsonb_build_object('success', false, 'message', 'Account locked until ' || v_user.locked_until);
    END IF;

    -- Check for existing pending/approved reset
    IF v_user.reset_request IS NOT NULL AND
       (v_user.reset_request->>'expires_at' IS NULL OR (v_user.reset_request->>'expires_at')::TIMESTAMP WITH TIME ZONE > NOW()) THEN

        IF v_user.reset_request->>'status' = 'pending' THEN
            RETURN jsonb_build_object('success', false, 'message', 'Reset request already pending review.');
        ELSIF v_user.reset_request->>'status' = 'approved' THEN
            -- Fetch temp_password_plain from user_secrets
            DECLARE
                v_temp_plain TEXT;
            BEGIN
                SELECT reset_data->>'temp_password_plain' INTO v_temp_plain FROM user_secrets WHERE email = p_email;
                RETURN jsonb_build_object(
                    'success', false,
                    'message', 'This account has an approved password reset. Please use the temporary password provided by your administrator to login.',
                    'temp_password', COALESCE(v_temp_plain, '[Contact Admin]')
                );
            END;
        END IF;
    END IF;

    -- Update User
    UPDATE users SET reset_request = jsonb_build_object(
        'status', 'pending',
        'reason', p_reason,
        'custom_reason', p_custom_reason,
        'temp_password', null,
        'created_at', NOW(),
        'expires_at', null,
        'denial_reason', null
    ) WHERE email = p_email;

    -- Create Notification
    PERFORM notify_user(p_email, 'Reset Requested', 'Password reset requested and pending admin review.', null, 'reset_requested');

    RETURN jsonb_build_object('success', true, 'message', 'Password reset request submitted.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7b. Quiz Authoritative Logic RPCs

-- Helper for centralized scoring
CREATE OR REPLACE FUNCTION calculate_quiz_score(p_quiz_id UUID, p_answers JSONB)
RETURNS RECORD AS $$
DECLARE
    v_quiz RECORD;
    v_score INTEGER := 0;
    v_total_points INTEGER := 0;
    v_q JSONB;
    v_idx INTEGER := 0;
    v_student_answer TEXT;
    v_correct_answer TEXT;
    v_result RECORD;
BEGIN
    SELECT * INTO v_quiz FROM quizzes WHERE id = p_quiz_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    FOR v_q IN SELECT * FROM jsonb_array_elements(v_quiz.questions)
    LOOP
        v_total_points := v_total_points + (v_q->>'points')::INTEGER;
        v_student_answer := p_answers->>(v_idx::TEXT);
        v_correct_answer := v_q->>'correct';

        IF v_student_answer IS NOT NULL AND
           trim(lower(v_student_answer)) = trim(lower(v_correct_answer)) THEN
            v_score := v_score + (v_q->>'points')::INTEGER;
        END IF;

        v_idx := v_idx + 1;
    END LOOP;

    SELECT
        CASE WHEN v_total_points > 0 THEN ROUND((v_score::FLOAT / v_total_points::FLOAT) * 100) ELSE 0 END as score,
        v_total_points as total_points
    INTO v_result;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

-- RPC for reconciling expired attempts
-- Optimized to identification and finalize only strictly expired attempts using set-based logic
CREATE OR REPLACE FUNCTION reconcile_quiz_attempts(p_quiz_id UUID DEFAULT NULL, p_student_email VARCHAR DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    v_sub RECORD;
    v_score_data RECORD;
BEGIN
    FOR v_sub IN
        SELECT qs.id, qs.quiz_id, qs.answers, qs.started_at,
               LEAST(
                   COALESCE(qs.started_at + (q.time_limit * INTERVAL '1 minute'), 'infinity'::timestamp with time zone),
                   COALESCE(q.end_at, 'infinity'::timestamp with time zone)
               ) as deadline
        FROM quiz_submissions qs
        JOIN quizzes q ON qs.quiz_id = q.id
        WHERE qs.status = 'in-progress'
        AND (p_quiz_id IS NULL OR qs.quiz_id = p_quiz_id)
        AND (p_student_email IS NULL OR qs.student_email = p_student_email)
        -- Strictly target only expired records (with 1 min grace)
        AND NOW() > (LEAST(
            COALESCE(qs.started_at + (q.time_limit * INTERVAL '1 minute'), 'infinity'::timestamp with time zone),
            COALESCE(q.end_at, 'infinity'::timestamp with time zone)
        ) + INTERVAL '1 minute')
    LOOP
        v_score_data := calculate_quiz_score(v_sub.quiz_id, v_sub.answers);

        UPDATE quiz_submissions SET
            status = 'submitted',
            score = v_score_data.score,
            total_points = v_score_data.total_points,
            submitted_at = v_sub.deadline, -- Cap submission time to deadline for fairness
            time_spent = EXTRACT(EPOCH FROM (v_sub.deadline - v_sub.started_at))::INTEGER,
            updated_at = NOW()
        WHERE id = v_sub.id;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION start_quiz_attempt(p_quiz_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_student_email VARCHAR;
    v_quiz RECORD;
    v_attempt RECORD;
    v_attempts_used INTEGER;
    v_course_status VARCHAR;
BEGIN
    v_student_email := get_auth_email();
    IF v_student_email IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- 0. Reconcile any expired attempt for this specific user/quiz first
    PERFORM reconcile_quiz_attempts(p_quiz_id, v_student_email);

    SELECT q.*, c.status as course_status
    INTO v_quiz
    FROM quizzes q
    JOIN courses c ON q.course_id = c.id
    WHERE q.id = p_quiz_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Quiz not found';
    END IF;

    IF v_quiz.status != 'published' OR v_quiz.course_status != 'published' THEN
        RAISE EXCEPTION 'This quiz is not available yet.';
    END IF;

    -- 1. Check for existing in-progress attempt (might still be one if it hasn't expired)
    SELECT * INTO v_attempt FROM quiz_submissions
    WHERE quiz_id = p_quiz_id AND student_email = v_student_email AND status = 'in-progress';

    IF FOUND THEN
        RETURN to_jsonb(v_attempt);
    END IF;

    -- 2. Validate limits for new attempt
    SELECT COUNT(*) INTO v_attempts_used
    FROM quiz_submissions
    WHERE quiz_id = p_quiz_id AND student_email = v_student_email;

    IF v_quiz.attempts_allowed IS NOT NULL AND v_attempts_used >= v_quiz.attempts_allowed THEN
        RAISE EXCEPTION 'You have reached the maximum number of attempts allowed for this quiz.';
    END IF;

    -- 3. Create new attempt
    INSERT INTO quiz_submissions (quiz_id, student_email, status, answers, started_at)
    VALUES (p_quiz_id, v_student_email, 'in-progress', '{}'::jsonb, NOW())
    RETURNING * INTO v_attempt;

    RETURN to_jsonb(v_attempt);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION submit_quiz_attempt(
    p_submission_id UUID,
    p_answers JSONB,
    p_time_spent INTEGER
)
RETURNS JSONB AS $$
DECLARE
    v_student_email VARCHAR;
    v_attempt RECORD;
    v_quiz RECORD;
    v_score_data RECORD;
    v_deadline TIMESTAMP WITH TIME ZONE;
    v_final_submitted_at TIMESTAMP WITH TIME ZONE := NOW();
    v_final_time_spent INTEGER := p_time_spent;
    v_course_status VARCHAR;
BEGIN
    v_student_email := get_auth_email();

    SELECT * INTO v_attempt FROM quiz_submissions WHERE id = p_submission_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found'; END IF;

    -- Security: Ensure ownership
    IF v_attempt.student_email != v_student_email THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    IF v_attempt.status = 'submitted' THEN
        RETURN to_jsonb(v_attempt);
    END IF;

    SELECT q.*, c.status as course_status
    INTO v_quiz
    FROM quizzes q
    JOIN courses c ON q.course_id = c.id
    WHERE q.id = v_attempt.quiz_id;

    IF v_quiz.status != 'published' OR v_quiz.course_status != 'published' THEN
        RAISE EXCEPTION 'This quiz is no longer available.';
    END IF;

    -- Authoritative timing check for manual submission
    v_deadline := LEAST(
        COALESCE(v_attempt.started_at + (v_quiz.time_limit * INTERVAL '1 minute'), 'infinity'::timestamp with time zone),
        COALESCE(v_quiz.end_at, 'infinity'::timestamp with time zone)
    );

    -- If late, cap the data to deadline
    IF NOW() > (v_deadline + INTERVAL '5 minutes') THEN
        v_final_submitted_at := v_deadline;
        v_final_time_spent := EXTRACT(EPOCH FROM (v_deadline - v_attempt.started_at))::INTEGER;
    END IF;

    v_score_data := calculate_quiz_score(v_attempt.quiz_id, p_answers);

    -- Final update
    UPDATE quiz_submissions SET
        answers = p_answers,
        score = v_score_data.score,
        total_points = v_score_data.total_points,
        status = 'submitted',
        time_spent = v_final_time_spent,
        submitted_at = v_final_submitted_at
    WHERE id = p_submission_id
    RETURNING * INTO v_attempt;

    RETURN to_jsonb(v_attempt);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Periodic Purge Function
CREATE OR REPLACE FUNCTION purge_expired_records()
RETURNS TRIGGER AS $$
DECLARE
  v_expired_cutoff TIMESTAMP WITH TIME ZONE := (NOW() - INTERVAL '90 days');
  v_alerted_ids JSONB;
  v_cleared_broadcasts JSONB;
  v_read_broadcasts JSONB;
  v_user_email VARCHAR;
BEGIN
    -- Bypass cleanup during migration mode
    IF _is_migration_mode() THEN
        RETURN NULL;
    END IF;

    DELETE FROM broadcasts WHERE expires_at < NOW();
    -- Hard limit: Delete all notifications older than 90 days
    DELETE FROM notifications WHERE created_at < v_expired_cutoff;
    -- Soft limit: Delete read notifications older than 30 days
    DELETE FROM notifications WHERE created_at < (NOW() - INTERVAL '30 days') AND is_read = TRUE;
    DELETE FROM violations WHERE expires_at < NOW();

    -- Maintenance: Prune old tracking IDs from user metadata to prevent bloat
    -- We keep entries that still exist in the database (which are already pruned to 90 days)
    v_user_email := get_auth_email_raw();

    IF v_user_email IS NOT NULL THEN
        v_alerted_ids := (
            SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
            FROM users, jsonb_array_elements_text(metadata->'alerted_ids') elem
            WHERE email = v_user_email AND elem::uuid IN (SELECT id FROM notifications UNION SELECT id FROM broadcasts)
        );

        v_cleared_broadcasts := (
            SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
            FROM users, jsonb_array_elements_text(metadata->'cleared_broadcasts') elem
            WHERE email = v_user_email AND elem::uuid IN (SELECT id FROM broadcasts)
        );

        v_read_broadcasts := (
            SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
            FROM users, jsonb_array_elements_text(metadata->'read_broadcasts') elem
            WHERE email = v_user_email AND elem::uuid IN (SELECT id FROM broadcasts)
        );

        -- Final safety: ensure we never nullify metadata via builder if queries return no rows (though subqueries with COALESCE handle this)
        v_alerted_ids := COALESCE(v_alerted_ids, '[]'::jsonb);
        v_cleared_broadcasts := COALESCE(v_cleared_broadcasts, '[]'::jsonb);
        v_read_broadcasts := COALESCE(v_read_broadcasts, '[]'::jsonb);

        UPDATE users
        SET metadata = metadata || jsonb_build_object(
            'alerted_ids', v_alerted_ids,
            'cleared_broadcasts', v_cleared_broadcasts,
            'read_broadcasts', v_read_broadcasts
        )
        WHERE email = v_user_email
        AND (metadata ? 'alerted_ids' OR metadata ? 'cleared_broadcasts' OR metadata ? 'read_broadcasts');
    END IF;

    -- Automatically clear expired password reset requests (24h window)
    UPDATE users
    SET reset_request = NULL
    WHERE reset_request IS NOT NULL
    AND reset_request->>'expires_at' IS NOT NULL
    AND (reset_request->>'expires_at')::TIMESTAMP WITH TIME ZONE < NOW();

    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach purge trigger to high-frequency tables
DROP TRIGGER IF EXISTS tr_purge_broadcasts ON broadcasts;
CREATE TRIGGER tr_purge_broadcasts AFTER INSERT ON broadcasts FOR EACH STATEMENT EXECUTE PROCEDURE purge_expired_records();

DROP TRIGGER IF EXISTS tr_purge_notifications ON notifications;
CREATE TRIGGER tr_purge_notifications AFTER INSERT ON notifications FOR EACH STATEMENT EXECUTE PROCEDURE purge_expired_records();

DROP TRIGGER IF EXISTS tr_purge_violations ON violations;
CREATE TRIGGER tr_purge_violations AFTER INSERT ON violations FOR EACH STATEMENT EXECUTE PROCEDURE purge_expired_records();


CREATE OR REPLACE FUNCTION enroll_in_course(p_course_id UUID, p_student_email VARCHAR, p_enrollment_id VARCHAR DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
  v_actual_enrollment_id VARCHAR;
  v_course_status VARCHAR;
BEGIN
  SELECT enrollment_id, status INTO v_actual_enrollment_id, v_course_status FROM courses WHERE id = p_course_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Course not found.';
  END IF;

  IF v_course_status != 'published' THEN
    RAISE EXCEPTION 'Cannot enroll in a course that is not published.';
  END IF;

  IF v_actual_enrollment_id IS NOT NULL AND (p_enrollment_id IS NULL OR v_actual_enrollment_id != p_enrollment_id) THEN
    RAISE EXCEPTION 'Invalid Enrollment ID';
  END IF;

  INSERT INTO enrollments (course_id, student_email)
  VALUES (p_course_id, p_student_email)
  ON CONFLICT (course_id, student_email) DO NOTHING;
END;
$$ LANGUAGE plpgsql;


-- Deprecated: Use create_broadcast instead
CREATE OR REPLACE FUNCTION broadcast_data(n_course_id UUID, n_role VARCHAR, n_title TEXT, n_msg TEXT, n_link TEXT DEFAULT NULL, n_type TEXT DEFAULT 'system', n_expires_in INTERVAL DEFAULT INTERVAL '30 days')
RETURNS VOID AS $$
BEGIN
  PERFORM create_broadcast(n_course_id, n_role, n_title, n_msg, n_link, n_type, n_expires_in);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 8. Seed Data

INSERT INTO maintenance (id, enabled, schedules)
SELECT '00000000-0000-0000-0000-000000000000', false, '[]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM maintenance);

-- 9. Permissions & RLS

-- SECURE DEFAULT: Enable RLS on all tables
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name IN ('users', 'user_secrets', 'courses', 'topics', 'lessons', 'enrollments', 'assignments', 'submissions', 'live_classes', 'attendance', 'quizzes', 'quiz_submissions', 'materials', 'discussions', 'notifications', 'broadcasts', 'maintenance', 'planner', 'certificates', 'study_sessions', 'invites', 'violations', 'support_tickets')
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;

-- RLS POLICIES

-- 0. User Secrets (Strictly restricted)
-- 0. User Secrets
DROP POLICY IF EXISTS "Secrets: No Public Access" ON user_secrets;
DROP POLICY IF EXISTS "Secrets: Admin Manage" ON user_secrets;
CREATE POLICY "Secrets: No Public Access" ON user_secrets FOR ALL USING (false);
CREATE POLICY "Secrets: Admin Manage" ON user_secrets FOR ALL USING (is_admin());

-- 1. Users Table
DROP POLICY IF EXISTS "Users: Select" ON users;
CREATE POLICY "Users: Select" ON users FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users: Update" ON users;
CREATE POLICY "Users: Update" ON users FOR UPDATE USING (email = get_auth_email_raw() OR is_admin());
DROP POLICY IF EXISTS "Users: No Direct Insert" ON users;
DROP POLICY IF EXISTS "Users: Admin Manage" ON users;
CREATE POLICY "Users: Admin Manage" ON users FOR ALL USING (is_admin());
DROP POLICY IF EXISTS "Users: Admin Delete" ON users;

-- 2. Courses Table
DROP POLICY IF EXISTS "Courses: Select" ON courses;
CREATE POLICY "Courses: Select" ON courses FOR SELECT USING (status = 'published' OR teacher_email = get_auth_email() OR is_admin());
DROP POLICY IF EXISTS "Courses: Teachers Manage" ON courses;
CREATE POLICY "Courses: Teachers Manage" ON courses FOR ALL USING (teacher_email = get_auth_email() OR is_admin());

-- 3. Topics Table
DROP POLICY IF EXISTS "Topics: Select" ON topics;
CREATE POLICY "Topics: Select" ON topics FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = topics.course_id AND student_email = get_auth_email()) AND
   EXISTS (SELECT 1 FROM courses WHERE id = topics.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Topics: Teachers Manage" ON topics;
CREATE POLICY "Topics: Teachers Manage" ON topics FOR ALL USING (
  is_admin() OR teacher_email = get_auth_email()
);

-- 4. Lessons Table
DROP POLICY IF EXISTS "Lessons: Select" ON lessons;
CREATE POLICY "Lessons: Select" ON lessons FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = lessons.course_id AND student_email = get_auth_email()) AND
   EXISTS (SELECT 1 FROM courses WHERE id = lessons.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Lessons: Teachers Manage" ON lessons;
CREATE POLICY "Lessons: Teachers Manage" ON lessons FOR ALL USING (
  is_admin() OR teacher_email = get_auth_email()
);

-- 4. Enrollments Table
DROP POLICY IF EXISTS "Enrollments: User Access" ON enrollments;
CREATE POLICY "Enrollments: User Access" ON enrollments FOR SELECT USING (
  is_admin() OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = enrollments.course_id AND status = 'published')) OR
  (is_teacher() AND EXISTS (SELECT 1 FROM courses WHERE id = enrollments.course_id AND teacher_email = get_auth_email()))
);
DROP POLICY IF EXISTS "Enrollments: Self Enroll" ON enrollments;
CREATE POLICY "Enrollments: Self Enroll" ON enrollments FOR INSERT WITH CHECK (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = course_id AND status = 'published'));
DROP POLICY IF EXISTS "Enrollments: Manage for Admins" ON enrollments;
CREATE POLICY "Enrollments: Manage for Admins" ON enrollments FOR ALL USING (is_admin());
DROP POLICY IF EXISTS "Enrollments: Student Update Progress" ON enrollments;
CREATE POLICY "Enrollments: Student Update Progress" ON enrollments FOR UPDATE USING (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = course_id AND status = 'published')) WITH CHECK (student_email = get_auth_email());
DROP POLICY IF EXISTS "Enrollments: Teachers Delete" ON enrollments;
CREATE POLICY "Enrollments: Teachers Delete" ON enrollments FOR DELETE USING (
  is_teacher() AND EXISTS (SELECT 1 FROM courses WHERE id = enrollments.course_id AND teacher_email = get_auth_email())
);

-- 5. Assignments Table
DROP POLICY IF EXISTS "Assignments: Select" ON assignments;
CREATE POLICY "Assignments: Select" ON assignments FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (status = 'published' AND EXISTS (SELECT 1 FROM courses WHERE id = assignments.course_id AND status = 'published') AND EXISTS (SELECT 1 FROM enrollments WHERE course_id = assignments.course_id AND student_email = get_auth_email()))
);
DROP POLICY IF EXISTS "Assignments: Teachers Manage" ON assignments;
CREATE POLICY "Assignments: Teachers Manage" ON assignments FOR ALL USING (
  is_admin() OR teacher_email = get_auth_email()
);

-- 6. Submissions Table
DROP POLICY IF EXISTS "Submissions: Select" ON submissions;
CREATE POLICY "Submissions: Select" ON submissions FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Submissions: Admin Manage" ON submissions;
CREATE POLICY "Submissions: Admin Manage" ON submissions FOR ALL USING (is_admin());

DROP POLICY IF EXISTS "Submissions: Insert" ON submissions;
CREATE POLICY "Submissions: Insert" ON submissions FOR INSERT WITH CHECK (
  student_email = get_auth_email() AND
  EXISTS (SELECT 1 FROM enrollments WHERE course_id = submissions.course_id AND student_email = get_auth_email()) AND
  EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND status = 'published') AND
  EXISTS (SELECT 1 FROM assignments WHERE id = submissions.assignment_id AND status = 'published')
);
DROP POLICY IF EXISTS "Submissions: Update" ON submissions;
CREATE POLICY "Submissions: Update" ON submissions FOR UPDATE USING (
  teacher_email = get_auth_email() OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Submissions: Teachers Delete" ON submissions;
CREATE POLICY "Submissions: Teachers Delete" ON submissions FOR DELETE USING (
  is_teacher() AND EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND teacher_email = get_auth_email())
);

-- 7. Live Classes Table
DROP POLICY IF EXISTS "Live Classes: Select" ON live_classes;
CREATE POLICY "Live Classes: Select" ON live_classes FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = live_classes.course_id AND student_email = get_auth_email()) AND EXISTS (SELECT 1 FROM courses WHERE id = live_classes.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Live Classes: Teachers Manage" ON live_classes;
CREATE POLICY "Live Classes: Teachers Manage" ON live_classes FOR ALL USING (
  is_admin() OR teacher_email = get_auth_email()
);

-- 8. Attendance Table
DROP POLICY IF EXISTS "Attendance: Access" ON attendance;
CREATE POLICY "Attendance: Access" ON attendance FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = attendance.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Attendance: Admin Manage" ON attendance;
CREATE POLICY "Attendance: Admin Manage" ON attendance FOR ALL USING (is_admin());

DROP POLICY IF EXISTS "Attendance: Insert" ON attendance;
CREATE POLICY "Attendance: Insert" ON attendance FOR INSERT WITH CHECK (
  student_email = get_auth_email() AND
  EXISTS (SELECT 1 FROM enrollments WHERE course_id = attendance.course_id AND student_email = get_auth_email()) AND
  EXISTS (SELECT 1 FROM courses WHERE id = attendance.course_id AND status = 'published')
);
DROP POLICY IF EXISTS "Attendance: Teachers Delete" ON attendance;
CREATE POLICY "Attendance: Teachers Delete" ON attendance FOR DELETE USING (
  is_teacher() AND EXISTS (SELECT 1 FROM courses WHERE id = attendance.course_id AND teacher_email = get_auth_email())
);

-- 9. Quizzes Table
DROP POLICY IF EXISTS "Quizzes: Select" ON quizzes;
CREATE POLICY "Quizzes: Select" ON quizzes FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (status = 'published' AND EXISTS (SELECT 1 FROM courses WHERE id = quizzes.course_id AND status = 'published') AND EXISTS (SELECT 1 FROM enrollments WHERE course_id = quizzes.course_id AND student_email = get_auth_email()))
);
DROP POLICY IF EXISTS "Quizzes: Teachers Manage" ON quizzes;
CREATE POLICY "Quizzes: Teachers Manage" ON quizzes FOR ALL USING (
  is_admin() OR teacher_email = get_auth_email()
);

-- 10. Quiz Submissions Table
DROP POLICY IF EXISTS "Quiz Submissions: Access" ON quiz_submissions;
CREATE POLICY "Quiz Submissions: Access" ON quiz_submissions FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = quiz_submissions.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Quiz Submissions: Admin Manage" ON quiz_submissions;
CREATE POLICY "Quiz Submissions: Admin Manage" ON quiz_submissions FOR ALL USING (is_admin());

DROP POLICY IF EXISTS "Quiz Submissions: Insert" ON quiz_submissions;
CREATE POLICY "Quiz Submissions: Insert" ON quiz_submissions FOR INSERT WITH CHECK (
  student_email = get_auth_email() AND
  EXISTS (SELECT 1 FROM enrollments WHERE course_id = quiz_submissions.course_id AND student_email = get_auth_email()) AND
  EXISTS (SELECT 1 FROM courses WHERE id = quiz_submissions.course_id AND status = 'published') AND
  EXISTS (SELECT 1 FROM quizzes WHERE id = quiz_submissions.quiz_id AND status = 'published')
);
DROP POLICY IF EXISTS "Quiz Submissions: Update" ON quiz_submissions;
CREATE POLICY "Quiz Submissions: Update" ON quiz_submissions FOR UPDATE USING (
  teacher_email = get_auth_email() OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = quiz_submissions.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Quiz Submissions: Teachers Delete" ON quiz_submissions;
CREATE POLICY "Quiz Submissions: Teachers Delete" ON quiz_submissions FOR DELETE USING (
  is_teacher() AND EXISTS (SELECT 1 FROM courses WHERE id = quiz_submissions.course_id AND teacher_email = get_auth_email())
);

-- 11. Materials Table
DROP POLICY IF EXISTS "Materials: Select" ON materials;
CREATE POLICY "Materials: Select" ON materials FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = materials.course_id AND student_email = get_auth_email()) AND EXISTS (SELECT 1 FROM courses WHERE id = materials.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Materials: Teachers Manage" ON materials;
CREATE POLICY "Materials: Teachers Manage" ON materials FOR ALL USING (
  is_admin() OR teacher_email = get_auth_email()
);

-- 12. Discussions Table
DROP POLICY IF EXISTS "Discussions: Select" ON discussions;
CREATE POLICY "Discussions: Select" ON discussions FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = discussions.course_id AND student_email = get_auth_email()) AND EXISTS (SELECT 1 FROM courses WHERE id = discussions.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Discussions: Insert" ON discussions;
CREATE POLICY "Discussions: Insert" ON discussions FOR INSERT WITH CHECK (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (user_email = get_auth_email() AND EXISTS (SELECT 1 FROM enrollments WHERE course_id = discussions.course_id AND student_email = get_auth_email()) AND EXISTS (SELECT 1 FROM courses WHERE id = discussions.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Discussions: Update" ON discussions;
CREATE POLICY "Discussions: Update" ON discussions FOR UPDATE USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (user_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = discussions.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Discussions: Delete" ON discussions;
CREATE POLICY "Discussions: Delete" ON discussions FOR DELETE USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (user_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = discussions.course_id AND status = 'published'))
);

-- 13. Notifications Table
DROP POLICY IF EXISTS "Notifications: User Access" ON notifications;
DROP POLICY IF EXISTS "Notifications: SELECT" ON notifications;
DROP POLICY IF EXISTS "Notifications: UPDATE" ON notifications;
DROP POLICY IF EXISTS "Notifications: DELETE" ON notifications;
DROP POLICY IF EXISTS "Notifications: Admin Manage" ON notifications;
CREATE POLICY "Notifications: SELECT" ON notifications FOR SELECT USING (is_admin() OR user_email = get_auth_email());
CREATE POLICY "Notifications: UPDATE" ON notifications FOR UPDATE USING (user_email = get_auth_email()) WITH CHECK (user_email = get_auth_email());
CREATE POLICY "Notifications: DELETE" ON notifications FOR DELETE USING (is_admin() OR user_email = get_auth_email());
CREATE POLICY "Notifications: Admin Manage" ON notifications FOR ALL USING (is_admin());

-- 14. Broadcasts Table
DROP POLICY IF EXISTS "Broadcasts: Access" ON broadcasts;
DROP POLICY IF EXISTS "Broadcasts: SELECT" ON broadcasts;
DROP POLICY IF EXISTS "Broadcasts: MANAGE" ON broadcasts;
CREATE POLICY "Broadcasts: SELECT" ON broadcasts FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (
    -- Role must match (or be 'all' / NULL)
    (target_role IS NULL OR target_role = get_auth_role()) AND (
      -- Global broadcast
      course_id IS NULL OR
      -- Course-specific broadcast: must be enrolled in a published course
      EXISTS (
        SELECT 1 FROM enrollments e
        JOIN courses c ON e.course_id = c.id
        WHERE e.course_id = broadcasts.course_id
        AND e.student_email = get_auth_email()
        AND c.status = 'published'
      )
    )
  )
);

CREATE POLICY "Broadcasts: MANAGE" ON broadcasts FOR ALL USING (is_admin() OR teacher_email = get_auth_email());

-- 15. Maintenance Table
DROP POLICY IF EXISTS "Maintenance: Select" ON maintenance;
CREATE POLICY "Maintenance: Select" ON maintenance FOR SELECT USING (true);
DROP POLICY IF EXISTS "Maintenance: Manage for Admins" ON maintenance;
CREATE POLICY "Maintenance: Manage for Admins" ON maintenance FOR ALL USING (is_admin());

-- 16. System Logs Table

-- 17. Violations Table
DROP POLICY IF EXISTS "Violations: User Access" ON violations;
CREATE POLICY "Violations: User Access" ON violations FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (user_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = violations.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Violations: Admin Manage" ON violations;
CREATE POLICY "Violations: Admin Manage" ON violations FOR ALL USING (is_admin());

DROP POLICY IF EXISTS "Violations: Insert" ON violations;
CREATE POLICY "Violations: Insert" ON violations FOR INSERT WITH CHECK (
  user_email = get_auth_email() AND
  EXISTS (SELECT 1 FROM enrollments WHERE course_id = violations.course_id AND student_email = get_auth_email()) AND
  EXISTS (SELECT 1 FROM courses WHERE id = violations.course_id AND status = 'published')
);
DROP POLICY IF EXISTS "Violations: Delete" ON violations;
CREATE POLICY "Violations: Delete" ON violations FOR DELETE USING (
  is_teacher() AND EXISTS (SELECT 1 FROM courses WHERE id = violations.course_id AND teacher_email = get_auth_email())
);

-- 18. Planner Table
DROP POLICY IF EXISTS "Planner: User Access" ON planner;
CREATE POLICY "Planner: User Access" ON planner FOR ALL USING (user_email = get_auth_email() OR is_admin());

-- 19. Study Sessions Table
DROP POLICY IF EXISTS "Study Sessions: User Access" ON study_sessions;
CREATE POLICY "Study Sessions: User Access" ON study_sessions FOR SELECT USING (
  is_admin() OR teacher_email = get_auth_email() OR (user_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = study_sessions.course_id AND status = 'published'))
);
DROP POLICY IF EXISTS "Study Sessions: Admin Manage" ON study_sessions;
CREATE POLICY "Study Sessions: Admin Manage" ON study_sessions FOR ALL USING (is_admin());

DROP POLICY IF EXISTS "Study Sessions: Insert" ON study_sessions;
CREATE POLICY "Study Sessions: Insert" ON study_sessions FOR INSERT WITH CHECK (
  user_email = get_auth_email() AND
  EXISTS (SELECT 1 FROM enrollments WHERE course_id = study_sessions.course_id AND student_email = get_auth_email()) AND
  EXISTS (SELECT 1 FROM courses WHERE id = study_sessions.course_id AND status = 'published')
);
DROP POLICY IF EXISTS "Study Sessions: Teachers Delete" ON study_sessions;
CREATE POLICY "Study Sessions: Teachers Delete" ON study_sessions FOR DELETE USING (
  is_teacher() AND EXISTS (SELECT 1 FROM courses WHERE id = study_sessions.course_id AND teacher_email = get_auth_email())
);

-- 20. Certificates Table
DROP POLICY IF EXISTS "Certificates: User Access" ON certificates;
CREATE POLICY "Certificates: User Access" ON certificates FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  student_email = get_auth_email()
);
DROP POLICY IF EXISTS "Certificates: Admin Manage" ON certificates;
CREATE POLICY "Certificates: Admin Manage" ON certificates FOR ALL USING (is_admin());
DROP POLICY IF EXISTS "Certificates: Teacher Issue" ON certificates;
CREATE POLICY "Certificates: Teacher Issue" ON certificates FOR INSERT WITH CHECK (
  is_teacher() AND teacher_email = get_auth_email()
);
DROP POLICY IF EXISTS "Certificates: Teachers Update" ON certificates;
CREATE POLICY "Certificates: Teachers Update" ON certificates FOR UPDATE USING (
  is_teacher() AND teacher_email = get_auth_email()
) WITH CHECK (
  is_teacher() AND teacher_email = get_auth_email()
);
DROP POLICY IF EXISTS "Certificates: Student Request" ON certificates;
CREATE POLICY "Certificates: Student Request" ON certificates FOR INSERT WITH CHECK (
  student_email = get_auth_email() AND status = 'requested'
);
DROP POLICY IF EXISTS "Certificates: Teachers Delete" ON certificates;
CREATE POLICY "Certificates: Teachers Delete" ON certificates FOR DELETE USING (
  is_teacher() AND teacher_email = get_auth_email()
);

-- 21. Invites Table
DROP POLICY IF EXISTS "Invites: Manage for Admins" ON invites;
CREATE POLICY "Invites: Manage for Admins" ON invites FOR ALL USING (is_admin());
DROP POLICY IF EXISTS "Invites: Select for Signup" ON invites;
CREATE POLICY "Invites: Select for Signup" ON invites FOR SELECT USING (true);

-- 22. Support Tickets Table
DROP POLICY IF EXISTS "Support Tickets: Authenticated Insert" ON support_tickets;
CREATE POLICY "Support Tickets: Authenticated Insert" ON support_tickets FOR INSERT WITH CHECK (get_auth_email() IS NOT NULL);
DROP POLICY IF EXISTS "Support Tickets: User/Admin Select" ON support_tickets;
CREATE POLICY "Support Tickets: User/Admin Select" ON support_tickets FOR SELECT USING (user_email = get_auth_email() OR is_admin());
DROP POLICY IF EXISTS "Support Tickets: Admin Update" ON support_tickets;
CREATE POLICY "Support Tickets: Admin Update" ON support_tickets FOR UPDATE USING (is_admin());
DROP POLICY IF EXISTS "Support Tickets: Admin Delete" ON support_tickets;
CREATE POLICY "Support Tickets: Admin Delete" ON support_tickets FOR DELETE USING (is_admin());
DROP POLICY IF EXISTS "Support Tickets: Admin Manage" ON support_tickets;
CREATE POLICY "Support Tickets: Admin Manage" ON support_tickets FOR ALL USING (is_admin());

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, postgres, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, postgres, service_role;

-- 10. Realtime Cleanup
DROP PUBLICATION IF EXISTS supabase_realtime;

-- 11. Storage Initialization
-- 11. Storage Initialization & Policies

INSERT INTO storage.buckets (id, name, public)
VALUES ('materials', 'materials', true), ('assignments', 'assignments', true), ('certificates', 'certificates', true)
ON CONFLICT (id) DO NOTHING;

-- Enable RLS on storage.objects
-- Enable RLS on storage.objects (Note: Must be owner or superuser)
-- ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 11.1 Materials Bucket Policies (Public Read, Teacher Manage)
DROP POLICY IF EXISTS "Materials: Public Read" ON storage.objects;
CREATE POLICY "Materials: Public Read" ON storage.objects FOR SELECT USING (bucket_id = 'materials');

DROP POLICY IF EXISTS "Materials: Teacher Manage" ON storage.objects;
CREATE POLICY "Materials: Teacher Manage" ON storage.objects FOR ALL USING (
    bucket_id = 'materials' AND (is_teacher() OR is_admin())
);

-- 11.2 Assignments Bucket Policies (Restricted Access)
DROP POLICY IF EXISTS "Assignments: Teacher Manage" ON storage.objects;
CREATE POLICY "Assignments: Teacher Manage" ON storage.objects FOR ALL USING (
    bucket_id = 'assignments' AND (is_teacher() OR is_admin())
);

DROP POLICY IF EXISTS "Assignments: Student View Templates" ON storage.objects;
CREATE POLICY "Assignments: Student View Templates" ON storage.objects FOR SELECT USING (
    bucket_id = 'assignments' AND (storage.foldername(name))[1] = 'templates'
);

DROP POLICY IF EXISTS "Assignments: Student View Own" ON storage.objects;
CREATE POLICY "Assignments: Student View Own" ON storage.objects FOR SELECT USING (
    bucket_id = 'assignments' AND
    (storage.foldername(name))[1] = 'submissions' AND
    (storage.foldername(name))[3] = get_auth_email()
);

DROP POLICY IF EXISTS "Assignments: Student Upload Own" ON storage.objects;
CREATE POLICY "Assignments: Student Upload Own" ON storage.objects FOR INSERT WITH CHECK (
    bucket_id = 'assignments' AND
    (storage.foldername(name))[1] = 'submissions' AND
    (storage.foldername(name))[3] = get_auth_email()
);

DROP POLICY IF EXISTS "Assignments: Student Delete Own" ON storage.objects;
CREATE POLICY "Assignments: Student Delete Own" ON storage.objects FOR DELETE USING (
    bucket_id = 'assignments' AND
    (storage.foldername(name))[1] = 'submissions' AND
    (storage.foldername(name))[3] = get_auth_email()
);

-- 11.3 Certificates Bucket Policies (Student Read Own, Admin/Teacher Manage)
DROP POLICY IF EXISTS "Certificates: Management" ON storage.objects;
CREATE POLICY "Certificates: Management" ON storage.objects FOR ALL USING (
    bucket_id = 'certificates' AND (is_teacher() OR is_admin())
);

DROP POLICY IF EXISTS "Certificates: Student Read Own" ON storage.objects;
CREATE POLICY "Certificates: Student Read Own" ON storage.objects FOR SELECT USING (
    bucket_id = 'certificates' AND (storage.foldername(name))[2] = get_auth_email()
);
