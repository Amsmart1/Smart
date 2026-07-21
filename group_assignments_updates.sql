-- Migration to support Group Assignments
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS assignment_type VARCHAR(50) DEFAULT 'individual' CHECK (assignment_type IN ('individual', 'group'));
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS groups JSONB DEFAULT '[]'::jsonb;
