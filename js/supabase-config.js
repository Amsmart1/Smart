// Supabase Configuration
// Public anon key is safe to expose in client-side code.
const SUPABASE_URL = 'https://hupssocmagotpaoyhezt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh1cHNzb2NtYWdvdHBhb3loZXp0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4NzA2MTAsImV4cCI6MjA5NDQ0NjYxMH0.DiGpIi-yb0YxafLTGPhk1kqH7maD4FtPiC4gvmpYqnA';

// Initialize Supabase client
if (!window.supabase) {
    console.error('Supabase library not loaded. Please check your internet connection or CDN availability.');
}
const createClient = window.supabase?.createClient;

// Standard client options with dynamic header injection via custom fetch
const clientOptions = {
    global: {
        fetch: (url, options) => {
            const sid = sessionStorage.getItem('sessionId');
            const migrationMode = sessionStorage.getItem('migrationMode');
            options = options || {};
            const headers = new Headers(options.headers || {});

            // Inject sid if it exists in sessionStorage
            if (sid) {
                headers.set('x-session-id', sid);
            }

            // Inject migration mode header if active
            if (migrationMode === 'true') {
                headers.set('x-migration-mode', 'true');
            }

            options.headers = headers;
            return fetch(url, options);
        }
    },
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
    },
    realtime: {
        headers: {
            'x-session-id': sessionStorage.getItem('sessionId')
        }
    }
};

const supabaseClient = createClient ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, clientOptions) : null;
window.supabaseClient = supabaseClient;

/**
 * Updates the Supabase client session context.
 * The custom fetch function will automatically pick up the new ID from sessionStorage.
 */
function setSupabaseSession(sessionId) {
    if (sessionId) {
        sessionStorage.setItem('sessionId', sessionId);
    } else {
        sessionStorage.removeItem('sessionId');
    }

    // Update realtime headers for existing client
    if (supabaseClient && supabaseClient.realtime) {
        supabaseClient.realtime.setAuth(sessionId);
    }
}
window.setSupabaseSession = setSupabaseSession;

const _stats = {
    totalRequests: 0,
    failedRequests: 0,
    lastRequestTime: 0
};

const _cache = {
    data: {},
    pending: new Map(), // Track in-flight promises to prevent "thundering herd" requests
    ttl: 30000, // 30 seconds
    async fetch(key, fn) {
        const now = Date.now();
        // Append current user email to key if available to prevent cross-account cache leakage
        let userEmail = '';
        try {
            const raw = sessionStorage.getItem('currentUser');
            if (raw) userEmail = JSON.parse(raw).email;
        } catch(e) {}

        const contextualKey = userEmail ? `${key}_${userEmail}` : key;

        // 1. Check if we have a fresh cached value
        if (this.data[contextualKey] && (now - this.data[contextualKey].ts < this.ttl)) {
            return this.data[contextualKey].val;
        }

        // 2. Check if a request for this key is already in-flight
        if (this.pending.has(contextualKey)) {
            return this.pending.get(contextualKey);
        }

        // 3. Execute the fetch and track it
        const promise = (async () => {
            try {
                const val = await fn();
                this.data[contextualKey] = { val, ts: Date.now() };
                return val;
            } finally {
                this.pending.delete(contextualKey);
            }
        })();

        this.pending.set(contextualKey, promise);
        return promise;
    },
    invalidate(key) {
        if (key) {
            delete this.data[key];
            this.pending.delete(key);
        } else {
            this.data = {};
            this.pending.clear();
        }
    }
};

// Supabase Database Operations
class SupabaseDB {
    static JSONB_COLUMNS = [
        'questions', 'attachments', 'completed_lessons', 'metadata',
        'reset_request', 'notification_preferences', 'answers',
        'question_scores', 'question_feedback', 'recurring_config',
        'analytics', 'schedules', 'allowed_extensions', 'anti_cheat_config',
        'reset_data'
    ];

    static _sanitizePayload(payload, table = null) {
        if (!payload || typeof payload !== 'object') return payload;
        const sanitized = { ...payload };

        // 1. Explicitly strip virtual/internal fields that don't belong in database tables
        // We also strip internal UI states (starting with _) to prevent leakage
        const VIRTUAL_FIELDS = ['password', 'session_id', 'has_secret', 'reset_data'];
        VIRTUAL_FIELDS.forEach(field => {
            // Preservation logic: Do NOT strip session_id or reset_data if targeting user_secrets table
            if (table === 'user_secrets' && (field === 'session_id' || field === 'reset_data')) return;
            delete sanitized[field];
        });

        Object.keys(sanitized).forEach(key => {
            const value = sanitized[key];

            // 2. Remove internal state fields (keys starting with _)
            if (key.startsWith('_')) {
                delete sanitized[key];
                return;
            }

            // 3. Remove joined objects/arrays that are NOT known JSONB/Array columns
            if (value !== null && typeof value === 'object' && !this.JSONB_COLUMNS.includes(key)) {
                delete sanitized[key];
            }
            // 4. Convert empty strings to null for better database integrity (especially FKs)
            if (sanitized[key] === '') {
                sanitized[key] = null;
            }

            // 5. Enforce unique email constraints through strict normalization
            // We use a targeted whitelist to avoid side-effects on fields like 'created_by' (which store names)
            const EMAIL_FIELDS = ['email', 'student_email', 'teacher_email', 'user_email'];
            if ((EMAIL_FIELDS.includes(key) || (table === 'invites' && key === 'created_by')) && typeof sanitized[key] === 'string') {
                sanitized[key] = sanitized[key].trim().toLowerCase();
            }
        });
        return sanitized;
    }

    static async _upsert(table, payload, onConflict = 'id') {
        const sanitized = Array.isArray(payload)
            ? payload.map(p => this._sanitizePayload(p, table))
            : this._sanitizePayload(payload, table);

        return this._request(async () => {
            const { data, error } = await supabaseClient
                .from(table)
                .upsert(sanitized, { onConflict })
                .select();
            if (error) throw error;
            return data;
        });
    }

    /**
     * Performs a standard UPDATE operation with filters.
     * Use this instead of _upsert when INSERT permissions are not granted (RLS).
     */
    static async _update(table, payload, filters) {
        const sanitized = this._sanitizePayload(payload, table);

        return this._request(async () => {
            let query = supabaseClient.from(table).update(sanitized);
            if (filters) {
                Object.keys(filters).forEach(key => {
                    query = query.eq(key, filters[key]);
                });
            }
            const { data, error } = await query.select();
            if (error) throw error;
            return data;
        });
    }

    /**
     * Standardized helper for paginated data retrieval.
     */
    static async _getPaginated(query, options = {}) {
        const { page = 1, pageSize = 20 } = options;
        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;

        const { data, count, error } = await query.range(from, to);
        if (error) throw error;
        return { data: data || [], total: count || 0, page, pageSize };
    }

    static async _request(fn) {
        if (!supabaseClient) {
            throw new Error('Supabase client not initialized. Check your connection or CDN availability.');
        }
        _stats.totalRequests++;
        try {
            const start = performance.now();
            const res = await fn();
            _stats.lastRequestTime = Math.round(performance.now() - start);
            return res;
        } catch (e) {
            _stats.failedRequests++;
            throw e;
        }
    }

    static getStats() {
        const successRate = _stats.totalRequests ? ((_stats.totalRequests - _stats.failedRequests) / _stats.totalRequests * 100).toFixed(1) : 100;
        return { ..._stats, successRate };
    }

    // Generic count operation
    static async getCount(table, filterFn = null, select = '*') {
        return this._request(async () => {
            let query = supabaseClient.from(table).select(select, { count: 'exact', head: true });
            if (filterFn) query = filterFn(query);
            const { count, error } = await query;
            if (error) throw error;
            return count || 0;
        });
    }

    // User operations
    static async getUsers(options = {}) {
        const { searchTerm = '', role = null, resetStatus = null, status = null } = options;
        return this._request(async () => {
            let query = supabaseClient.from('users').select('*', { count: 'exact' });
            if (role) query = query.eq('role', role);
            if (resetStatus) query = query.eq('reset_request->>status', resetStatus);

            if (status === 'active') query = query.eq('active', true);
            else if (status === 'inactive') query = query.eq('active', false);
            else if (status === 'flagged') query = query.eq('flagged', true);
            else if (status === 'locked') query = query.gt('locked_until', new Date().toISOString());

            if (searchTerm) {
                query = query.or(`full_name.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%`);
            }

            return this._getPaginated(query.order('full_name', { ascending: true }), options);
        });
    }

