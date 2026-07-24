-- Migration updates to support Archived courses
-- Allows enrolled students to read-only access/select various related records when course status is 'archived'

-- 1. Courses Table
DROP POLICY IF EXISTS "Courses: Select" ON courses;
CREATE POLICY "Courses: Select" ON courses FOR SELECT USING (status = 'published' OR status = 'archived' OR teacher_email = get_auth_email() OR is_admin());

-- 2. Topics Table
DROP POLICY IF EXISTS "Topics: Select" ON topics;
CREATE POLICY "Topics: Select" ON topics FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = topics.course_id AND student_email = get_auth_email()) AND
   EXISTS (SELECT 1 FROM courses WHERE id = topics.course_id AND (status = 'published' OR status = 'archived')))
);

-- 3. Lessons Table
DROP POLICY IF EXISTS "Lessons: Select" ON lessons;
CREATE POLICY "Lessons: Select" ON lessons FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = lessons.course_id AND student_email = get_auth_email()) AND
   EXISTS (SELECT 1 FROM courses WHERE id = lessons.course_id AND (status = 'published' OR status = 'archived')))
);

-- 4. Enrollments Table
DROP POLICY IF EXISTS "Enrollments: User Access" ON enrollments;
CREATE POLICY "Enrollments: User Access" ON enrollments FOR SELECT USING (
  is_admin() OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = enrollments.course_id AND (status = 'published' OR status = 'archived'))) OR
  (is_teacher() AND EXISTS (SELECT 1 FROM courses WHERE id = enrollments.course_id AND teacher_email = get_auth_email()))
);

-- 5. Assignments Table
DROP POLICY IF EXISTS "Assignments: Select" ON assignments;
CREATE POLICY "Assignments: Select" ON assignments FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (status = 'published' AND EXISTS (SELECT 1 FROM courses WHERE id = assignments.course_id AND (status = 'published' OR status = 'archived')) AND EXISTS (SELECT 1 FROM enrollments WHERE course_id = assignments.course_id AND student_email = get_auth_email()))
);

-- 6. Submissions Table
DROP POLICY IF EXISTS "Submissions: Select" ON submissions;
CREATE POLICY "Submissions: Select" ON submissions FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND teacher_email = get_auth_email()) OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = submissions.course_id AND (status = 'published' OR status = 'archived')))
);

-- 7. Live Classes Table
DROP POLICY IF EXISTS "Live Classes: Select" ON live_classes;
CREATE POLICY "Live Classes: Select" ON live_classes FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = live_classes.course_id AND student_email = get_auth_email()) AND EXISTS (SELECT 1 FROM courses WHERE id = live_classes.course_id AND (status = 'published' OR status = 'archived')))
);

-- 8. Attendance Table
DROP POLICY IF EXISTS "Attendance: Access" ON attendance;
CREATE POLICY "Attendance: Access" ON attendance FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = attendance.course_id AND (status = 'published' OR status = 'archived')))
);

-- 9. Quizzes Table
DROP POLICY IF EXISTS "Quizzes: Select" ON quizzes;
CREATE POLICY "Quizzes: Select" ON quizzes FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (status = 'published' AND EXISTS (SELECT 1 FROM courses WHERE id = quizzes.course_id AND (status = 'published' OR status = 'archived')) AND EXISTS (SELECT 1 FROM enrollments WHERE course_id = quizzes.course_id AND student_email = get_auth_email()))
);

-- 10. Quiz Submissions Table
DROP POLICY IF EXISTS "Quiz Submissions: Access" ON quiz_submissions;
CREATE POLICY "Quiz Submissions: Access" ON quiz_submissions FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (student_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = quiz_submissions.course_id AND (status = 'published' OR status = 'archived')))
);

-- 11. Materials Table
DROP POLICY IF EXISTS "Materials: Select" ON materials;
CREATE POLICY "Materials: Select" ON materials FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = materials.course_id AND student_email = get_auth_email()) AND EXISTS (SELECT 1 FROM courses WHERE id = materials.course_id AND (status = 'published' OR status = 'archived')))
);

-- 12. Discussions Table
DROP POLICY IF EXISTS "Discussions: Select" ON discussions;
CREATE POLICY "Discussions: Select" ON discussions FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = discussions.course_id AND student_email = get_auth_email()) AND EXISTS (SELECT 1 FROM courses WHERE id = discussions.course_id AND (status = 'published' OR status = 'archived')))
);

-- 13. Broadcasts Table
DROP POLICY IF EXISTS "Broadcasts: SELECT" ON broadcasts;
CREATE POLICY "Broadcasts: SELECT" ON broadcasts FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (
    (target_role IS NULL OR target_role = get_auth_role()) AND (
      course_id IS NULL OR
      EXISTS (
        SELECT 1 FROM enrollments e
        JOIN courses c ON e.course_id = c.id
        WHERE e.course_id = broadcasts.course_id
        AND e.student_email = get_auth_email()
        AND (c.status = 'published' OR c.status = 'archived')
      )
    )
  )
);

-- 14. Embeddings Table
DROP POLICY IF EXISTS "Embeddings: Select" ON knowledge_embeddings;
CREATE POLICY "Embeddings: Select" ON knowledge_embeddings FOR SELECT USING (
  is_admin() OR
  EXISTS (SELECT 1 FROM courses WHERE id = knowledge_embeddings.course_id AND teacher_email = get_auth_email()) OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = knowledge_embeddings.course_id AND student_email = get_auth_email()) AND
   EXISTS (SELECT 1 FROM courses WHERE id = knowledge_embeddings.course_id AND (status = 'published' OR status = 'archived')))
);

-- 15. Indexing States Table
DROP POLICY IF EXISTS "Indexing States: Select" ON material_indexing_states;
CREATE POLICY "Indexing States: Select" ON material_indexing_states FOR SELECT USING (
  is_admin() OR
  EXISTS (SELECT 1 FROM courses WHERE id = material_indexing_states.course_id AND teacher_email = get_auth_email()) OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = material_indexing_states.course_id AND student_email = get_auth_email()) AND
   EXISTS (SELECT 1 FROM courses WHERE id = material_indexing_states.course_id AND (status = 'published' OR status = 'archived')))
);

-- 16. Violations Table
DROP POLICY IF EXISTS "Violations: User Access" ON violations;
CREATE POLICY "Violations: User Access" ON violations FOR SELECT USING (
  is_admin() OR
  teacher_email = get_auth_email() OR
  (user_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = violations.course_id AND (status = 'published' OR status = 'archived')))
);

-- 17. Study Sessions Table
DROP POLICY IF EXISTS "Study Sessions: User Access" ON study_sessions;
CREATE POLICY "Study Sessions: User Access" ON study_sessions FOR SELECT USING (
  is_admin() OR teacher_email = get_auth_email() OR (user_email = get_auth_email() AND EXISTS (SELECT 1 FROM courses WHERE id = study_sessions.course_id AND (status = 'published' OR status = 'archived')))
);
