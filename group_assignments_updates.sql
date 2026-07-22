-- Migration to support Group Assignments
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS assignment_type VARCHAR(50) DEFAULT 'individual' CHECK (assignment_type IN ('individual', 'group'));
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS groups JSONB DEFAULT '[]'::jsonb;

-- Update RLS policies on submissions to allow group members to submit on behalf of their group
DROP POLICY IF EXISTS "Submissions: Select" ON submissions;
CREATE POLICY "Submissions: Select" ON submissions FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND teacher_email = get_auth_email()) OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND status = 'published'))
);

DROP POLICY IF EXISTS "Submissions: Insert" ON submissions;
CREATE POLICY "Submissions: Insert" ON submissions FOR INSERT WITH CHECK (
  is_admin() OR
  (is_teacher() AND EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND teacher_email = get_auth_email())) OR
  ((student_email = get_auth_email() OR EXISTS (
    SELECT 1 FROM assignments a
    WHERE a.id = submissions.assignment_id
      AND a.assignment_type = 'group'
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(a.groups, '[]'::jsonb)) g
          WHERE (g->'members')::jsonb @> jsonb_build_array(get_auth_email())
            AND (g->'members')::jsonb @> jsonb_build_array(submissions.student_email)
      )
  )) AND
  EXISTS (SELECT 1 FROM enrollments WHERE course_id = submissions.course_id AND student_email = submissions.student_email) AND
  EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND status = 'published') AND
  EXISTS (SELECT 1 FROM assignments WHERE id = submissions.assignment_id AND status = 'published'))
);

DROP POLICY IF EXISTS "Submissions: Update" ON submissions;
CREATE POLICY "Submissions: Update" ON submissions FOR UPDATE USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND teacher_email = get_auth_email()) OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND status = 'published')) OR
  (EXISTS (
    SELECT 1 FROM assignments a
    WHERE a.id = submissions.assignment_id
      AND a.assignment_type = 'group'
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(a.groups, '[]'::jsonb)) g
          WHERE (g->'members')::jsonb @> jsonb_build_array(get_auth_email())
            AND (g->'members')::jsonb @> jsonb_build_array(submissions.student_email)
      )
  ) AND EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND status = 'published'))
);

DROP POLICY IF EXISTS "Submissions: Student Delete" ON submissions;
CREATE POLICY "Submissions: Student Delete" ON submissions FOR DELETE USING (
  student_email = get_auth_email() OR
  (EXISTS (
    SELECT 1 FROM assignments a
    WHERE a.id = submissions.assignment_id
      AND a.assignment_type = 'group'
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(a.groups, '[]'::jsonb)) g
          WHERE (g->'members')::jsonb @> jsonb_build_array(get_auth_email())
            AND (g->'members')::jsonb @> jsonb_build_array(submissions.student_email)
      )
  ) AND EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND status = 'published'))
);

DROP POLICY IF EXISTS "Submissions: Teachers Delete" ON submissions;
CREATE POLICY "Submissions: Teachers Delete" ON submissions FOR DELETE USING (
  is_admin() OR
  (is_teacher() AND EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND teacher_email = get_auth_email()))
);