    /**
     * Retrieves all users with a specific role.
     */
    static async getUsersByRole(role) {
        return this._request(async () => {
            const { data, count, error } = await supabaseClient
                .from('users')
                .select('*', { count: 'exact' })
                .eq('role', role);
            if (error) throw error;
            return { data: data || [], total: count || 0 };
        });
    }

    /**
     * Retrieves all active administrator users.
     */
    static async getAdmins() {
        return this._request(async () => {
            const { data, error } = await supabaseClient
                .from('users')
                .select('email')
                .eq('role', 'admin')
                .eq('active', true);
            if (error) throw error;
            return data || [];
        });
    }

    static async getEnrolledStudents(courseIds) {
        if (!courseIds || courseIds.length === 0) return { data: [], total: 0 };
        return this._request(async () => {
            const { data, count, error } = await supabaseClient
                .from('users')
                .select('*, enrollments!inner(*)', { count: 'exact' })
                .in('enrollments.course_id', courseIds);
            if (error) throw error;
            return { data: data || [], total: count || 0 };
        });
    }

    static async getEnrollmentsByCourses(courseIds, options = {}) {
        if (!courseIds || courseIds.length === 0) return { data: [], total: 0 };
        const { searchTerm = '' } = options;

        return this._request(async () => {
            let query = supabaseClient
                .from('enrollments')
                .select('*, users!inner(*), courses(*)', { count: 'exact' })
                .in('course_id', courseIds);

            if (searchTerm) {
                query = query.or(`full_name.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%`, { foreignTable: 'users' });
            }

            const { data, count, error } = await query
                .order('enrolled_at', { ascending: false });

            if (error) throw error;
            return { data: data || [], total: count || 0 };
        });
    }

    static async saveUser(user) {
        // Handle User Creation via Secure RPC
        const isNewUser = !user.created_at;
        if (isNewUser) {
            return this.createUserSecure(user);
        }

        // Handle User Update
        // We use _update instead of _upsert here because regular users do not have INSERT
        // permissions on the users table (enforced by RLS), and upsert requires it.
        await this._update('users', user, { email: user.email });

        // Update secrets via secure RPC if provided
        if (user.password || user.session_id || user.reset_data) {
            try {
                const { error: secretError } = await supabaseClient.rpc('update_user_secret_secure', {
                    p_email: user.email,
                    p_password_hash: user.password || null,
                    p_session_id: user.session_id || (user.password ? 'invalidated_' + Date.now() : null),
                    p_reset_data: user.reset_data || null
                });
                if (secretError) throw secretError;

                // SECURITY: If session ID was updated, we MUST establish the new context locally
                // BEFORE the subsequent getUser call to avoid RLS authorization failures.
                // We only do this if the user being updated is the current session user.
                const currentUser = await SessionManager.getCurrentUser();
                if (currentUser && currentUser.email === user.email && user.session_id && typeof window.setSupabaseSession === 'function') {
                    window.setSupabaseSession(user.session_id);
                }
            } catch (e) {
                console.error('Failed to update user secrets:', e);
                throw new Error('Database Error: Security context could not be updated. ' + (e.message || ''));
            }
        }

        _cache.invalidate('users');
        _cache.invalidate(`user_${user.email}`);
        return this.getUser(user.email, true);
    }

    static async createUserSecure(user) {
        // We skip _sanitizePayload here because we're passing individual fields to an RPC,
        // and metadata is already expected to be a JSONB object.
        const sanitizedMetadata = user.metadata || {};
        const normalizedEmail = (user.email || '').trim().toLowerCase();

        const { data, error } = await supabaseClient.rpc('create_user_secure', {
            p_email: normalizedEmail,
            p_full_name: user.full_name,
            p_phone: user.phone || null,
            p_password_hash: user.password || null,
            p_role: user.role || null,
            p_session_id: user.session_id || null,
            p_invite_token: user.invite_token || null,
            p_active: user.active !== undefined ? user.active : true,
            p_metadata: sanitizedMetadata
        });
        if (error) throw error;
        if (!data.success) throw new Error(data.message);

        _cache.invalidate('users');
        _cache.invalidate(`user_${user.email}`);
        return data.user;
    }

    static async updateUserEmail(oldEmail, newEmail, userData) {
        const sanitized = this._sanitizePayload({ ...userData, email: newEmail });
        const { data, error } = await supabaseClient
            .from('users')
            .update(sanitized)
            .eq('email', oldEmail)
            .select();
        if (error) throw error;

        // Update secrets via secure RPC if provided
        if (userData.password || userData.session_id) {
            try {
                await supabaseClient.rpc('update_user_secret_secure', {
                    p_email: newEmail,
                    p_password_hash: userData.password || null,
                    p_session_id: userData.session_id || (userData.password ? 'invalidated_' + Date.now() : null)
                });
            } catch (e) {
                console.warn('Failed to update user secrets during email change:', e);
            }
        }

        _cache.invalidate('users');
        _cache.invalidate(`user_${oldEmail}`);
        _cache.invalidate(`user_${newEmail}`);
        return data?.[0];
    }

    static async deleteDiscussion(id) {
        const { error } = await supabaseClient
            .from('discussions')
            .delete()
            .eq('id', id);
        if (error) throw error;
        _cache.invalidate();
    }

    static async getUser(email, bypassCache = false) {
        if (bypassCache) _cache.invalidate(`user_${email}`);
        return _cache.fetch(`user_${email}`, async () => {
            const { data, error } = await supabaseClient.rpc('get_user_secure', { p_email: email });
            if (error) throw error;
            return data || null;
        });
    }

    static async deleteUser(email) {
        try {
            // Cleanup all related enrollment data first (includes related files/storage)
            const { data: enrollRes } = await this.getEnrollments(email);
            const enrollments = enrollRes || [];
            for (const e of enrollments) {
                await this.deleteEnrollment(e.course_id, email);
            }

            // Cleanup files before deleting user record (orphans not tied to enrollments)
            const [{ data: certs }, { data: submissions }] = await Promise.all([
                this.getCertificates(email).catch(() => ({ data: [] })),
                this.getSubmissions(null, email).catch(() => ({ data: [] }))
            ]);

            for (const cert of certs) {
                if (cert.certificate_url) await this.deleteFileByUrl(cert.certificate_url);
            }

            for (const sub of submissions) {
                await this.deleteSubmission(sub.assignment_id, email);
            }
        } catch (e) {
            console.warn('User file cleanup partially failed:', e);
        }

        const { error } = await supabaseClient
            .from('users')
            .delete()
            .eq('email', email);
        if (error) throw error;
        _cache.invalidate('users');
        _cache.invalidate(`user_${email}`);
    }

    // Assignment operations
    static async getAssignments(teacherEmail = null, courseId = null, courseIds = null, options = {}) {
        if (courseIds && courseIds.length === 0) return { data: [], total: 0 };
        const { searchTerm = '' } = options;

        return this._request(async () => {
            let query = supabaseClient.from('assignments').select('*', { count: 'exact' });
            if (teacherEmail) query = query.eq('teacher_email', teacherEmail);
            if (courseId) query = query.eq('course_id', courseId);
            if (courseIds && courseIds.length > 0) query = query.in('course_id', courseIds);
            if (searchTerm) query = query.ilike('title', `%${searchTerm}%`);

            return this._getPaginated(query.order('due_date', { ascending: false }), options);
        });
    }

    static async getEnrolledCourses(studentEmail, options = {}) {
        return this._request(async () => {
            const { data: enrollments, error: eError } = await supabaseClient
                .from('enrollments')
                .select('course_id')
                .eq('student_email', studentEmail);

            if (eError) throw eError;
            const courseIds = (enrollments || []).map(e => e.course_id);
            if (courseIds.length === 0) return { data: [], total: 0 };

            const { data, count, error } = await supabaseClient
                .from('courses')
                .select('*', { count: 'exact' })
                .in('id', courseIds)
                .order('title', { ascending: true });

            if (error) throw error;
            return { data: data || [], total: count || 0 };
        });
    }

