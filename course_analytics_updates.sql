-- Enterprise Grade Course Analytics Insights
-- Comprehensive audit and implementation of centralized course analytics

-- 1. Course Level Performance Summary
CREATE OR REPLACE FUNCTION get_course_analytics_summary(p_teacher_email TEXT, p_course_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    -- Check if user is teacher or admin
    IF NOT EXISTS (SELECT 1 FROM users WHERE email = auth.email() AND role IN ('teacher', 'admin')) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    WITH course_stats AS (
        SELECT
            c.id,
            c.title,
            (SELECT count(*) FROM enrollments e WHERE e.course_id = c.id) as total_students,
            (SELECT count(*) FROM assignments a WHERE a.course_id = c.id) as total_assignments,
            (SELECT count(*) FROM quizzes q WHERE q.course_id = c.id) as total_quizzes,
            (
                SELECT AVG(final_grade)
                FROM submissions s
                JOIN assignments a ON s.assignment_id = a.id
                WHERE a.course_id = c.id AND s.status = 'graded'
            ) as avg_assignment_score,
            (
                SELECT AVG(score)
                FROM quiz_submissions qs
                JOIN quizzes q ON qs.quiz_id = q.id
                WHERE q.course_id = c.id AND qs.status = 'submitted'
            ) as avg_quiz_score
        FROM courses c
        WHERE c.teacher_email = p_teacher_email
        AND (p_course_id IS NULL OR c.id = p_course_id)
    )
    SELECT jsonb_agg(t) INTO v_result FROM course_stats t;

    RETURN v_result;
END;
$$;

-- 2. Student Performance Comparison
CREATE OR REPLACE FUNCTION get_student_performance_comparison(p_course_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    WITH student_metrics AS (
        SELECT
            u.full_name,
            u.email,
            AVG(COALESCE(s.final_grade, 0)) as avg_assignment_grade,
            AVG(COALESCE(qs.score, 0)) as avg_quiz_grade,
            (AVG(COALESCE(s.final_grade, 0)) + AVG(COALESCE(qs.score, 0))) / 2 as overall_average
        FROM enrollments e
        JOIN users u ON e.student_email = u.email
        LEFT JOIN assignments a ON a.course_id = p_course_id
        LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_email = u.email AND s.status = 'graded'
        LEFT JOIN quizzes q ON q.course_id = p_course_id
        LEFT JOIN quiz_submissions qs ON qs.quiz_id = q.id AND qs.student_email = u.email AND qs.status = 'submitted'
        WHERE e.course_id = p_course_id
        GROUP BY u.email, u.full_name
    )
    SELECT jsonb_agg(t) INTO v_result FROM student_metrics t;

    RETURN v_result;
END;
$$;

-- 3. Assessment Performance Analysis
CREATE OR REPLACE FUNCTION get_assessment_performance_analysis(p_course_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    WITH assignment_analysis AS (
        SELECT
            'assignment' as type,
            a.id,
            a.title,
            AVG(s.final_grade) as avg_score,
            MIN(s.final_grade) as min_score,
            MAX(s.final_grade) as max_score,
            COUNT(s.id) as submission_count
        FROM assignments a
        LEFT JOIN submissions s ON s.assignment_id = a.id AND s.status = 'graded'
        WHERE a.course_id = p_course_id
        GROUP BY a.id, a.title
    ),
    quiz_analysis AS (
        SELECT
            'quiz' as type,
            q.id,
            q.title,
            AVG(qs.score) as avg_score,
            MIN(qs.score) as min_score,
            MAX(qs.score) as max_score,
            COUNT(qs.id) as submission_count
        FROM quizzes q
        LEFT JOIN quiz_submissions qs ON qs.quiz_id = q.id AND qs.status = 'submitted'
        WHERE q.course_id = p_course_id
        GROUP BY q.id, q.title
    )
    SELECT jsonb_agg(t) INTO v_result FROM (
        SELECT * FROM assignment_analysis
        UNION ALL
        SELECT * FROM quiz_analysis
    ) t;

    RETURN v_result;
END;
$$;

-- 4, 5, 6, 7. Learning Gaps and Intervention Insights
CREATE OR REPLACE FUNCTION get_learning_gaps_and_interventions(p_course_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    WITH student_scores AS (
        SELECT
            u.full_name,
            u.email,
            COALESCE(AVG(s.final_grade), 0) as avg_assign,
            COALESCE(AVG(qs.score), 0) as avg_quiz,
            (COALESCE(AVG(s.final_grade), 0) + COALESCE(AVG(qs.score), 0)) / 2 as total_avg
        FROM enrollments e
        JOIN users u ON e.student_email = u.email
        LEFT JOIN assignments a ON a.course_id = p_course_id
        LEFT JOIN submissions s ON s.assignment_id = a.id AND s.status = 'graded' AND s.student_email = u.email
        LEFT JOIN quizzes q ON q.course_id = p_course_id
        LEFT JOIN quiz_submissions qs ON qs.quiz_id = q.id AND qs.status = 'submitted' AND qs.student_email = u.email
        WHERE e.course_id = p_course_id
        GROUP BY u.email, u.full_name
    ),
    interventions AS (
        SELECT
            email,
            full_name,
            total_avg,
            CASE
                WHEN total_avg < 50 THEN 'CRITICAL'
                WHEN total_avg < 70 THEN 'AT_RISK'
                ELSE 'STABLE'
            END as risk_level
        FROM student_scores
        WHERE total_avg < 70
    )
    SELECT jsonb_build_object(
        'low_performing_students', (SELECT jsonb_agg(i) FROM interventions i),
        'course_average', (SELECT AVG(total_avg) FROM student_scores)
    ) INTO v_result;

    RETURN v_result;
END;
$$;
