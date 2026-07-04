-- System settings table for global controls
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed global proctoring control
INSERT INTO system_settings (key, value)
VALUES ('proctoring_control', '{"status": "active"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Ensure RLS is enabled on system_settings
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

-- Policies for system_settings
DROP POLICY IF EXISTS "System Settings: Admin All" ON system_settings;
CREATE POLICY "System Settings: Admin All" ON system_settings FOR ALL USING (is_admin());

DROP POLICY IF EXISTS "System Settings: Public Select" ON system_settings;
CREATE POLICY "System Settings: Public Select" ON system_settings FOR SELECT USING (true);

-- Function to get active proctored sessions
-- Returns a list of sessions that have recently reported violations (including proctoring logs)
-- or have an in-progress quiz submission.
CREATE OR REPLACE FUNCTION get_active_proctored_sessions()
RETURNS TABLE (
    session_id VARCHAR,
    user_email VARCHAR,
    full_name VARCHAR,
    assessment_id UUID,
    assessment_title VARCHAR,
    assessment_type VARCHAR,
    started_at TIMESTAMP WITH TIME ZONE,
    last_activity TIMESTAMP WITH TIME ZONE,
    violation_count BIGINT,
    status TEXT
) AS $$
BEGIN
    RETURN QUERY
    WITH recent_activity AS (
        -- Get unique sessions with activity in the last 2 hours
        SELECT
            v.session_id,
            v.user_email,
            v.assessment_id,
            v.assessment_type,
            MAX(v.timestamp) as last_act,
            COUNT(*) FILTER (WHERE v.severity != 'INFO') as v_count
        FROM violations v
        WHERE v.timestamp > NOW() - INTERVAL '2 hours'
        GROUP BY v.session_id, v.user_email, v.assessment_id, v.assessment_type
    ),
    active_quizzes AS (
        SELECT
            qs.quiz_id as id,
            'quiz' as type,
            q.title,
            qs.student_email,
            qs.started_at,
            'In Progress' as q_status
        FROM quiz_submissions qs
        JOIN quizzes q ON qs.quiz_id = q.id
        WHERE qs.status = 'in-progress'
    ),
    active_assignments AS (
        -- For assignments, we only have records in submissions table if student saved draft.
        -- We'll also rely on recent violations to detect active assignment sessions.
        SELECT
            s.assignment_id as id,
            'assignment' as type,
            a.title,
            s.student_email,
            s.created_at as started_at,
            'In Progress' as a_status
        FROM submissions s
        JOIN assignments a ON s.assignment_id = a.id
        WHERE s.status = 'draft'
    )
    SELECT
        ra.session_id,
        ra.user_email,
        u.full_name,
        ra.assessment_id,
        COALESCE(aq.title, aa.title, 'Unknown Assessment') as assessment_title,
        ra.assessment_type::VARCHAR,
        COALESCE(aq.started_at, aa.started_at, ra.last_act - INTERVAL '1 minute') as started_at,
        ra.last_act as last_activity,
        ra.v_count as violation_count,
        CASE
            WHEN ra.v_count > 5 THEN 'Flagged'
            WHEN ra.v_count > 0 THEN 'Warning'
            ELSE 'Normal'
        END as status
    FROM recent_activity ra
    JOIN users u ON ra.user_email = u.email
    LEFT JOIN active_quizzes aq ON ra.assessment_id = aq.id AND ra.user_email = aq.student_email
    LEFT JOIN active_assignments aa ON ra.assessment_id = aa.id AND ra.user_email = aa.student_email
    ORDER BY ra.last_act DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Grant access to the function
GRANT EXECUTE ON FUNCTION get_active_proctored_sessions() TO authenticated, anon;

-- Update tr_violation_data_inherit to be more robust
CREATE OR REPLACE FUNCTION tr_inherit_course_data() RETURNS TRIGGER AS $$
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;

  -- 1. Populate assessment metadata if session_id is provided but assessment info is missing
  -- This helps in linking proctoring logs that might only have session_id initially
  IF NEW.session_id IS NOT NULL AND (NEW.assessment_id IS NULL OR NEW.assessment_type IS NULL) THEN
      SELECT assessment_id, assessment_type, course_id, teacher_email
      INTO NEW.assessment_id, NEW.assessment_type, NEW.course_id, NEW.teacher_email
      FROM violations
      WHERE session_id = NEW.session_id
      AND assessment_id IS NOT NULL
      LIMIT 1;
  END IF;

  -- 2. Populate course_id from parent assessments/classes if missing
  IF NEW.course_id IS NULL THEN
    IF TG_TABLE_NAME = 'submissions' THEN
      SELECT course_id INTO NEW.course_id FROM assignments WHERE id = NEW.assignment_id;
    ELSIF TG_TABLE_NAME = 'quiz_submissions' THEN
      SELECT course_id INTO NEW.course_id FROM quizzes WHERE id = NEW.quiz_id;
    ELSIF TG_TABLE_NAME = 'attendance' THEN
      SELECT course_id INTO NEW.course_id FROM live_classes WHERE id = NEW.live_class_id;
    ELSIF TG_TABLE_NAME = 'violations' THEN
      IF NEW.assessment_id IS NOT NULL THEN
          -- Try Quiz first
          IF NEW.assessment_type = 'quiz' THEN
              SELECT course_id INTO NEW.course_id FROM quizzes WHERE id = NEW.assessment_id;
          ELSIF NEW.assessment_type = 'assignment' THEN
              SELECT course_id INTO NEW.course_id FROM assignments WHERE id = NEW.assessment_id;
          ELSE
              -- Auto-detect
              SELECT course_id INTO NEW.course_id FROM quizzes WHERE id = NEW.assessment_id;
              IF NEW.course_id IS NULL THEN
                  SELECT course_id INTO NEW.course_id FROM assignments WHERE id = NEW.assessment_id;
              END IF;
          END IF;
      END IF;
    END IF;
  END IF;

  -- 3. Populate teacher_email from course if missing
  IF NEW.teacher_email IS NULL AND NEW.course_id IS NOT NULL THEN
    SELECT teacher_email INTO NEW.teacher_email FROM courses WHERE id = NEW.course_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