    /**
     * Retrieves a single course by its ID.
     */
    static async getCourse(id) {
        return this._request(async () => {
            const { data, error } = await supabaseClient
                .from('courses')
                .select('*')
                .eq('id', id);
            if (error) throw error;
            return data?.[0] || null;
        });
    }

    static async getAssignment(id) {
        return this._request(async () => {
            const { data, error } = await supabaseClient
                .from('assignments')
                .select('*')
                .eq('id', id)
                .single();
            if (error) throw error;
            return data;
        });
    }

    static async reconcileQuizAttempts(quizId = null, studentEmail = null) {
        return this._request(async () => {
            const { error } = await supabaseClient.rpc('reconcile_quiz_attempts', {
                p_quiz_id: quizId,
                p_student_email: studentEmail
            });
            if (error) throw error;
            return true;
        });
    }

    static async startQuizAttempt(quizId) {
        return this._request(async () => {
            const { data, error } = await supabaseClient.rpc('start_quiz_attempt', {
                p_quiz_id: quizId
            });
            if (error) throw error;
            return data;
        });
    }

    static async submitQuizAttempt(submissionId, answers, timeSpent) {
        return this._request(async () => {
            const { data, error } = await supabaseClient.rpc('submit_quiz_attempt', {
                p_submission_id: submissionId,
                p_answers: answers,
                p_time_spent: timeSpent
            });
            if (error) throw error;
            return data;
        });
    }

    static async saveAssignment(assignment) {
        const data = await this._upsert('assignments', assignment);
        _cache.invalidate('assignments');
        return data?.[0];
    }

    static async deleteAssignment(id) {
        try {
            const [assignment, { data: submissions }] = await Promise.all([
                this.getAssignment(id),
                this.getSubmissions(id)
            ]);

            // Cleanup all submissions for this assignment (handles storage)
            for (const sub of submissions) {
                await this.deleteSubmission(id, sub.student_email);
            }

            // Cleanup assignment attachments
            if (assignment && assignment.attachments && Array.isArray(assignment.attachments)) {
                for (const att of assignment.attachments) {
                    if (att.url) await this.deleteFileByUrl(att.url);
                }
            }
        } catch (e) { console.warn('Failed to cleanup assignment files:', e); }

        const { error } = await supabaseClient
            .from('assignments')
            .delete()
            .eq('id', id);
        if (error) throw error;
        _cache.invalidate('assignments');
    }

    static async deleteSupportTicket(id) {
        const { error } = await supabaseClient
            .from('support_tickets')
            .delete()
            .eq('id', id);
        if (error) throw error;
        _cache.invalidate('support_tickets');
    }

    static async updateSupportTicket(id, updates) {
        const { data, error } = await supabaseClient
            .from('support_tickets')
            .update(updates)
            .eq('id', id)
            .select();
        if (error) throw error;
        _cache.invalidate('support_tickets');
        return data?.[0];
    }

    // Submission operations
    static async getSubmissions(assignmentId = null, studentEmail = null, teacherEmail = null, options = {}) {
        const { status = null, pendingGradingOnly = false } = options;
        return this._request(async () => {
            let selectStr = '*, assignments(*)';
            if (teacherEmail) selectStr = '*, assignments!inner(*)';

            let query = supabaseClient.from('submissions').select(selectStr, { count: 'exact' });
            if (assignmentId) query = query.eq('assignment_id', assignmentId);
            if (studentEmail) query = query.eq('student_email', studentEmail);
            if (teacherEmail) query = query.eq('assignments.teacher_email', teacherEmail);

            if (pendingGradingOnly) {
                query = query.or('status.eq.submitted,regrade_request.not.is.null');
            } else if (status) {
                query = query.eq('status', status);
            }

            return this._getPaginated(query.order('submitted_at', { ascending: false }), options);
        });
    }

    static async getSubmission(assignmentId, studentEmail) {
        return this._request(async () => {
            const { data, error } = await supabaseClient
                .from('submissions')
                .select('*')
                .eq('assignment_id', assignmentId)
                .eq('student_email', studentEmail);
            if (error) throw error;
            return data?.[0] || null;
        });
    }

    static async saveSubmission(submission) {
        let data;
        if (submission.id) {
            // Use _update instead of _upsert when id is present to avoid 401 errors
            // for users (like teachers) who have UPDATE but not INSERT permissions.
            data = await this._update('submissions', submission, { id: submission.id });
        } else {
            // Initial student submission
            data = await this._upsert('submissions', submission, 'assignment_id,student_email');
        }
        _cache.invalidate('submissions');
        return data?.[0] || null;
    }

    static async deleteSubmission(assignmentId, studentEmail) {
        try {
            const sub = await this.getSubmission(assignmentId, studentEmail);
            if (sub && sub.answers) {
                for (const key in sub.answers) {
                    const val = sub.answers[key];
                    if (typeof val === 'string' && (val.includes('assignments/submissions') || val.includes('assignment_submissions'))) {
                        await this.deleteFileByUrl(val);
                    }
                }
            }
            if (sub && sub.attachments && Array.isArray(sub.attachments)) {
                for (const att of sub.attachments) {
                    if (att.url) await this.deleteFileByUrl(att.url);
                }
            }
        } catch (e) { console.warn('Failed to cleanup submission files:', e); }

        const { error } = await supabaseClient
            .from('submissions')
            .delete()
            .eq('assignment_id', assignmentId)
            .eq('student_email', studentEmail);
        if (error) throw error;
        _cache.invalidate('submissions');
    }

    // Enrollment operations
    static async getEnrollments(studentEmail) {
        return _cache.fetch(`enrollments_${studentEmail}`, async () => {
            const { data, count, error } = await supabaseClient
                .from('enrollments')
                .select('*, courses(*)', { count: 'exact' })
                .eq('student_email', studentEmail);
            if (error) throw error;
            return { data: data || [], total: count || 0 };
        });
    }

    static async saveEnrollment(enrollment) {
        const data = await this._upsert('enrollments', enrollment, 'course_id,student_email');
        _cache.invalidate(`enrollments_${enrollment.student_email}`);
        return data?.[0];
    }

    static async enrollInCourse(courseId, studentEmail, enrollmentId = null) {
        const { error } = await supabaseClient.rpc('enroll_in_course', {
            p_course_id: courseId,
            p_student_email: studentEmail,
            p_enrollment_id: enrollmentId
        });
        if (error) throw error;
        _cache.invalidate(`enrollments_${studentEmail}`);
        _cache.invalidate(`enrolled_courses_${studentEmail}`);
    }

