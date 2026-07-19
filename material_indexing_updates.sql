-- ============================================================================
-- Enterprise-Grade Database Migration: Material Indexing Lifecycle Management
-- Designed for National-Level Scalability and Reliable Background Processing
-- ============================================================================

-- 1. CLEAN UP LEGACY ARTIFACTS
-- Drops legacy table, RLS policies, and associated functions to reclaim storage
-- and prevent redundant/conflicting logic under high-load multi-instance setups.
DROP TABLE IF EXISTS material_embeddings CASCADE;
DROP FUNCTION IF EXISTS match_material_embeddings CASCADE;

-- 2. CREATE LIFE-CYCLE TRACKING TABLE FOR MATERIAL INDEXING
-- Stateful tracking of material indexing stages allows precise resumption on failure,
-- prevents redundant work, and provides precise observability telemetry.
CREATE TABLE IF NOT EXISTS material_indexing_states (
  material_id UUID PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  file_url TEXT, -- Store URL of PDF at time of indexing to detect external updates
  extracted_text TEXT, -- Multimodal extraction cached content
  chunks JSONB, -- Array of chunk structures [{content, metadata, structure_type, chunk_index}]
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'extracting', 'extracted', 'chunking', 'chunked', 'embedding', 'completed', 'failed')),
  current_step VARCHAR(50) DEFAULT 'none',
  error_message TEXT,
  timing_logs JSONB DEFAULT '{}'::jsonb, -- Telemetry for monitoring stage execution speeds
  retry_count INTEGER DEFAULT 0,
  last_chunk_index INTEGER DEFAULT -1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE material_indexing_states ADD COLUMN IF NOT EXISTS last_chunk_index INTEGER DEFAULT -1;

-- 3. HIGH-PERFORMANCE SEARCH & OPERATIONAL INDEXES
-- Indexing course_id for fast queries filtered by course context
CREATE INDEX IF NOT EXISTS idx_material_indexing_states_course ON material_indexing_states(course_id);

-- Indexing status for high-frequency polling/monitoring of failing/pending state transitions
CREATE INDEX IF NOT EXISTS idx_material_indexing_states_status ON material_indexing_states(status);

-- Indexing updated_at to optimize order-by queries in tracking dashboards and recovery tasks
CREATE INDEX IF NOT EXISTS idx_material_indexing_states_updated ON material_indexing_states(updated_at DESC);

-- 4. AUTOMATIC TIMESTAMP UPDATE TRIGGER
-- Guarantees accurate state transition monitoring and helps detect stale/stuck operations.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column'
    ) THEN
        DROP TRIGGER IF EXISTS update_material_indexing_states_updated_at ON material_indexing_states;
        CREATE TRIGGER update_material_indexing_states_updated_at
        BEFORE UPDATE ON material_indexing_states
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 5. ROW LEVEL SECURITY (RLS) POLICIES
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

-- 6. SYSTEM-WIDE SECURITY GRANTS
GRANT ALL ON TABLE material_indexing_states TO anon, authenticated, postgres, service_role;

-- RPC for fetching unique source_type and source_id pairs from knowledge_embeddings
CREATE OR REPLACE FUNCTION get_distinct_knowledge_sources(p_course_id UUID)
RETURNS TABLE (
  source_type VARCHAR,
  source_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Enterprise Grade Security: Validate access context
  IF NOT (
    is_admin() OR
    EXISTS (SELECT 1 FROM courses WHERE id = p_course_id AND teacher_email = get_auth_email()) OR
    EXISTS (SELECT 1 FROM enrollments WHERE course_id = p_course_id AND student_email = get_auth_email())
  ) THEN
    RAISE EXCEPTION 'Access Denied: get_distinct_knowledge_sources authorization failed';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ke.source_type, ke.source_id
  FROM knowledge_embeddings ke
  WHERE ke.course_id = p_course_id;
END;
$$;

REVOKE ALL ON FUNCTION get_distinct_knowledge_sources(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_distinct_knowledge_sources(UUID) TO authenticated, anon;
