-- Track indexing state of materials to manage lifecycle and support resume/skip functionality
CREATE TABLE IF NOT EXISTS material_indexing_states (
  material_id UUID PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  file_url TEXT, -- Store the URL of the PDF at the time of indexing
  extracted_text TEXT,
  chunks JSONB, -- Array of chunk objects [{content, metadata, structure_type, chunk_index}]
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'extracting', 'extracted', 'chunking', 'chunked', 'embedding', 'completed', 'failed')),
  current_step VARCHAR(50) DEFAULT 'none',
  error_message TEXT,
  timing_logs JSONB DEFAULT '{}'::jsonb,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_material_indexing_states_course ON material_indexing_states(course_id);

-- Enable RLS
ALTER TABLE material_indexing_states ENABLE ROW LEVEL SECURITY;

-- 16.6 Material Indexing States Table RLS Policies
DROP POLICY IF EXISTS "Indexing States: Select" ON material_indexing_states;
CREATE POLICY "Indexing States: Select" ON material_indexing_states FOR SELECT USING (
  is_admin() OR
  EXISTS (SELECT 1 FROM courses WHERE id = material_indexing_states.course_id AND teacher_email = get_auth_email()) OR
  (EXISTS (SELECT 1 FROM enrollments WHERE course_id = material_indexing_states.course_id AND student_email = get_auth_email()) AND
   EXISTS (SELECT 1 FROM courses WHERE id = material_indexing_states.course_id AND status = 'published'))
);

DROP POLICY IF EXISTS "Indexing States: Teachers Manage" ON material_indexing_states;
CREATE POLICY "Indexing States: Teachers Manage" ON material_indexing_states FOR ALL USING (
  is_admin() OR EXISTS (SELECT 1 FROM courses WHERE id = material_indexing_states.course_id AND teacher_email = get_auth_email())
);

GRANT ALL ON TABLE material_indexing_states TO anon, authenticated, postgres, service_role;