    static async deleteEnrollment(courseId, studentEmail) {
        return this._request(async () => {
            // Thorough cleanup: Delete all related student history for this course
            // Using Exhaustive bypass of pagination for all related record identification
            try {
                const [assignments, quizzes, liveClasses, certificates] = await Promise.all([
                    this._getAll(supabaseClient.from('assignments').select('id').eq('course_id', courseId)),
                    this._getAll(supabaseClient.from('quizzes').select('id').eq('course_id', courseId)),
                    this._getAll(supabaseClient.from('live_classes').select('id').eq('course_id', courseId)),
                    this._getAll(supabaseClient.from('certificates').select('certificate_url').match({ course_id: courseId, student_email: studentEmail }))
                ]);

                const assignIds = assignments.map(a => a.id);
                const quizIds = quizzes.map(q => q.id);
                const classIds = liveClasses.map(lc => lc.id);

                // 1. Delete Submissions (including storage cleanup for files)
                for (const aid of assignIds) {
                    try { await this.deleteSubmission(aid, studentEmail); } catch(e) { console.warn(`Sub cleanup failed for ${aid}:`, e); }
                }

                // 2. Delete Quiz Submissions
                if (quizIds.length > 0) {
                    const { error: qsErr } = await supabaseClient.from('quiz_submissions').delete().eq('student_email', studentEmail).in('quiz_id', quizIds);
                    if (qsErr) console.warn('Quiz sub cleanup failed:', qsErr);
                }

                // 3. Delete Attendance records
                if (classIds.length > 0) {
                    const { error: attErr } = await supabaseClient.from('attendance').delete().eq('student_email', studentEmail).in('live_class_id', classIds);
                    if (attErr) console.warn('Attendance cleanup failed:', attErr);
                }

                // 4. Delete Study Sessions
                const { error: ssErr } = await supabaseClient.from('study_sessions').delete().match({ course_id: courseId, user_email: studentEmail });
                if (ssErr) console.warn('Study session cleanup failed:', ssErr);

                // 5. Delete Discussions
                const { error: discErr } = await supabaseClient.from('discussions').delete().match({ course_id: courseId, user_email: studentEmail });
                if (discErr) console.warn('Discussion cleanup failed:', discErr);

                // 6. Delete Violations (Anti-cheat events)
                const { error: vioErr } = await supabaseClient.from('violations').delete().match({ course_id: courseId, user_email: studentEmail });
                if (vioErr) console.warn('Violation cleanup failed:', vioErr);

                // 7. Delete Certificates and associated PDF files
                for (const cert of certificates) {
                    if (cert.certificate_url) try { await this.deleteFileByUrl(cert.certificate_url); } catch(e) { console.warn('Cert file cleanup failed:', e); }
                }
                const { error: certErr } = await supabaseClient.from('certificates').delete().match({ course_id: courseId, student_email: studentEmail });
                if (certErr) console.warn('Cert record cleanup failed:', certErr);

            } catch (e) {
                console.warn('Identification of cleanup records failed:', e);
                // We proceed to try delete the enrollment anyway, as that's the primary goal.
            }

            const { error } = await supabaseClient
                .from('enrollments')
                .delete()
                .match({ course_id: courseId, student_email: studentEmail });
            if (error) throw error;

            // Invalidate relevant caches
            _cache.invalidate(`enrollments_${studentEmail}`);
            _cache.invalidate(`enrolled_courses_${studentEmail}`);
            _cache.invalidate('submissions');
            _cache.invalidate('violations');
            _cache.invalidate('study_sessions');
            _cache.invalidate('attendance');
            _cache.invalidate(); // Broad invalidation for quizzes/discussions
            return true;
        });
    }

    static async markLessonComplete(courseId, studentEmail, lessonId) {
        const { data: enrollment, error: fetchError } = await supabaseClient
            .from('enrollments')
            .select('completed_lessons')
            .match({ course_id: courseId, student_email: studentEmail })
            .maybeSingle();

        if (fetchError) throw fetchError;

        let completed = enrollment?.completed_lessons || [];
        if (!completed.includes(lessonId)) {
            completed.push(lessonId);
            const { error: updateError } = await supabaseClient
                .from('enrollments')
                .update({ completed_lessons: completed })
                .match({ course_id: courseId, student_email: studentEmail });
            if (updateError) throw updateError;
            _cache.invalidate(`enrollments_${studentEmail}`);
            await this.updateCourseProgress(courseId, studentEmail);
        }
    }

    static async updateCourseProgress(courseId, studentEmail) {
        try {
            const [{ data: lessons }, { data: courseAssignments }, { data: courseQuizzes }, { data: submissions }, { data: quizSubs }] = await Promise.all([
                this.getLessons(courseId),
                this.getAssignments(null, courseId),
                this.getQuizzes(courseId),
                this.getSubmissions(null, studentEmail),
                this.getQuizSubmissions(null, studentEmail)
            ]);

            // Filter for published only as they count towards progress
            const activeAssignments = courseAssignments.filter(a => a.status === 'published');
            const activeQuizzes = courseQuizzes.filter(q => q.status === 'published');

            const totalItems = lessons.length + activeAssignments.length + activeQuizzes.length;
            if (totalItems === 0) return;

            let completedItems = 0;

            // Lessons: Use completed_lessons tracker
            const { data: enrollment } = await supabaseClient
                .from('enrollments')
                .select('completed_lessons')
                .match({ course_id: courseId, student_email: studentEmail })
                .maybeSingle();

            const completedLessonIds = enrollment?.completed_lessons || [];
            completedItems += lessons.filter(l => completedLessonIds.includes(l.id)).length;

            // Assignments
            activeAssignments.forEach(a => {
                if (submissions.some(s => s.assignment_id === a.id && (s.status === 'submitted' || s.status === 'graded'))) {
                    completedItems++;
                }
            });

            // Quizzes
            activeQuizzes.forEach(q => {
                if (quizSubs.some(s => s.quiz_id === q.id && s.status === 'submitted')) {
                    completedItems++;
                }
            });

            const progress = Math.min(100, Math.round((completedItems / totalItems) * 100));

            await supabaseClient
                .from('enrollments')
                .update({ progress: progress, completed: progress === 100 })
                .match({ course_id: courseId, student_email: studentEmail });

            _cache.invalidate(`enrollments_${studentEmail}`);
        } catch (e) {
            console.error('Failed to update progress:', e);
        }
    }

    // Course operations
    static async getCourses(teacherEmail = null, status = null, options = {}) {
        const { searchTerm = '' } = options;
        return this._request(async () => {
            let query = supabaseClient.from('courses').select('*', { count: 'exact' });
            if (teacherEmail) query = query.eq('teacher_email', teacherEmail);
            if (status) query = query.eq('status', status);
            if (searchTerm) query = query.ilike('title', `%${searchTerm}%`);

            return this._getPaginated(query.order('title', { ascending: true }), options);
        });
    }

    /**
     * Creates or updates a course record.
     */
    static async saveCourse(course) {
        const data = await this._upsert('courses', course);
        _cache.invalidate('courses_all');
        if (course.teacher_email) _cache.invalidate(`courses_${course.teacher_email}`);
        return data?.[0];
    }

    static async deleteCourse(id) {
        try {
            const [{ data: materials }, { data: assignments }, { data: liveClasses }, certs] = await Promise.all([
                this.getMaterials(id),
                this.getAssignments(null, id),
                this.getLiveClasses(id),
                supabaseClient.from('certificates').select('certificate_url').eq('course_id', id)
            ]);

            // Recursive cleanup for all course content
            for (const m of materials) {
                await this.deleteMaterial(m.id);
            }

            for (const a of assignments) {
                await this.deleteAssignment(a.id);
            }

            for (const lc of liveClasses) {
                await this.deleteLiveClass(lc.id);
            }

            if (certs.data) {
                for (const cert of certs.data) {
                    if (cert.certificate_url) await this.deleteFileByUrl(cert.certificate_url);
                }
            }
        } catch (e) { console.warn('Course content cleanup failed:', e); }

        const { error } = await supabaseClient
            .from('courses')
            .delete()
            .eq('id', id);
        if (error) throw error;
        _cache.invalidate(); // Broad invalidation to be safe
    }

    // Topic operations
    static async getTopics(courseId) {
        return this._request(async () => {
            const { data, count, error } = await supabaseClient
                .from('topics')
                .select('*', { count: 'exact' })
                .eq('course_id', courseId)
                .order('order_index', { ascending: true });
            if (error) throw error;
            return { data: data || [], total: count || 0 };
        });
    }

    static async saveTopic(topic) {
        const data = await this._upsert('topics', topic);
        _cache.invalidate('lessons'); // Invalidate lessons cache as they are related to topics
        return data?.[0];
    }

    static async deleteTopic(id) {
        const { error } = await supabaseClient
            .from('topics')
            .delete()
            .eq('id', id);
        if (error) throw error;
        _cache.invalidate('lessons');
    }

    // Lesson operations
    static async getLessons(courseId) {
        return this._request(async () => {
            const { data, count, error } = await supabaseClient
                .from('lessons')
                .select('*', { count: 'exact' })
                .eq('course_id', courseId)
                .order('order_index', { ascending: true });
            if (error) throw error;
            return { data: data || [], total: count || 0 };
        });
    }

    static async saveLesson(lesson) {
        const data = await this._upsert('lessons', lesson);
        return data?.[0];
    }

    static async deleteLesson(id) {
        const { error } = await supabaseClient
            .from('lessons')
            .delete()
            .eq('id', id);
        if (error) throw error;
        _cache.invalidate('lessons');
    }

    // Discussion operations
    static async getMaterials(courseId = null, courseIds = null, options = {}) {
        if (courseIds && courseIds.length === 0) return { data: [], total: 0 };
        return this._request(async () => {
            let query = supabaseClient.from('materials').select('*', { count: 'exact' });
            if (courseId) query = query.eq('course_id', courseId);
            if (courseIds && courseIds.length > 0) query = query.in('course_id', courseIds);

            const { data, count, error } = await query
                .order('created_at', { ascending: false });
            if (error) throw error;
            return { data: data || [], total: count || 0 };
        });
    }

