-- Enterprise Grade Course Analytics Insights
-- Comprehensive audit and implementation of centralized course analytics with hardened security and correct logic

-- Clean up legacy user lockout trigger and function to centralize security in authenticate_user
DROP TRIGGER IF EXISTS tr_user_lockout_protection ON users;
DROP FUNCTION IF EXISTS tr_protect_user_lockout() CASCADE;

-- Ensure semester column exists in courses table
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'courses' AND column_name = 'semester') THEN
        ALTER TABLE courses ADD COLUMN semester VARCHAR(100);
    END IF;
END $$;

-- Internal helper to verify teacher ownership (not exposed as RPC)
-- This ensures all SECURITY DEFINER functions below are safe.
CREATE OR REPLACE FUNCTION _check_course_teacher(p_course_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM courses
        WHERE id = p_course_id
        AND (teacher_email = auth.email() OR teacher_email = get_auth_email_raw())
    ) OR EXISTS (
        SELECT 1 FROM users
        WHERE (email = auth.email() OR email = get_auth_email_raw()) AND role = 'admin'
    );
END;
$$;

-- 1. Course Level Performance Summary
CREATE OR REPLACE FUNCTION get_course_analytics_summary(p_teacher_email TEXT, p_course_id UUID DEFAULT NULL, p_semester TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
    v_caller_email TEXT := COALESCE(auth.email(), get_auth_email_raw());
BEGIN
    -- Authorization Check: Caller must be the requested teacher or an admin
    IF v_caller_email != p_teacher_email AND NOT EXISTS (SELECT 1 FROM users WHERE email = v_caller_email AND role = 'admin') THEN
        RAISE EXCEPTION 'Unauthorized: You can only view your own analytics summary.';
    END IF;

    -- If course_id is provided, verify ownership of that specific course too
    IF p_course_id IS NOT NULL AND NOT _check_course_teacher(p_course_id) THEN
        RAISE EXCEPTION 'Unauthorized: Access to this course is denied.';
    END IF;

    WITH course_stats AS (
        SELECT
            c.id,
            c.title,
            c.semester,
            (SELECT count(*) FROM enrollments e WHERE e.course_id = c.id) as total_students,
            (SELECT count(*) FROM assignments a WHERE a.course_id = c.id) as total_assignments,
            (SELECT count(*) FROM quizzes q WHERE q.course_id = c.id) as total_quizzes,
            COALESCE((
                SELECT ROUND(AVG(final_grade)::numeric, 1)
                FROM submissions s
                JOIN assignments a ON s.assignment_id = a.id
                WHERE a.course_id = c.id AND s.status = 'graded'
            ), 0) as avg_assignment_score,
            COALESCE((
                SELECT ROUND(AVG(score)::numeric, 1)
                FROM quiz_submissions qs
                JOIN quizzes q ON qs.quiz_id = q.id
                WHERE q.course_id = c.id AND qs.status = 'submitted'
            ), 0) as avg_quiz_score
        FROM courses c
        WHERE c.teacher_email = p_teacher_email
        AND (p_course_id IS NULL OR c.id = p_course_id)
        AND (p_semester IS NULL OR c.semester = p_semester)
    )
    SELECT jsonb_agg(t) INTO v_result FROM course_stats t;

    RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- 2. Student Performance Comparison
CREATE OR REPLACE FUNCTION get_student_performance_comparison(p_course_id UUID DEFAULT NULL, p_semester TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
    v_caller_email TEXT := COALESCE(auth.email(), get_auth_email_raw());
BEGIN
    -- Authorization Check
    IF p_course_id IS NOT NULL AND NOT _check_course_teacher(p_course_id) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    WITH student_metrics AS (
        SELECT
            u.full_name,
            u.email,
            c.title as course_title,
            ROUND(AVG(s.final_grade)::numeric, 1) as avg_assignment_grade,
            ROUND(AVG(qs.score)::numeric, 1) as avg_quiz_grade,
            ROUND(
                (CASE
                    WHEN AVG(s.final_grade) IS NOT NULL AND AVG(qs.score) IS NOT NULL THEN (AVG(s.final_grade) + AVG(qs.score)) / 2
                    ELSE COALESCE(AVG(s.final_grade), AVG(qs.score), 0)
                END)::numeric, 1
            ) as overall_average
        FROM enrollments e
        JOIN users u ON e.student_email = u.email
        JOIN courses c ON e.course_id = c.id
        LEFT JOIN assignments a ON a.course_id = c.id
        LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_email = u.email AND s.status = 'graded'
        LEFT JOIN quizzes q ON q.course_id = c.id
        LEFT JOIN quiz_submissions qs ON qs.quiz_id = q.id AND qs.student_email = u.email AND qs.status = 'submitted'
        WHERE (p_course_id IS NULL OR e.course_id = p_course_id)
        AND (p_semester IS NULL OR c.semester = p_semester)
        AND (p_course_id IS NOT NULL OR c.teacher_email = v_caller_email OR EXISTS (SELECT 1 FROM users WHERE email = v_caller_email AND role = 'admin'))
        GROUP BY u.email, u.full_name, c.title
    )
    SELECT jsonb_agg(t) INTO v_result FROM student_metrics t;

    RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- 3. Assessment Performance Analysis
CREATE OR REPLACE FUNCTION get_assessment_performance_analysis(p_course_id UUID DEFAULT NULL, p_semester TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
    v_caller_email TEXT := COALESCE(auth.email(), get_auth_email_raw());
BEGIN
    -- Authorization Check
    IF p_course_id IS NOT NULL AND NOT _check_course_teacher(p_course_id) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    WITH assignment_analysis AS (
        SELECT
            'assignment' as type,
            a.id,
            a.title,
            c.title as course_title,
            COALESCE(ROUND(AVG(s.final_grade)::numeric, 1), 0) as avg_score,
            COALESCE(MIN(s.final_grade), 0) as min_score,
            COALESCE(MAX(s.final_grade), 0) as max_score,
            COUNT(s.id) as submission_count,
            COALESCE(a.due_date, a.created_at) as sort_date
        FROM assignments a
        JOIN courses c ON a.course_id = c.id
        LEFT JOIN submissions s ON s.assignment_id = a.id AND s.status = 'graded'
        WHERE (p_course_id IS NULL OR a.course_id = p_course_id)
        AND (p_semester IS NULL OR c.semester = p_semester)
        AND (p_course_id IS NOT NULL OR c.teacher_email = v_caller_email OR EXISTS (SELECT 1 FROM users WHERE email = v_caller_email AND role = 'admin'))
        GROUP BY a.id, a.title, c.title, a.due_date, a.created_at
    ),
    quiz_analysis AS (
        SELECT
            'quiz' as type,
            q.id,
            q.title,
            c.title as course_title,
            COALESCE(ROUND(AVG(qs.score)::numeric, 1), 0) as avg_score,
            COALESCE(MIN(qs.score), 0) as min_score,
            COALESCE(MAX(qs.score), 0) as max_score,
            COUNT(qs.id) as submission_count,
            COALESCE(q.end_at, q.created_at) as sort_date
        FROM quizzes q
        JOIN courses c ON q.course_id = c.id
        LEFT JOIN quiz_submissions qs ON qs.quiz_id = q.id AND qs.status = 'submitted'
        WHERE (p_course_id IS NULL OR q.course_id = p_course_id)
        AND (p_semester IS NULL OR c.semester = p_semester)
        AND (p_course_id IS NOT NULL OR c.teacher_email = v_caller_email OR EXISTS (SELECT 1 FROM users WHERE email = v_caller_email AND role = 'admin'))
        GROUP BY q.id, q.title, c.title, q.end_at, q.created_at
    )
    SELECT jsonb_agg(t) INTO v_result FROM (
        SELECT * FROM assignment_analysis
        UNION ALL
        SELECT * FROM quiz_analysis
        ORDER BY sort_date ASC
    ) t;

    RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- 4. Learning Gaps and Intervention Insights
CREATE OR REPLACE FUNCTION get_learning_gaps_and_interventions(p_course_id UUID DEFAULT NULL, p_semester TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
    v_caller_email TEXT := COALESCE(auth.email(), get_auth_email_raw());
BEGIN
    -- Authorization Check
    IF p_course_id IS NOT NULL AND NOT _check_course_teacher(p_course_id) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    WITH student_scores AS (
        SELECT
            u.full_name,
            u.email,
            AVG(s.final_grade) as avg_assign,
            AVG(qs.score) as avg_quiz,
            CASE
                WHEN AVG(s.final_grade) IS NOT NULL AND AVG(qs.score) IS NOT NULL THEN (AVG(s.final_grade) + AVG(qs.score)) / 2
                ELSE COALESCE(AVG(s.final_grade), AVG(qs.score), 0)
            END as total_avg
        FROM enrollments e
        JOIN users u ON e.student_email = u.email
        JOIN courses c ON e.course_id = c.id
        LEFT JOIN assignments a ON a.course_id = c.id
        LEFT JOIN submissions s ON s.assignment_id = a.id AND s.status = 'graded' AND s.student_email = u.email
        LEFT JOIN quizzes q ON q.course_id = c.id
        LEFT JOIN quiz_submissions qs ON qs.quiz_id = q.id AND qs.status = 'submitted' AND qs.student_email = u.email
        WHERE (p_course_id IS NULL OR e.course_id = p_course_id)
        AND (p_semester IS NULL OR c.semester = p_semester)
        AND (p_course_id IS NOT NULL OR c.teacher_email = v_caller_email OR EXISTS (SELECT 1 FROM users WHERE email = v_caller_email AND role = 'admin'))
        GROUP BY u.email, u.full_name
    ),
    interventions AS (
        SELECT
            email,
            full_name,
            ROUND(total_avg::numeric, 1) as total_avg,
            CASE
                WHEN total_avg < 50 THEN 'CRITICAL'
                WHEN total_avg < 70 THEN 'AT_RISK'
                ELSE 'STABLE'
            END as risk_level
        FROM student_scores
        WHERE total_avg < 70
    )
    SELECT jsonb_build_object(
        'low_performing_students', COALESCE((SELECT jsonb_agg(i) FROM interventions i), '[]'::jsonb),
        'course_average', ROUND(COALESCE((SELECT AVG(total_avg) FROM student_scores), 0)::numeric, 1)
    ) INTO v_result;

    RETURN v_result;
END;
$$;

-- 5. Fetch Unique Semesters for Teacher
CREATE OR REPLACE FUNCTION get_teacher_semesters(p_teacher_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
    v_caller_email TEXT := COALESCE(auth.email(), get_auth_email_raw());
BEGIN
    -- Authorization Check
    IF v_caller_email != p_teacher_email AND NOT EXISTS (SELECT 1 FROM users WHERE email = v_caller_email AND role = 'admin') THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    SELECT jsonb_agg(t) INTO v_result FROM (
        SELECT DISTINCT c.semester
        FROM courses c
        WHERE c.teacher_email = p_teacher_email
        AND c.semester IS NOT NULL
        ORDER BY c.semester DESC
    ) t;

    RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- 6. Attendance Heatmap Data
CREATE OR REPLACE FUNCTION get_attendance_heatmap_data(p_teacher_email TEXT, p_course_id UUID DEFAULT NULL, p_semester TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
    v_caller_email TEXT := COALESCE(auth.email(), get_auth_email_raw());
BEGIN
    -- Authorization Check
    IF v_caller_email != p_teacher_email AND NOT EXISTS (SELECT 1 FROM users WHERE email = v_caller_email AND role = 'admin') THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    -- If course_id is provided, verify ownership
    IF p_course_id IS NOT NULL AND NOT _check_course_teacher(p_course_id) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    WITH daily_activity AS (
        -- Combine Attendance (Live Classes) and Study Sessions
        SELECT date_trunc('day', activity_time)::DATE as activity_date, count(*) as activity_count
        FROM (
            SELECT a.join_time as activity_time
            FROM attendance a
            JOIN courses c ON a.course_id = c.id
            WHERE c.teacher_email = p_teacher_email
            AND (p_course_id IS NULL OR c.id = p_course_id)
            AND (p_semester IS NULL OR c.semester = p_semester)

            UNION ALL

            SELECT s.started_at as activity_time
            FROM study_sessions s
            JOIN courses c ON s.course_id = c.id
            WHERE c.teacher_email = p_teacher_email
            AND (p_course_id IS NULL OR c.id = p_course_id)
            AND (p_semester IS NULL OR c.semester = p_semester)
        ) combined
        GROUP BY activity_date
    )
    SELECT jsonb_object_agg(activity_date, activity_count) INTO v_result FROM daily_activity;

    RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;
