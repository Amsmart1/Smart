-- Ensure Violations table has the correct effort-linked attempt_id column
-- and remove the redundant session_id column.
ALTER TABLE violations DROP COLUMN IF EXISTS session_id CASCADE;
ALTER TABLE violations ADD COLUMN IF NOT EXISTS attempt_id UUID;

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
DROP FUNCTION IF EXISTS get_active_proctored_sessions(VARCHAR) CASCADE;
CREATE OR REPLACE FUNCTION get_active_proctored_sessions()
RETURNS TABLE (
    attempt_id UUID,
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
DECLARE
    v_sql TEXT;
    v_derived_teacher_email VARCHAR;
BEGIN
    -- Secure derivation: scope based on caller's identity
    IF is_admin() THEN
        v_derived_teacher_email := NULL;
    ELSE
        v_derived_teacher_email := get_auth_email();
        IF v_derived_teacher_email IS NULL THEN
            RETURN;
        END IF;
    END IF;

    -- Resilience: Ensure attempt_id column exists before trying to query it
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'violations' AND column_name = 'attempt_id') THEN
        RETURN;
    END IF;

    v_sql := '
    WITH latest_violations AS (
        -- Get unique attempts with activity in the last 4 hours
        SELECT
            v.attempt_id,
            v.user_email,
            v.assessment_id,
            v.assessment_type,
            MAX(v.timestamp) as last_act,
            MIN(v.timestamp) as first_act,
            COUNT(*) FILTER (WHERE v.severity NOT IN (''INFO'', ''LOW'')) as high_v_count,
            COUNT(*) FILTER (WHERE v.severity != ''INFO'') as total_v_count
        FROM violations v
        WHERE v.timestamp > NOW() - INTERVAL ''4 hours''';

    IF v_derived_teacher_email IS NOT NULL THEN
        v_sql := v_sql || ' AND v.teacher_email = $1';
    END IF;

    v_sql := v_sql || '
        GROUP BY v.attempt_id, v.user_email, v.assessment_id, v.assessment_type
    )
    SELECT
        lv.attempt_id,
        lv.user_email,
        u.full_name,
        lv.assessment_id,
        COALESCE(q.title, a.title, ''Unknown Assessment'') as assessment_title,
        lv.assessment_type::VARCHAR,
        lv.first_act as started_at,
        lv.last_act as last_activity,
        lv.total_v_count as violation_count,
        CASE
            WHEN lv.high_v_count > 0 OR lv.total_v_count > 10 THEN ''Flagged''
            WHEN lv.total_v_count > 0 THEN ''Warning''
            WHEN lv.last_act < NOW() - INTERVAL ''5 minutes'' THEN ''Idle''
            ELSE ''Active''
        END as status,
        (lv.last_act > NOW() - INTERVAL ''2 minutes'')::BOOLEAN as is_online
    FROM latest_violations lv
    JOIN users u ON lv.user_email = u.email
    LEFT JOIN quizzes q ON lv.assessment_id = q.id AND lv.assessment_type = ''quiz''
    LEFT JOIN assignments a ON lv.assessment_id = a.id AND lv.assessment_type = ''assignment''
    ORDER BY lv.last_act DESC';

    IF v_derived_teacher_email IS NOT NULL THEN
        RETURN QUERY EXECUTE v_sql USING v_derived_teacher_email;
    ELSE
        RETURN QUERY EXECUTE v_sql;
    END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Grant access to the function exclusively to authenticated users, revoking from anon/PUBLIC
-- Grant access to the function to authenticated and anon roles, revoking from PUBLIC
REVOKE ALL ON FUNCTION get_active_proctored_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_active_proctored_sessions() TO authenticated, anon;

-- Update tr_inherit_course_data to be more robust
CREATE OR REPLACE FUNCTION tr_inherit_course_data() RETURNS TRIGGER AS $$
DECLARE
  v_new_json JSONB;
  v_assessment_id UUID;
  v_assessment_type VARCHAR;
  v_course_id UUID;
  v_teacher_email VARCHAR(255);
BEGIN
  IF _is_migration_mode() THEN RETURN NEW; END IF;
  v_new_json := to_jsonb(NEW);

  v_course_id := (v_new_json->>'course_id')::UUID;
  v_teacher_email := (v_new_json->>'teacher_email')::VARCHAR;

  -- 1. Populate assessment metadata if attempt_id is provided but assessment info is missing
  -- Safety: Use JSONB to avoid "record has no field" errors on shared trigger function
  IF TG_TABLE_NAME = 'violations' THEN
      DECLARE
          v_attempt_id UUID := (v_new_json->>'attempt_id')::UUID;
      BEGIN
          IF v_attempt_id IS NOT NULL AND ( (v_new_json->>'assessment_id') IS NULL OR (v_new_json->>'assessment_type') IS NULL ) THEN
              SELECT assessment_id, assessment_type, course_id, teacher_email
              INTO v_assessment_id, v_assessment_type, v_course_id, v_teacher_email
              FROM violations
              WHERE attempt_id = v_attempt_id
              AND assessment_id IS NOT NULL
              AND assessment_type IS NOT NULL
              ORDER BY created_at ASC
              LIMIT 1;

              IF v_assessment_id IS NOT NULL THEN
                  v_new_json := v_new_json || jsonb_build_object(
                      'assessment_id', v_assessment_id,
                      'assessment_type', v_assessment_type,
                      'course_id', v_course_id,
                      'teacher_email', v_teacher_email
                  );
              END IF;
          END IF;
      END;
  END IF;

  -- 2. Populate course_id from parent assessments/classes if missing
  IF v_course_id IS NULL THEN
    IF TG_TABLE_NAME = 'submissions' THEN
      SELECT course_id INTO v_course_id FROM assignments WHERE id = (v_new_json->>'assignment_id')::UUID;
    ELSIF TG_TABLE_NAME = 'quiz_submissions' THEN
      SELECT course_id INTO v_course_id FROM quizzes WHERE id = (v_new_json->>'quiz_id')::UUID;
    ELSIF TG_TABLE_NAME = 'attendance' THEN
      SELECT course_id INTO v_course_id FROM live_classes WHERE id = (v_new_json->>'live_class_id')::UUID;
    ELSIF TG_TABLE_NAME = 'lessons' THEN
      IF (v_new_json->>'topic_id') IS NOT NULL THEN
        SELECT course_id INTO v_course_id FROM topics WHERE id = (v_new_json->>'topic_id')::UUID;
      END IF;
    ELSIF TG_TABLE_NAME = 'discussions' THEN
      IF (v_new_json->>'parent_id') IS NOT NULL THEN
        SELECT course_id, teacher_email INTO v_course_id, v_teacher_email FROM discussions WHERE id = (v_new_json->>'parent_id')::UUID;
      END IF;
    ELSIF TG_TABLE_NAME = 'violations' THEN
      v_assessment_id := (v_new_json->>'assessment_id')::UUID;
      v_assessment_type := (v_new_json->>'assessment_type')::VARCHAR;

      IF v_assessment_id IS NOT NULL THEN
          IF v_assessment_type = 'quiz' THEN
              SELECT course_id INTO v_course_id FROM quizzes WHERE id = v_assessment_id;
          ELSIF v_assessment_type = 'assignment' THEN
              SELECT course_id INTO v_course_id FROM assignments WHERE id = v_assessment_id;
          ELSE
              -- Auto-detect if type is missing but ID is present
              SELECT course_id, 'quiz'::VARCHAR INTO v_course_id, v_assessment_type FROM quizzes WHERE id = v_assessment_id;
              IF v_course_id IS NULL THEN
                  SELECT course_id, 'assignment'::VARCHAR INTO v_course_id, v_assessment_type FROM assignments WHERE id = v_assessment_id;
              END IF;
              v_new_json := v_new_json || jsonb_build_object('assessment_type', v_assessment_type);
          END IF;
      END IF;
    END IF;

    IF v_course_id IS NOT NULL THEN
        v_new_json := v_new_json || jsonb_build_object('course_id', v_course_id);
    END IF;
  END IF;

  -- 3. Populate teacher_email from course if missing
  IF v_teacher_email IS NULL AND v_course_id IS NOT NULL THEN
    SELECT teacher_email INTO v_teacher_email FROM courses WHERE id = v_course_id;
    v_new_json := v_new_json || jsonb_build_object('teacher_email', v_teacher_email);
  END IF;

  NEW := jsonb_populate_record(NEW, v_new_json);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Teacher INSERT policy on Violations table to allow live warning/termination messages
DROP POLICY IF EXISTS "Violations: Teacher Insert" ON violations;
CREATE POLICY "Violations: Teacher Insert" ON violations FOR INSERT WITH CHECK (
  is_teacher() AND (
    teacher_email = get_auth_email() OR
    EXISTS (SELECT 1 FROM courses WHERE id = violations.course_id AND teacher_email = get_auth_email())
  )
);