    static async saveMaterial(material) {
        const data = await this._upsert('materials', material);
        _cache.invalidate('lessons');
        return data?.[0];
    }

    static async deleteMaterial(id) {
        try {
            const { data: material } = await supabaseClient.from('materials').select('file_url').eq('id', id).single();
            if (material && material.file_url) {
                await this.deleteFileByUrl(material.file_url);
            }
        } catch (e) { console.warn('Failed to cleanup material file:', e); }

        const { error } = await supabaseClient
            .from('materials')
            .delete()
            .eq('id', id);
        if (error) throw error;
    }

    // Discussion operations
    static async getDiscussions(courseId, options = {}) {
        return this._request(async () => {
            const { data, count, error } = await supabaseClient
                .from('discussions')
                .select('*', { count: 'exact' })
                .eq('course_id', courseId)
                .order('created_at', { ascending: true });
            if (error) throw error;
            return { data: data || [], total: count || 0 };
        });
    }

    static async saveDiscussion(discussion) {
        const data = await this._upsert('discussions', discussion);
        _cache.invalidate('materials');
        return data?.[0];
    }

    // Quiz operations
    static async getQuizzes(courseId = null, teacherEmail = null, courseIds = null, options = {}) {
        if (courseIds && courseIds.length === 0) return { data: [], total: 0 };
        const { searchTerm = '' } = options;

        return this._request(async () => {
            let query = supabaseClient.from('quizzes').select('*', { count: 'exact' });
            if (courseId) query = query.eq('course_id', courseId);
            if (teacherEmail) query = query.eq('teacher_email', teacherEmail);
            if (courseIds && courseIds.length > 0) query = query.in('course_id', courseIds);
            if (searchTerm) query = query.ilike('title', `%${searchTerm}%`);

            return this._getPaginated(query.order('created_at', { ascending: false }), options);
        });
    }

    static async getQuiz(id) {
        return this._request(async () => {
            const { data, error } = await supabaseClient
                .from('quizzes')
                .select('*')
                .eq('id', id)
                .single();
            if (error) throw error;
            return data;
        });
    }

    static async saveQuiz(quiz) {
        const data = await this._upsert('quizzes', quiz);
        _cache.invalidate(); // Quizzes have complex keys, simpler to clear all
        return data?.[0];
    }

    static async deleteQuiz(id) {
        const { error } = await supabaseClient
            .from('quizzes')
            .delete()
            .eq('id', id);
        if (error) throw error;
        _cache.invalidate('materials');
    }

    static async getQuizSubmissions(quizId = null, studentEmail = null, teacherEmail = null, options = {}) {
        const { status = null } = options;
        return this._request(async () => {
            let query = supabaseClient.from('quiz_submissions').select('*, quizzes!quiz_id(*)', { count: 'exact' });
            if (quizId) query = query.eq('quiz_id', quizId);
            if (studentEmail) query = query.eq('student_email', studentEmail);
            if (teacherEmail) query = query.eq('quizzes.teacher_email', teacherEmail);
            if (status) query = query.eq('status', status);

            return this._getPaginated(query.order('started_at', { ascending: false }), options);
        });
    }

    static async saveQuizSubmission(submission) {
        let data;
        if (submission.id) {
            // Use _update instead of _upsert when id is present to avoid 401 errors
            // for users (like teachers) who have UPDATE but not INSERT permissions.
            data = await this._update('quiz_submissions', submission, { id: submission.id });
        } else {
            // Initial student attempt start
            data = await this._upsert('quiz_submissions', submission, 'quiz_id,student_email,attempt_number');
        }
        _cache.invalidate('quiz_submissions');
        return data?.[0] || null;
    }

    static async getQuizSubmissionById(id) {
        return this._request(async () => {
            const { data, error } = await supabaseClient
                .from('quiz_submissions')
                .select('*')
                .eq('id', id)
                .single();
            if (error) throw error;
            return data;
        });
    }

    static async authenticateUser(email, passwordHash, sessionId) {
        const { data, error } = await supabaseClient.rpc('authenticate_user', {
            p_email: email,
            p_password_hash: passwordHash,
            p_session_id: sessionId
        });
        if (error) throw error;
        return data;
    }

    /**
     * Finalizes the password reset process by atomically updating the password
     * and clearing the reset request state in the database.
     */
    static async finalizePasswordReset(email, passwordHash, sessionId) {
        return this._request(async () => {
            const { data, error } = await supabaseClient.rpc('finalize_password_reset_secure', {
                p_email: email,
                p_new_password_hash: passwordHash,
                p_session_id: sessionId
            });
            if (error) throw error;
            return data;
        });
    }

    /**
     * Approves a pending password reset request.
     * Generates a temporary password and updates the user's secret.
     */
    static async approvePasswordReset(email) {
        const normalizedEmail = normalizeEmail(email);
        const user = await this.getUser(normalizedEmail, true);
        if (!user || !user.reset_request) {
            throw new Error('No pending reset request found for this user.');
        }

        const tempPassword = window.generateTempPassword();
        const hashedTemp = await window.hashPassword(tempPassword, normalizedEmail);

        // Update the user record with the approval details
        const updatedUser = {
            ...user,
            password: hashedTemp,
            reset_request: {
                ...user.reset_request,
                status: 'approved',
                expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
            },
            reset_data: {
                temp_password: hashedTemp,
                temp_password_plain: tempPassword
            }
        };

        // saveUser handles both the sanitized users table update and the secure secrets update
        await this.saveUser(updatedUser);
        return tempPassword;
    }

    /**
     * Denies a pending password reset request.
     */
    static async denyPasswordReset(email, reason) {
        const normalizedEmail = normalizeEmail(email);
        const user = await this.getUser(normalizedEmail, true);
        if (!user || !user.reset_request) {
            throw new Error('No pending reset request found for this user.');
        }

        const updatedUser = {
            ...user,
            reset_request: {
                ...user.reset_request,
                status: 'denied',
                denial_reason: reason
            }
        };

        await this.saveUser(updatedUser);
    }

    static async requestPasswordReset(email, reason, customReason = '') {
        const { data, error } = await supabaseClient.rpc('request_password_reset_secure', {
            p_email: email,
            p_reason: reason,
            p_custom_reason: customReason
        });
        if (error) throw error;
        return data;
    }

    static async invokeFunction(name, payload) {
        const { data, error } = await supabaseClient.functions.invoke(name, {
            body: payload
        });
        if (error) throw error;
        return data;
    }

    // Notification operations
    static async createNotification(userEmail, title, message, link = null, type = 'system') {
        const { error } = await supabaseClient.rpc('notify_user', {
            p_email: userEmail,
            p_title: title,
            p_message: message,
            p_link: link,
            p_type: type
        });
        if (error) throw error;
        _cache.invalidate(`notifications_${userEmail}`);
    }

    static async getNotifications(userEmail, options = {}) {
        return _cache.fetch(`notifications_${userEmail}`, async () => {
            return this._request(async () => {
                const { data, count, error } = await supabaseClient
                    .from('notifications')
                    .select('*', { count: 'exact' })
                    .eq('user_email', userEmail)
                    .order('created_at', { ascending: false });
                if (error) throw error;
                return { data: data || [], total: count || 0 };
            });
        });
    }

    static async getBroadcasts(options = {}) {
        return _cache.fetch(`broadcasts_active`, async () => {
            return this._request(async () => {
                const { data, count, error } = await supabaseClient
                    .from('broadcasts')
                    .select('*', { count: 'exact' })
                    .gt('expires_at', new Date().toISOString())
                    .order('created_at', { ascending: false });
                if (error) throw error;
                return { data: data || [], total: count || 0 };
            });
        });
    }

    static async deleteExpiredBroadcasts() {
        const { error } = await supabaseClient
            .from('broadcasts')
            .delete()
            .lt('expires_at', new Date().toISOString());
        if (error) throw error;
    }

