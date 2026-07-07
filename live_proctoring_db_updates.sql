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
DROP FUNCTION IF EXISTS get_active_proctored_sessions() CASCADE;
CREATE OR REPLACE FUNCTION get_active_proctored_sessions()
RETURNS TABLE (
    attempt_id VARCHAR,
    user_email VARCHAR,
    full_name VARCHAR,
    assessment_id UUID,
    assessment_title VARCHAR,
    assessment_type VARCHAR,
    started_at TIMESTAMP WITH TIME ZONE,
    last_activity TIMESTAMP WITH TIME ZONE,
    violation_count BIGINT,
    status TEXT,
    is_online BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    WITH latest_violations AS (
        -- Get unique sessions with activity in the last 4 hours
        SELECT
            v.attempt_id,
            v.user_email,
            v.assessment_id,
            v.assessment_type,
            MAX(v.timestamp) as last_act,
            MIN(v.timestamp) as first_act,
            COUNT(*) FILTER (WHERE v.severity NOT IN ('INFO', 'LOW')) as high_v_count,
            COUNT(*) FILTER (WHERE v.severity != 'INFO') as total_v_count
        FROM violations v
        WHERE v.timestamp > NOW() - INTERVAL '4 hours'
        GROUP BY v.attempt_id, v.user_email, v.assessment_id, v.assessment_type
    )
    SELECT
        lv.attempt_id,
        lv.user_email,
        u.full_name,
        lv.assessment_id,
        COALESCE(q.title, a.title, 'Unknown Assessment') as assessment_title,
        lv.assessment_type::VARCHAR,
        lv.first_act as started_at,
        lv.last_act as last_activity,
        lv.total_v_count as violation_count,
        CASE
            WHEN lv.high_v_count > 0 OR lv.total_v_count > 10 THEN 'Flagged'
            WHEN lv.total_v_count > 0 THEN 'Warning'
            WHEN lv.last_act < NOW() - INTERVAL '5 minutes' THEN 'Idle'
            ELSE 'Active'
        END as status,
        (lv.last_act > NOW() - INTERVAL '2 minutes') as is_online
    FROM latest_violations lv
    JOIN users u ON lv.user_email = u.email
    LEFT JOIN quizzes q ON lv.assessment_id = q.id AND lv.assessment_type = 'quiz'
    LEFT JOIN assignments a ON lv.assessment_id = a.id AND lv.assessment_type = 'assignment'
    ORDER BY lv.last_act DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Grant access to the function
GRANT EXECUTE ON FUNCTION get_active_proctored_sessions() TO authenticated, anon;

-- Update tr_violation_data_inherit to be more robust
CREATE OR REPLACE FUNCTION tr_inherit_course_data() RETURNS TRIGGER AS $$
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;

  -- 1. Populate assessment metadata if attempt_id is provided but assessment info is missing
  -- This helps in linking proctoring logs that might only have attempt_id initially
  IF TG_TABLE_NAME = 'violations' THEN
    IF NEW.attempt_id IS NOT NULL AND (NEW.assessment_id IS NULL OR NEW.assessment_type IS NULL) THEN
        SELECT assessment_id, assessment_type, course_id, teacher_email
        INTO NEW.assessment_id, NEW.assessment_type, NEW.course_id, NEW.teacher_email
        FROM violations
        WHERE attempt_id = NEW.attempt_id
        AND assessment_id IS NOT NULL
        AND assessment_type IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 1;
    END IF;
  END IF;

  -- 2. Populate course_id from parent assessments/classes if missing
  IF NEW.course_id IS NULL THEN
    IF TG_TABLE_NAME = 'submissions' THEN
      SELECT course_id INTO NEW.course_id FROM assignments WHERE id = NEW.assignment_id;
    ELSIF TG_TABLE_NAME = 'quiz_submissions' THEN
      SELECT course_id INTO NEW.course_id FROM quizzes WHERE id = NEW.quiz_id;
    ELSIF TG_TABLE_NAME = 'attendance' THEN
      SELECT course_id INTO NEW.course_id FROM live_classes WHERE id = NEW.live_class_id;
    ELSIF TG_TABLE_NAME = 'lessons' THEN
      IF NEW.topic_id IS NOT NULL THEN
        SELECT course_id INTO NEW.course_id FROM topics WHERE id = NEW.topic_id;
      END IF;
    ELSIF TG_TABLE_NAME = 'discussions' THEN
      IF NEW.parent_id IS NOT NULL THEN
        SELECT course_id INTO NEW.course_id FROM discussions WHERE id = NEW.parent_id;
      END IF;
    ELSIF TG_TABLE_NAME = 'violations' THEN
      IF NEW.assessment_id IS NOT NULL THEN
          IF NEW.assessment_type = 'quiz' THEN
              SELECT course_id INTO NEW.course_id FROM quizzes WHERE id = NEW.assessment_id;
          ELSIF NEW.assessment_type = 'assignment' THEN
              SELECT course_id INTO NEW.course_id FROM assignments WHERE id = NEW.assessment_id;
          ELSE
              -- Auto-detect if type is missing but ID is present
              SELECT course_id, 'quiz'::VARCHAR INTO NEW.course_id, NEW.assessment_type FROM quizzes WHERE id = NEW.assessment_id;
              IF NEW.course_id IS NULL THEN
                  SELECT course_id, 'assignment'::VARCHAR INTO NEW.course_id, NEW.assessment_type FROM assignments WHERE id = NEW.assessment_id;
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
