-- Incremental update script for Real-time publication and replica identities

-- 1. Recreate the supabase_realtime publication
DROP PUBLICATION IF EXISTS supabase_realtime;

CREATE PUBLICATION supabase_realtime FOR TABLE
    notifications,
    broadcasts,
    quiz_submissions,
    violations,
    system_settings,
    discussions,
    discussion_views;

-- 2. Configure tables to use FULL replica identity
ALTER TABLE notifications REPLICA IDENTITY FULL;
ALTER TABLE broadcasts REPLICA IDENTITY FULL;
ALTER TABLE quiz_submissions REPLICA IDENTITY FULL;
ALTER TABLE violations REPLICA IDENTITY FULL;
ALTER TABLE system_settings REPLICA IDENTITY FULL;
ALTER TABLE discussions REPLICA IDENTITY FULL;
ALTER TABLE discussion_views REPLICA IDENTITY FULL;