    /**
     * Centralized broadcast creation via secure SQL RPC.
     * Enforces business logic (role normalization, expiry) server-side.
     */
    static async createBroadcast(params) {
        return this._request(async () => {
            const { error } = await supabaseClient.rpc('create_broadcast', {
                p_course_id: params.courseId || null,
                p_target_role: params.targetRole || null,
                p_title: params.title,
                p_message: params.message,
                p_link: params.link || null,
                p_type: params.type || 'system',
                p_expires_in: params.expiresInDays ? `${params.expiresInDays} days` : '30 days'
            });
            if (error) throw error;
            _cache.invalidate('broadcasts_active');
            return true;
        });
    }


    static async updateMetadataAtomic(email, key, value, operation) {
        const { error } = await supabaseClient.rpc('update_user_metadata_atomic', {
            p_email: email,
            p_key: key,
            p_value: value,
            p_operation: operation
        });
        if (error) throw error;
        _cache.invalidate(`user_${email}`);
    }

    static async markNotificationsAsRead(userEmail, id = null) {
        const query = supabaseClient
            .from('notifications')
            .update({ is_read: true })
            .eq('user_email', userEmail);

        if (id) {
            query.eq('id', id);
        } else {
            query.eq('is_read', false);
        }

        const { error } = await query;
        if (error) throw error;
        _cache.invalidate(`notifications_${userEmail}`);
        _cache.invalidate('notifications');
    }

    static async deleteNotifications(userEmail) {
        const { error } = await supabaseClient
            .from('notifications')
            .delete()
            .eq('user_email', userEmail);
        if (error) throw error;
        _cache.invalidate(`notifications_${userEmail}`);
    }

    static async invalidateCache(key = null) {
        _cache.invalidate(key);
    }

    // Certificate operations
    static async issueCertificate(certificate) {
        const user = await SessionManager.getCurrentUser();
        const payload = {
            ...certificate,
            teacher_email: user.email,
            status: certificate.status || 'pending_approval',
            type: certificate.type || 'single'
        };
        const data = await this._upsert('certificates', payload);

        // Notify admins for approval
        if (payload.status === 'pending_approval') {
            try {
                const admins = await this.getAdmins();
                for (const admin of admins) {
                    await this.createNotification(
                        admin.email,
                        'Certificate Approval Required',
                        `Teacher ${user.full_name} issued a certificate to ${certificate.student_email}. Approval needed.`,
                        null,
                        'cert_issued'
                    );
                }
            } catch (e) {
                console.warn('Failed to notify admins of certificate issuance:', e);
            }
        }

        _cache.invalidate('certificates');
        return data?.[0];
    }

    static async requestCertificate(studentEmail, courseId, reason) {
        if (courseId === 'all') {
            const enrollRes = await this.getEnrollments(studentEmail);
            const enrollments = enrollRes.data || [];
            const results = [];
            const teacherNotifications = {}; // Map of teacherEmail -> list of course titles

            // 1. Handle individual course certificate requests
            for (const e of enrollments) {
                const id = e.course_id;
                const courseTitle = e.courses?.title || 'Unknown Course';
                const teacherEmail = e.courses?.teacher_email;

                const { data: existing } = await supabaseClient
                    .from('certificates')
                    .select('id, status')
                    .match({ student_email: studentEmail, course_id: id, type: 'single' })
                    .maybeSingle();

                if (!existing || existing.status === 'rejected' || existing.status === 'requested') {
                    const payload = {
                        id: existing?.id || crypto.randomUUID(),
                        student_email: studentEmail,
                        course_id: id,
                        request_reason: reason,
                        status: 'requested',
                        type: 'single'
                    };
                    const res = await this._upsert('certificates', payload);
                    if (res && res[0]) results.push(res[0]);

                    // Queue notification for teacher
                    if (teacherEmail) {
                        if (!teacherNotifications[teacherEmail]) teacherNotifications[teacherEmail] = [];
                        teacherNotifications[teacherEmail].push(courseTitle);
                    }
                }
            }

            // Send grouped notifications to teachers to avoid redundancy and ensure they only see their own courses
            for (const [tEmail, titles] of Object.entries(teacherNotifications)) {
                try {
                    const message = titles.length === 1
                        ? `Student ${studentEmail} requested a certificate for your course "${titles[0]}".`
                        : `Student ${studentEmail} requested certificates for ${titles.length} of your courses: ${titles.join(', ')}.`;

                    await this.createNotification(
                        tEmail,
                        'New Certificate Request(s)',
                        message,
                        'teacher.html?page=certificates',
                        'cert_requested'
                    );
                } catch (err) {
                    console.warn(`Failed to notify teacher ${tEmail}:`, err);
                }
            }

            // 2. Handle the master consolidated certificate request (For Student Dashboard and Admin approval)
            const { data: existingMaster } = await supabaseClient
                .from('certificates')
                .select('id, status')
                .match({ student_email: studentEmail, type: 'consolidated' })
                .maybeSingle();

            if (!existingMaster || existingMaster.status === 'rejected' || existingMaster.status === 'requested') {
                const masterPayload = {
                    id: existingMaster?.id || crypto.randomUUID(),
                    student_email: studentEmail,
                    course_id: null,
                    request_reason: reason,
                    status: 'requested',
                    type: 'consolidated'
                };
                await this._upsert('certificates', masterPayload);
            }

            _cache.invalidate('certificates');
            return results;
        }

        const payload = {
            student_email: studentEmail,
            course_id: courseId,
            request_reason: reason,
            status: 'requested',
            type: 'single'
        };
        const data = await this._upsert('certificates', payload);

        // Notify the course teacher
        try {
            const course = await this.getCourse(courseId);
            if (course && course.teacher_email) {
                await this.createNotification(
                    course.teacher_email,
                    'New Certificate Request',
                    `Student ${studentEmail} requested a certificate for your course "${course.title}".`,
                    'teacher.html?page=certificates',
                    'cert_requested'
                );
            }
        } catch (e) {
            console.warn('Failed to notify teacher of certificate request:', e);
        }

        _cache.invalidate('certificates');
        return data?.[0];
    }

    static async updateCertificateStatus(certId, status, metadata = {}) {
        const { data: cert } = await supabaseClient.from('certificates').select('*').eq('id', certId).single();
        const data = await this._update('certificates', {
            status,
            metadata: { ...(cert?.metadata || {}), ...metadata },
            updated_at: new Date().toISOString()
        }, { id: certId });

        // Notify student
        let title, type;
        if (status === 'approved') { title = 'Certificate Approved'; type = 'cert_approved'; }
        else if (status === 'rejected') { title = 'Certificate Request Rejected'; type = 'cert_rejected'; }

        if (title && cert) {
            await this.createNotification(
                cert.student_email,
                title,
                status === 'approved' ? 'Your certificate is ready for download.' : `Your certificate request was rejected. Reason: ${metadata.reason || 'None provided'}`,
                null,
                type
            );
        }

        _cache.invalidate('certificates');
        return data;
    }

    static async updateCertificate(certId, payload) {
        const data = await this._update('certificates', {
            ...payload,
            updated_at: new Date().toISOString()
        }, { id: certId });
        _cache.invalidate('certificates');
        return data;
    }

    static async deleteCertificate(certId) {
        const { data: cert } = await supabaseClient.from('certificates').select('*').eq('id', certId).single();
        if (cert && cert.certificate_url) {
            await this.deleteFileByUrl(cert.certificate_url);
        }
        const { error } = await supabaseClient.from('certificates').delete().eq('id', certId);
        if (error) throw error;
        _cache.invalidate('certificates');
        return true;
    }

    static async getCertificates(studentEmail = null, teacherEmail = null, options = {}) {
        return this._request(async () => {
            let query = supabaseClient.from('certificates').select('*, courses(*), users!student_email(full_name)', { count: 'exact' });
            if (studentEmail) query = query.eq('student_email', studentEmail);
            if (teacherEmail) query = query.eq('teacher_email', teacherEmail);

            return this._getPaginated(query.order('updated_at', { ascending: false }), options);
        });
    }

    static async verifyCertificate(verificationId) {
        return this._request(async () => {
            const { data, error } = await supabaseClient.rpc('verify_certificate', {
                p_verification_id: verificationId
            });
            if (error) throw error;
            return data;
        });
    }

    // Planner operations
    static async getPlannerItems(email, options = {}) {
        return this._request(async () => {
            const { data, count, error } = await supabaseClient
                .from('planner')
                .select('*', { count: 'exact' })
                .eq('user_email', email)
                .order('due_date', { ascending: true });
            if (error) throw error;
            return { data: data || [], total: count || 0 };
        });
    }

    static async savePlannerItem(item) {
        const data = await this._upsert('planner', item);
        _cache.invalidate('planner');
        return data?.[0];
    }

    static async deletePlannerItem(id) {
        const { error } = await supabaseClient
            .from('planner')
            .delete()
            .eq('id', id);
        if (error) throw error;
        _cache.invalidate('planner');
    }

    /**
     * Internal helper to fetch ALL records for a query by automatically handling pagination.
     * Bypasses the default 1000-record limit.
     */
    static async _getAll(query) {
        return this._request(async () => {
            let allData = [];
            let page = 0;
            const pageSize = 1000;
            let hasMore = true;

            while (hasMore) {
                const from = page * pageSize;
                const to = from + pageSize - 1;
                const { data, error } = await query.range(from, to);

                if (error) throw error;
                if (data && data.length > 0) {
                    allData = allData.concat(data);
                    hasMore = data.length === pageSize;
                    page++;
                } else {
                    hasMore = false;
                }
            }
            return allData;
        });
    }

    // Backup helper with robust pagination support and dynamic ordering
    static async getAllTableData(table, orderBy = 'created_at') {
        return this._request(async () => {
            let orderCol = orderBy;
            let allData = [];
            let page = 0;
            const pageSize = 1000;
            let hasMore = true;

            while (hasMore) {
                const from = page * pageSize;
                const to = from + pageSize - 1;

                let query = supabaseClient.from(table).select('*').range(from, to);

                // Add stable ordering if we haven't determined the column is missing
                if (orderCol) {
                    query = query.order(orderCol, { ascending: true, nullsFirst: true });
                }

                let { data, error } = await query;

                // Handle missing column errors for ordering
                if (error && (error.code === 'PGRST100' || error.message?.includes('column') || error.message?.includes('order'))) {
                    orderCol = null; // Disable ordering for subsequent pages of this table
                    const retry = await supabaseClient.from(table).select('*').range(from, to);
                    data = retry.data;
                    error = retry.error;
                }

                if (error) throw error;

                if (data && data.length > 0) {
                    allData = allData.concat(data);
                    if (data.length < pageSize) {
                        hasMore = false;
                    } else {
                        page++;
                    }
                } else {
                    hasMore = false;
                }
            }

            return allData;
        });
    }

    // Study session operations
    static async saveStudySession(session) {
        const data = await this._upsert('study_sessions', session);
        _cache.invalidate('study_sessions');
        return data?.[0];
    }

    static async getStudySessions(email = null, options = {}) {
        return this._request(async () => {
            let query = supabaseClient.from('study_sessions').select('*', { count: 'exact' });
            if (email) query = query.eq('user_email', email);

            return this._getPaginated(query.order('started_at', { ascending: false }), options);
        });
    }

    // Live Class operations
    static async getLiveClasses(courseId = null, teacherEmail = null, courseIds = null, options = {}) {
        if (courseIds && courseIds.length === 0) return { data: [], total: 0 };
        return this._request(async () => {
            let query = supabaseClient.from('live_classes').select('*', { count: 'exact' });
            if (courseId) query = query.eq('course_id', courseId);
            if (teacherEmail) query = query.eq('teacher_email', teacherEmail);
            if (courseIds && courseIds.length > 0) query = query.in('course_id', courseIds);

            const { data, count, error } = await query
                .order('start_at', { ascending: true });
            if (error) throw error;
            return { data: data || [], total: count || 0 };
        });
    }

    static async getLiveClass(id) {
        const { data, error } = await supabaseClient
            .from('live_classes')
            .select('*')
            .eq('id', id)
            .single();
        if (error && error.code !== 'PGRST116') throw error;
        return data;
    }

    static async saveLiveClass(liveClass) {
        const data = await this._upsert('live_classes', liveClass);
        _cache.invalidate('live_classes');
        return data?.[0];
    }

    static async deleteLiveClass(id) {
        try {
            const lc = await this.getLiveClass(id);
            if (lc && lc.recording_url) {
                await this.deleteFileByUrl(lc.recording_url);
            }
        } catch (e) { console.warn('Failed to cleanup live class recording:', e); }

        const { error } = await supabaseClient
            .from('live_classes')
            .delete()
            .eq('id', id);
        if (error) throw error;
        _cache.invalidate('live_classes');
    }

    static async saveAttendance(attendance) {
        // Use 'id' as onConflict if present to support administrative restoration/updates,
        // otherwise fallback to the natural composite key.
        const onConflict = attendance.id ? 'id' : 'live_class_id,student_email';
        const data = await this._upsert('attendance', attendance, onConflict);
        _cache.invalidate('attendance');
        return data?.[0];
    }

    static async getAttendance(classId = null, studentEmail = null, options = {}) {
        return this._request(async () => {
            let query = supabaseClient
                .from('attendance')
                .select('*, live_classes(title), courses(title)', { count: 'exact' });

            if (classId) query = query.eq('live_class_id', classId);
            if (studentEmail) query = query.eq('student_email', studentEmail);

            return this._getPaginated(query.order('join_time', { ascending: false }), options);
        });
    }

    // Maintenance operations
    static async getMaintenance(bypassCache = false) {
        if (bypassCache) _cache.invalidate('maintenance');
        return _cache.fetch('maintenance', async () => {
            return this._request(async () => {
                // Singleton robustness: multiple maintenance rows may exist after restoration
                // We take the most recently updated one to ensure continuity.
                const { data, error } = await supabaseClient
                    .from('maintenance')
                    .select('*')
                    .order('updated_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                if (error && error.code !== 'PGRST116') throw error;
                return data || { enabled: false, schedules: [] };
            });
        });
    }

    static async saveMaintenance(maintenance) {
        const data = await this._upsert('maintenance', maintenance);
        _cache.invalidate('maintenance');
        return data?.[0];
    }

    // Invite operations
    static async saveInvite(invite) {
        // Use 'id' as onConflict if present to support administrative restoration/updates,
        // otherwise fallback to the unique token for standard invitation generation.
        const onConflict = invite.id ? 'id' : 'token';
        const data = await this._upsert('invites', invite, onConflict);
        _cache.invalidate('invites');
        return data?.[0];
    }

    static async getInvite(token) {
        const { data, error } = await supabaseClient
            .from('invites')
            .select('*')
            .eq('token', token)
            .maybeSingle();
        if (error) throw error;
        return data;
    }

    static async markInviteUsed(token) {
        const { error } = await supabaseClient
            .from('invites')
            .update({ used_at: new Date().toISOString() })
            .eq('token', token);
        if (error) throw error;
        _cache.invalidate('invites');
    }

    static async deleteInvite(token) {
        const { error } = await supabaseClient
            .from('invites')
            .delete()
            .eq('token', token);
        if (error) throw error;
        _cache.invalidate('invites');
    }

    // Support Ticket operations
    static async saveSupportTicket(ticket) {
        if (!ticket.id) {
            // Create new ticket (Student/Teacher action)
            // Use insert instead of upsert to avoid unauthorized 401 error on SELECT/ON CONFLICT check caused by strict RLS
            const sanitized = this._sanitizePayload(ticket);
            return this._request(async () => {
                const { data, error } = await supabaseClient
                    .from('support_tickets')
                    .insert([sanitized])
                    .select();
                if (error) throw error;
                _cache.invalidate('support_tickets');
                return data?.[0];
            });
        }

        const data = await this._upsert('support_tickets', ticket);
        _cache.invalidate('support_tickets');
        return data?.[0];
    }


    static async getSupportTickets(userEmail = null, options = {}) {
        const { status = null } = options;
        return this._request(async () => {
            let query = supabaseClient.from('support_tickets').select('*', { count: 'exact' });
            if (userEmail) query = query.eq('user_email', userEmail);
            if (status) query = query.eq('status', status);

            return this._getPaginated(query.order('created_at', { ascending: false }), options);
        });
    }

    // Violation operations
    static async saveViolation(violation) {
        const sanitized = this._sanitizePayload(violation);
        return this._request(async () => {
            const { data, error } = await supabaseClient
                .from('violations')
                .insert([sanitized])
                .select();
            if (error) throw error;
            _cache.invalidate('violations');
            return data?.[0];
        });
    }

    static async getViolations(assessmentId = null, userEmail = null, teacherEmail = null, options = {}) {
        const { assessmentType = null, severity = null } = options;
        return this._request(async () => {
            let query = supabaseClient.from('violations').select('*', { count: 'exact' });

            if (teacherEmail) {
                // Get teacher's course IDs first
                const coursesRes = await this.getCourses(teacherEmail, null);
                const courseIds = (coursesRes.data || []).map(c => c.id);
                if (courseIds.length === 0) return { data: [], total: 0 };

                // Get assignments and quizzes for these courses
                const [assignsRes, quizzesRes] = await Promise.all([
                    this.getAssignments(null, null, courseIds),
                    this.getQuizzes(null, null, courseIds)
                ]);
                const assessmentIds = [...(assignsRes.data || []).map(a => a.id), ...(quizzesRes.data || []).map(q => q.id)];
                if (assessmentIds.length === 0) return { data: [], total: 0 };

                query = query.in('assessment_id', assessmentIds);
            }

            if (assessmentId) query = query.eq('assessment_id', assessmentId);
            if (userEmail) query = query.eq('user_email', userEmail);
            if (assessmentType) query = query.eq('assessment_type', assessmentType);
            if (severity) query = query.eq('severity', severity);

            return this._getPaginated(query.order('timestamp', { ascending: false }), options);
        });
    }

    static async deleteViolations(assessmentId = null, userEmail = null) {
        return this._request(async () => {
            let filters = {};
            if (assessmentId) filters.assessment_id = assessmentId;
            if (userEmail) filters.user_email = userEmail;

            // Security: Add teacher filter if current user is teacher to ensure RLS compliance and safety
            try {
                const currentUser = await SessionManager.getCurrentUser();
                if (currentUser?.role === 'teacher') {
                    filters.teacher_email = currentUser.email;
                }
            } catch(e) {}

            const { error } = await supabaseClient
                .from('violations')
                .delete()
                .match(filters);

            if (error) throw error;
            _cache.invalidate('violations');
        });
    }

    static async getStudentViolationSummary(studentEmail) {
        const { data: violations, error } = await supabaseClient
            .from('violations')
            .select('assessment_id, assessment_type, type, severity, score')
            .eq('user_email', studentEmail);

        if (error) throw error;

        const assessmentIds = [...new Set((violations || []).map(v => v.assessment_id))];
        if (assessmentIds.length === 0) return { data: [], total: 0 };

        const [assignsRes, quizzesRes] = await Promise.all([
            supabaseClient.from('assignments').select('id, title').in('id', assessmentIds),
            supabaseClient.from('quizzes').select('id, title').in('id', assessmentIds)
        ]);

        const summaryMap = {};
        (violations || []).forEach(v => {
            const key = v.assessment_id;
            if (!summaryMap[key]) {
                const assessment = [...(assignsRes.data || []), ...(quizzesRes.data || [])].find(a => a.id === key);
                summaryMap[key] = {
                    id: key,
                    title: assessment?.title || 'Unknown Assessment',
                    type: v.assessment_type,
                    violationCount: 0,
                    totalScore: 0,
                    criticalCount: 0
                };
            }
            summaryMap[key].violationCount++;
            summaryMap[key].totalScore += (v.score || 0);
            if (v.severity === 'CRITICAL') summaryMap[key].criticalCount++;
        });

        const result = Object.values(summaryMap);
        return { data: result, total: result.length };
    }

    static async getViolationSummary(teacherEmail) {
        const coursesRes = await this.getCourses(teacherEmail, null);
        const courseIds = (coursesRes.data || []).map(c => c.id);
        if (courseIds.length === 0) return { data: [], total: 0 };

        const [assignsRes, quizzesRes] = await Promise.all([
            this.getAssignments(null, null, courseIds),
            this.getQuizzes(null, null, courseIds)
        ]);
        const assessmentIds = [...(assignsRes.data || []).map(a => a.id), ...(quizzesRes.data || []).map(q => q.id)];
        if (assessmentIds.length === 0) return { data: [], total: 0 };

        // PostgREST doesn't support complex aggregation well, so we fetch and aggregate in JS for now
        // This is safe for thousands of records as it's just the violations table
        const { data, error } = await supabaseClient
            .from('violations')
            .select('assessment_id, assessment_type, user_email, type, severity, score')
            .in('assessment_id', assessmentIds);

        if (error) throw error;

        const summaryMap = {};
        (data || []).forEach(v => {
            const key = v.assessment_id;
            if (!summaryMap[key]) {
                const assessment = [...(assignsRes.data || []), ...(quizzesRes.data || [])].find(a => a.id === key);
                summaryMap[key] = {
                    id: key,
                    title: assessment?.title || 'Unknown',
                    type: v.assessment_type,
                    violationCount: 0,
                    studentCount: new Set(),
                    totalScore: 0,
                    criticalCount: 0
                };
            }
            summaryMap[key].violationCount++;
            summaryMap[key].studentCount.add(v.user_email);
            summaryMap[key].totalScore += (v.score || 0);
            if (v.severity === 'CRITICAL') summaryMap[key].criticalCount++;
        });

        const result = Object.values(summaryMap).map(s => ({
            ...s,
            studentCount: s.studentCount.size
        }));

        return { data: result, total: result.length };
    }

    // Storage operations
    static async uploadFile(bucket, path, file) {
        const { data, error } = await supabaseClient.storage
            .from(bucket)
            .upload(path, file, { upsert: true });
        if (error) throw error;
        return data;
    }

    static async getPublicUrl(bucket, path) {
        const { data } = supabaseClient.storage
            .from(bucket)
            .getPublicUrl(path);
        return data.publicUrl;
    }

    static async deleteFile(bucket, path) {
        const { error } = await supabaseClient.storage
            .from(bucket)
            .remove([path]);
        if (error) throw error;
    }

    static async deleteFileByUrl(url) {
        if (!url) return;
        try {
            // URL format: https://[project].supabase.co/storage/v1/object/public/[bucket]/[path]
            const parts = url.split('/storage/v1/object/public/');
            if (parts.length < 2) return;
            const pathParts = parts[1].split('/');
            const bucket = pathParts.shift();
            const path = pathParts.join('/');
            if (bucket && path) {
                await this.deleteFile(bucket, path);
            }
        } catch (e) {
            console.warn('Failed to parse and delete file from URL:', url, e);
        }
    }
}

// Session management
class SessionManager {
    static async setCurrentUser(user) {
        sessionStorage.setItem('currentUser', JSON.stringify(user));
    }

    static async getCurrentUser() {
        const raw = sessionStorage.getItem('currentUser');
        return raw ? JSON.parse(raw) : null;
    }

    static async clearCurrentUser(reason = null) {
        const user = await this.getCurrentUser();
        if (reason && user) {
            try {
                // Optimization: Use locally available user data and avoid redundant getUser/saveUser overhead
                const newMetadata = { ...(user.metadata || {}), last_invalidation_reason: reason };
                const newSid = 'invalidated_' + Date.now() + '_' + reason;

                // Update server-side session state in parallel to minimize network delay
                await SupabaseDB._request(async () => {
                    await Promise.all([
                        supabaseClient.from('users').update({ metadata: newMetadata }).eq('email', user.email),
                        supabaseClient.rpc('update_user_secret_secure', {
                            p_email: user.email,
                            p_session_id: newSid
                        })
                    ]);
                });
            } catch (e) {
                console.warn('Failed to set invalidation reason on server:', e);
            }
        }

        sessionStorage.removeItem('currentUser');
        sessionStorage.removeItem('sessionId');
        if (typeof window.setSupabaseSession === 'function') {
            window.setSupabaseSession(null);
        }
        // Purge memory cache to ensure no data leaks to the next session
        if (typeof SupabaseDB !== 'undefined' && SupabaseDB.invalidateCache) {
            SupabaseDB.invalidateCache();
        }
    }

    static getSessionId(force = false) {
        if (force) {
            sessionStorage.removeItem('sessionId');
        }
        let sid = sessionStorage.getItem('sessionId');
        if (!sid) {
            sid = 's_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            sessionStorage.setItem('sessionId', sid);
        }
        return sid;
    }
}

window.SupabaseDB = SupabaseDB;
window.SessionManager = SessionManager;
