/**
 * Configuration for system-wide backups and restorations.
 *
 * REFERENTIAL INTEGRITY & ORDERING:
 * - Restoration Order: Defined by the sequence in BACKUP_CONFIG.tables. This follows a strict
 *   topological sort (parents before children) to satisfy foreign key constraints.
 * - Export Order: Defined by 'requestedOrder' in exportBackup(), matching the user-requested JSON format.
 *
 * CONFLICT RESOLUTION & REMAPPING:
 * - 'onConflict' targets 'id' for most tables to preserve UUID-based relationships.
 * - For natural-key tables (e.g., 'users' via email), surrogate 'id' is stripped during import
 *   to allow seamless updates of existing records and clean insertion of new ones without collisions.
 */
const BACKUP_CONFIG = {
    version: '1.1.1',
    // Topological order for safe restoration (FK-aware)
    tables: [
        { name: 'users', onConflict: 'email', orderBy: 'email', dependencies: [] },
        { name: 'user_secrets', optional: true, onConflict: 'email', orderBy: 'email', dependencies: [{ table: 'users', field: 'email' }] },
        { name: 'maintenance', onConflict: 'id', orderBy: 'id', dependencies: [] },
        { name: 'support_tickets', onConflict: 'id', orderBy: 'created_at', dependencies: [{ table: 'users', field: 'user_email', optional: true }] },
        { name: 'invites', onConflict: 'token', orderBy: 'token', dependencies: [{ table: 'users', field: 'created_by', optional: true }] },
        { name: 'courses', onConflict: 'id', orderBy: 'id', dependencies: [{ table: 'users', field: 'teacher_email', optional: true }] },
        { name: 'live_classes', onConflict: 'id', orderBy: 'start_at', dependencies: [{ table: 'courses', field: 'course_id' }, { table: 'users', field: 'teacher_email', optional: true }] },
        { name: 'planner', optional: true, onConflict: 'id', orderBy: 'due_date', dependencies: [{ table: 'users', field: 'user_email' }] },
        { name: 'notifications', onConflict: 'id', orderBy: 'created_at', dependencies: [{ table: 'users', field: 'user_email' }] },
        { name: 'assignments', onConflict: 'id', orderBy: 'due_date', dependencies: [{ table: 'courses', field: 'course_id' }, { table: 'users', field: 'teacher_email', optional: true }] },
        { name: 'materials', onConflict: 'id', orderBy: 'created_at', dependencies: [{ table: 'courses', field: 'course_id' }, { table: 'users', field: 'teacher_email', optional: true }] },
        { name: 'topics', onConflict: 'id', orderBy: 'order_index', dependencies: [{ table: 'courses', field: 'course_id' }, { table: 'users', field: 'teacher_email', optional: true }] },
        { name: 'lessons', onConflict: 'id', orderBy: 'order_index', dependencies: [{ table: 'courses', field: 'course_id' }, { table: 'topics', field: 'topic_id', optional: true }, { table: 'users', field: 'teacher_email', optional: true }] },
        { name: 'quizzes', onConflict: 'id', orderBy: 'created_at', dependencies: [{ table: 'courses', field: 'course_id' }, { table: 'users', field: 'teacher_email', optional: true }] },
        { name: 'enrollments', onConflict: 'course_id,student_email', orderBy: 'enrolled_at', dependencies: [{ table: 'courses', field: 'course_id' }, { table: 'users', field: 'student_email' }] },
        { name: 'attendance', onConflict: 'live_class_id,student_email', orderBy: 'join_time', dependencies: [{ table: 'live_classes', field: 'live_class_id' }, { table: 'users', field: 'student_email' }, { table: 'users', field: 'teacher_email', optional: true }, { table: 'courses', field: 'course_id', optional: true }] },
        { name: 'study_sessions', onConflict: 'id', orderBy: 'started_at', dependencies: [{ table: 'users', field: 'user_email' }, { table: 'courses', field: 'course_id' }, { table: 'users', field: 'teacher_email', optional: true }] },
        { name: 'submissions', onConflict: 'assignment_id,student_email', orderBy: 'submitted_at', dependencies: [{ table: 'assignments', field: 'assignment_id' }, { table: 'users', field: 'student_email' }, { table: 'users', field: 'teacher_email', optional: true }, { table: 'courses', field: 'course_id', optional: true }] },
        { name: 'quiz_submissions', onConflict: 'quiz_id,student_email,attempt_number', orderBy: 'started_at', dependencies: [{ table: 'quizzes', field: 'quiz_id' }, { table: 'users', field: 'student_email' }, { table: 'users', field: 'teacher_email', optional: true }, { table: 'courses', field: 'course_id', optional: true }] },
        { name: 'broadcasts', optional: true, onConflict: 'id', orderBy: 'created_at', dependencies: [{ table: 'courses', field: 'course_id', optional: true }, { table: 'users', field: 'teacher_email', optional: true }] },
        { name: 'violations', onConflict: 'id', orderBy: 'timestamp', dependencies: [{ table: 'courses', field: 'course_id' }, { table: 'users', field: 'user_email' }, { table: ['assignments', 'quizzes'], field: 'assessment_id' }, { table: 'users', field: 'teacher_email', optional: true }] },
        { name: 'certificates', onConflict: 'id', orderBy: 'issued_at', dependencies: [{ table: 'courses', field: 'course_id' }, { table: 'users', field: 'student_email' }, { table: 'users', field: 'teacher_email', optional: true }] },
        { name: 'discussions', onConflict: 'id', orderBy: 'created_at', dependencies: [{ table: 'courses', field: 'course_id' }, { table: 'users', field: 'user_email' }, { table: 'users', field: 'teacher_email', optional: true }, { table: 'discussions', field: 'parent_id', optional: true, self: true }] }
    ]
};

async function renderDashboard() {
  const renderId = ++window.currentRenderId;
  SupabaseDB.deleteExpiredBroadcasts().catch(e => console.warn('Cleanup error:', e));

  const content = document.getElementById('pageContent');
  if (!content) return;

  try {
    if (renderId !== window.currentRenderId) return;
    const [
      totalUsers,
      students,
      teachers,
      locked,
      flagged,
      pendingResets,
      assignments,
      submissions,
      pendingGrading,
      maintenance,
      courses,
      quizzes,
      enrollments,
      violations,
      openTickets
    ] = await Promise.all([
      SupabaseDB.getCount('users'),
      SupabaseDB.getCount('users', q => q.eq('role', 'student')),
      SupabaseDB.getCount('users', q => q.eq('role', 'teacher')),
      SupabaseDB.getCount('users', q => q.gt('locked_until', new Date().toISOString())),
      SupabaseDB.getCount('users', q => q.eq('flagged', true)),
      SupabaseDB.getCount('users', q => q.eq('reset_request->>status', 'pending')),
      SupabaseDB.getCount('assignments'),
      SupabaseDB.getCount('submissions'),
      SupabaseDB.getCount('submissions', q => q.or('status.eq.submitted,regrade_request.not.is.null')),
      SupabaseDB.getMaintenance(),
      SupabaseDB.getCount('courses'),
      SupabaseDB.getCount('quizzes'),
      SupabaseDB.getCount('enrollments'),
      SupabaseDB.getCount('violations'),
      SupabaseDB.getCount('support_tickets', q => q.or('status.eq.open,status.eq.pending'))
    ]);
    if (renderId !== window.currentRenderId) return;
    const stats = {
      totalUsers,
      students,
      teachers,
      locked,
      flagged,
      pendingResets,
      assignments,
      submissions,
      pendingGrading,
      courses,
      quizzes,
      enrollments,
      violations,
      openTickets,
      maintStatus: isActiveMaintenance(maintenance) ? 'Active' : 'Off'
    };

    content.innerHTML = `
    <div class="card">
      <h3 class="m-0 mb-15">Quick Broadcast</h3>
      <div class="grid-2">
        <input type="text" id="bcTitle" placeholder="Title" class="no-margin">
        <select id="bcRole" class="no-margin">
          <option value="all">All Users</option>
          <option value="student">Students</option>
          <option value="teacher">Teachers</option>
          <option value="admin">Admins</option>
        </select>
      </div>
      <div class="grid-2 mt-10">
        <textarea id="bcMsg" placeholder="Message content..." rows="2" class="no-margin"></textarea>
        <div class="flex-column gap-5">
            <label class="tiny m-0">Expiry (days)</label>
            <input type="number" id="bcExpiry" value="30" min="1" class="no-margin">
        </div>
      </div>
      <button class="button mt-10" onclick="broadcastNotif()">Send Broadcast</button>
    </div>

    <h3 class="mb-15 mt-30">Academic Management & Support</h3>
    <div class="stats-grid">
      <div class="stat-card" style="border-left-color: var(--p)">
        <h4>Students / Teachers</h4>
        <div class="value">${escapeHtml(stats.students)} / ${escapeHtml(stats.teachers)}</div>
      </div>
      <div class="stat-card"><h4>Active Courses</h4><div class="value">${escapeHtml(stats.courses)}</div></div>
      <div class="stat-card"><h4>Enrollments</h4><div class="value">${escapeHtml(stats.enrollments)}</div></div>
      <div class="stat-card" style="border-left-color: var(--warn)"><h4>Support Tickets</h4><div class="value">${escapeHtml(stats.openTickets)}</div></div>
    </div>

    <div class="stats-grid">
      <div class="stat-card"><h4>Assignments</h4><div class="value">${escapeHtml(stats.assignments)}</div></div>
      <div class="stat-card"><h4>Submissions</h4><div class="value">${escapeHtml(stats.submissions)}</div></div>
      <div class="stat-card" style="border-left-color: var(--warn)"><h4>Pending Grading</h4><div class="value">${escapeHtml(stats.pendingGrading)}</div></div>
      <div class="stat-card"><h4>Quizzes</h4><div class="value">${escapeHtml(stats.quizzes)}</div></div>
    </div>

    <h3 class="mb-15 mt-30">User Security & Integrity</h3>
    <div class="stats-grid">
      <div class="stat-card" style="border-left-color: var(--danger)"><h4>Locked Accounts</h4><div class="value">${escapeHtml(stats.locked)}</div></div>
      <div class="stat-card" style="border-left-color: var(--danger)"><h4>Flagged Accounts</h4><div class="value">${escapeHtml(stats.flagged)}</div></div>
      <div class="stat-card" style="border-left-color: var(--danger)"><h4>Security Resets</h4><div class="value">${escapeHtml(stats.pendingResets)}</div></div>
      <div class="stat-card" style="border-left-color: var(--danger)"><h4>Violations</h4><div class="value">${escapeHtml(stats.violations)}</div></div>
    </div>

    <h3 class="mb-15 mt-30">System Status</h3>
    <div class="stats-grid">
      <div class="stat-card" style="border-left-color: ${stats.maintStatus === 'Active' ? 'var(--warn)' : 'var(--ok)'}">
        <h4>Maintenance Mode</h4><div class="value">${escapeHtml(stats.maintStatus)}</div>
      </div>
      <div class="stat-card"><h4>API Success Rate</h4><div class="value">${escapeHtml(SupabaseDB.getStats().successRate)}%</div></div>
    </div>
    `;
  } catch (error) {
    console.error('Dashboard error:', error);
    content.innerHTML = `
    <div class="card" style="border-left: 4px solid var(--danger)">
      <h3>Error Loading Dashboard</h3>
      <p>Failed to retrieve system statistics. Please check your database connection.</p>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button" onclick="renderDashboard()" style="width:auto; margin-top:10px">Retry</button>
    </div>`;
  }
}

let allUsers = [];
let allTickets = [];
let filteredUsers = [];

let _coursePage = 1;
async function renderCourses(page = 1) {
  const renderId = ++window.currentRenderId;
  _coursePage = page;
  const content = document.getElementById('pageContent');
  if (!content) return;

  const pageSize = 20;

  try {
    if (renderId !== window.currentRenderId) return;
    const { data: courses, total } = await SupabaseDB.getCourses(null, null, { page, pageSize });
    if (renderId !== window.currentRenderId) return;

    content.innerHTML = `
    <section>
      <div class="flex-between mb-20">
        <h3 class="m-0">Global Course Management</h3>
        <div class="small text-muted">${total} Total Courses</div>
      </div>
      <div id="coursesTable"></div>
      <div id="coursesPagination"></div>
    </section>
    `;

    UI.renderTable('coursesTable', ['Title', 'Instructor', 'Status', 'Created At', 'Action'], courses, (c) => {
        let statusClass = 'badge-active';
        if (c.status === 'draft') statusClass = 'badge-warn';
        else if (c.status === 'archived') statusClass = 'badge-inactive';

        return `
            <tr>
              <td><div class="bold small">${escapeHtml(c.title)}</div></td>
              <td>
                <div class="small">${escapeHtml(c.created_by || 'N/A')}</div>
                <div class="tiny text-muted">${escapeHtml(c.teacher_email || 'No email')}</div>
              </td>
              <td><span class="badge ${statusClass}">${c.status.toUpperCase()}</span></td>
              <td>${c.created_at ? new Date(c.created_at).toLocaleDateString() : 'N/A'}</td>
              <td>
                <div class="flex gap-5">
                    <button class="button small w-auto" onclick="showChangeOwnerModal('${escapeAttr(c.id)}')">Change Owner</button>
                    <button class="button danger small w-auto" onclick="deleteCourse('${escapeAttr(c.id)}')">Delete</button>
                </div>
              </td>
            </tr>
        `;
    });

    UI.renderPagination('coursesPagination', total, page, pageSize, (newPage) => renderCourses(newPage));

  } catch (error) {
    console.error('Courses error:', error);
    content.innerHTML = `<div class="card danger-border"><h3>Error Loading Courses</h3><p class="small">${escapeHtml(error.message)}</p></div>`;
  }
}

async function deleteCourse(id) {
    if (!await UI.confirm('Are you sure you want to delete this course and all its content? This cannot be undone.', 'Delete Course')) return;
    try {
        await SupabaseDB.deleteCourse(id);
        UI.showNotification('Course deleted successfully.', 'success');
        renderCourses();
    } catch (e) {
        UI.showNotification('Failed to delete course: ' + e.message, 'error');
    }
}

async function showChangeOwnerModal(courseId) {
    const course = await SupabaseDB.getCourse(courseId);
    if (!course) return;

    const { data: teachers } = await SupabaseDB.getUsersByRole('teacher');

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.display = 'flex';
    backdrop.innerHTML = `
        <div class="modal" style="max-width:500px">
            <div class="flex-between mb-20">
                <h3 class="m-0">Change Course Owner</h3>
                <button class="button secondary tiny w-auto" onclick="this.closest('.modal-backdrop').remove()">✕</button>
            </div>
            <p class="small mb-15">Select a new instructor for <strong>${escapeHtml(course.title)}</strong>.</p>
            <div class="mb-20">
                <label class="tiny">Current Instructor:</label>
                <div class="card bg-light p-10 small">${escapeHtml(course.created_by)} (${escapeHtml(course.teacher_email)})</div>
            </div>
            <div class="mb-20">
                <label>Select New Instructor:</label>
                <select id="newTeacherSelect" class="w-100">
                    <option value="">-- Choose Teacher --</option>
                    ${teachers.map(t => `<option value="${escapeAttr(t.email)}" ${t.email === course.teacher_email ? 'disabled' : ''}>${escapeHtml(t.full_name)} (${escapeHtml(t.email)})</option>`).join('')}
                </select>
            </div>
            <div class="flex-end gap-10">
                <button class="button secondary w-auto" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
                <button class="button w-auto px-30" id="confirmChangeOwner">Update Owner</button>
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);

    document.getElementById('confirmChangeOwner').onclick = async () => {
        const newEmail = document.getElementById('newTeacherSelect').value;
        if (!newEmail) return UI.showNotification('Please select a teacher.', 'warn');

        try {
            // Only update teacher_email; created_by is handled by database trigger tr_course_teacher_name_sync
            await SupabaseDB.saveCourse({
                ...course,
                teacher_email: newEmail
            });
            UI.showNotification('Course owner updated successfully.', 'success');
            backdrop.remove();
            renderCourses();
        } catch (e) {
            UI.showNotification('Failed to update owner: ' + e.message, 'error');
        }
    };
}

window.renderCourses = renderCourses;
window.deleteCourse = deleteCourse;
window.showChangeOwnerModal = showChangeOwnerModal;

let _userSearchTimer = null;
let _userPage = 1;
async function renderUsers(isImmediate = false, page = 1) {
  if (!isImmediate) {
      clearTimeout(_userSearchTimer);
      _userSearchTimer = setTimeout(() => renderUsers(true, page), 300);
      return;
  }
  const renderId = ++window.currentRenderId;
  _userPage = page;

  const content = document.getElementById('pageContent');
  if (!content) return;

  const searchTerm = document.getElementById('userSearch')?.value || '';
  const roleFilter = document.getElementById('roleFilter')?.value || 'all';
  const statusFilter = document.getElementById('statusFilter')?.value || 'all';
  const pageSize = 24;

  // If the shell isn't already rendered, build it first
  if (!document.getElementById('usersList')) {
    content.innerHTML = `
    <section>
      <div class="controls-row">
        <input type="text" id="userSearch" class="search-input no-margin" placeholder="Search name/email..." value="${escapeAttr(searchTerm)}" oninput="renderUsers()">
        <select id="roleFilter" class="filter-select no-margin" onchange="renderUsers(true)">
          <option value="all" ${roleFilter === 'all' ? 'selected' : ''}>All Roles</option>
          <option value="student" ${roleFilter === 'student' ? 'selected' : ''}>Student</option>
          <option value="teacher" ${roleFilter === 'teacher' ? 'selected' : ''}>Teacher</option>
          <option value="admin" ${roleFilter === 'admin' ? 'selected' : ''}>Admin</option>
        </select>
        <select id="statusFilter" class="filter-select no-margin" onchange="renderUsers(true)">
          <option value="all" ${statusFilter === 'all' ? 'selected' : ''}>All Statuses</option>
          <option value="active" ${statusFilter === 'active' ? 'selected' : ''}>Active Only</option>
          <option value="inactive" ${statusFilter === 'inactive' ? 'selected' : ''}>Inactive Only</option>
          <option value="flagged" ${statusFilter === 'flagged' ? 'selected' : ''}>Flagged Only</option>
          <option value="locked" ${statusFilter === 'locked' ? 'selected' : ''}>Locked Only</option>
        </select>
        <button class="button secondary" style="width:auto;" onclick="exportUsersCSV()">Export CSV</button>
      </div>
      <div style="margin-bottom:20px; display:flex; gap:10px">
        <button class="button" onclick="showCreateUserForm()" style="width:auto; padding: 10px 30px">+ Add User</button>
        <button class="button" onclick="showInviteForm()" style="width:auto; padding: 10px 30px">✉️ Invite User</button>
      </div>
      
      <div id="usersList" class="grid"></div>
      <div id="usersPagination"></div>
    </section>
    `;
  }

  try {
    if (renderId !== window.currentRenderId) return;
    const { data: users, total } = await SupabaseDB.getUsers({
        searchTerm,
        role: roleFilter === 'all' ? null : roleFilter,
        status: statusFilter === 'all' ? null : statusFilter,
        page,
        pageSize
    });
    if (renderId !== window.currentRenderId) return;

    allUsers = users; // This only holds the current page now

    displayUsers(users, total, page, pageSize);
  } catch (error) {
    console.error('Users error:', error);
    const list = document.getElementById('usersList');
    const target = list || content;
    target.innerHTML = `
    <div class="card danger-border">
      <h3>Error Loading Users</h3>
      <p>Could not fetch user list from the server.</p>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button" onclick="renderUsers(true)" style="width:auto; margin-top:10px">Retry</button>
    </div>`;
  }
}


function displayUsers(users, total, page, pageSize) {
  const list = document.getElementById('usersList');
  if (!list) return;
  
  if (users.length === 0) {
      list.innerHTML = '<div class="empty">No users found matching your criteria.</div>';
      document.getElementById('usersPagination').innerHTML = '';
      return;
  }

  list.innerHTML = users.map(user => {
    const isLocked = isAccountLocked(user);
    const statusBadges = [];
    if (!user.active) statusBadges.push('<span class="badge badge-inactive">INACTIVE</span>');
    else statusBadges.push('<span class="badge badge-active">ACTIVE</span>');
    
    if (user.flagged) statusBadges.push('<span class="badge badge-flagged">FLAGGED</span>');
    if (isLocked) statusBadges.push('<span class="badge badge-lock">LOCKED</span>');

    return `
      <div class="card">
        <div class="user-header flex-between" style="margin-bottom:10px">
          <div class="user-title" style="font-weight:700">
            ${escapeHtml(user.full_name)} <span class="small">(${escapeHtml(user.role)}) - ${escapeHtml(user.email)}</span>
          </div>
          <div class="flex gap-10">${statusBadges.join('')}</div>
        </div>
        <div class="user-meta small" style="margin-bottom:15px">
          <div class="grid-2 gap-5">
            <div>Phone: ${escapeHtml(user.phone || 'N/A')}</div>
            <div>Failed Attempts: ${escapeHtml(user.failed_attempts || 0)}</div>
          </div>
          <div class="grid-2 gap-5 mt-5">
            <div>Joined: ${escapeHtml(user.created_at ? new Date(user.created_at).toLocaleDateString() : 'N/A')}</div>
            <div>Last Login: ${escapeHtml(user.last_login ? new Date(user.last_login).toLocaleDateString() : 'Never')}</div>
          </div>
          <div class="mt-5 text-muted tiny">
            ID: <code class="tiny">${escapeHtml(user.id)}</code> |
            Secrets: <span class="badge ${user.has_secret ? 'badge-active' : 'badge-warn'} tiny">${user.has_secret ? 'ESTABLISHED' : 'NONE'}</span>
          </div>
        </div>
        <div class="action-row flex" style="flex-wrap:wrap; gap:8px">
          <button class="button" style="width:auto; padding:6px 12px; font-size:12px" onclick="editUser('${escapeAttr(user.email)}')">Edit</button>
          <button class="button secondary" style="width:auto; padding:6px 12px; font-size:12px" onclick="toggleUserStatus('${escapeAttr(user.email)}', ${escapeAttr(user.active)})">
            ${user.active ? 'Deactivate' : 'Activate'}
          </button>
          <button class="button danger" style="width:auto; padding:6px 12px; font-size:12px" onclick="deleteUserByEmail('${escapeAttr(user.email)}')">Delete</button>
          <button class="button secondary" style="width:auto; padding:6px 12px; font-size:12px" onclick="lockUser('${escapeAttr(user.email)}', 30)">Lock 30m</button>
          <button class="button secondary" style="width:auto; padding:6px 12px; font-size:12px" onclick="lockUser('${escapeAttr(user.email)}', 1440)">Lock 24h</button>
          <button class="button" style="width:auto; padding:6px 12px; font-size:12px" onclick="unlockUser('${escapeAttr(user.email)}')">Unlock</button>
          <button class="button ${user.flagged ? '' : 'danger'}" style="width:auto; padding:6px 12px; font-size:12px" onclick="toggleUserFlag('${escapeAttr(user.email)}', ${escapeAttr(user.flagged)})">
            ${user.flagged ? 'Unflag' : 'Flag'}
          </button>
        </div>
      </div>
    `;
  }).join('');

  UI.renderPagination('usersPagination', total, page, pageSize, (newPage) => renderUsers(true, newPage));
}

// Ensure all handlers are global
window.renderDashboard = renderDashboard;
window.renderSupportTickets = renderSupportTickets;
window.renderInvites = renderInvites;
window.renderBroadcasts = renderBroadcasts;
window.renderUsers = renderUsers;
window.renderResets = renderResets;
window.renderViolations = renderViolations;
window.renderAnalytics = renderAnalytics;
window.renderReports = renderReports;

async function approveCert(certId) {
    if (!await UI.confirm('Are you sure you want to approve this certificate?')) return;
    try {
        const { data: cert } = await supabaseClient.from('certificates').select('*, courses(title), users!student_email(full_name)').eq('id', certId).single();
        if (!cert) throw new Error('Certificate not found');

        const verificationId = cert.metadata?.verification_id || crypto.randomUUID().slice(0, 13).toUpperCase();
        const issueDate = cert.issued_at || new Date().toISOString();
        const verificationUrl = `${window.location.origin}/index.html?page=verify&id=${verificationId}`;
        const teacher = cert.teacher_email ? await SupabaseDB.getUser(cert.teacher_email) : null;

        const doc = await CertificateGenerator.generatePDF(
            cert.users?.full_name || cert.student_email,
            cert.courses?.title || (cert.metadata?.course_title || 'Course Certificate'),
            issueDate,
            verificationId,
            {
                verificationUrl: verificationUrl,
                teacherName: teacher?.full_name,
                isApproved: true
            }
        );

        if (!doc) throw new Error('PDF Generation failed');

        const pdfBlob = doc.output('blob');
        const path = `certificates/${cert.student_email}/${cert.course_id || 'manual'}_${TimerManager.getTime()}.pdf`;

        if (cert.certificate_url) {
            await SupabaseDB.deleteFileByUrl(cert.certificate_url);
        }

        await SupabaseDB.uploadFile('certificates', path, pdfBlob);
        const certUrl = await SupabaseDB.getPublicUrl('certificates', path);

        await SupabaseDB.updateCertificate(certId, {
            certificate_url: certUrl,
            status: 'approved',
            metadata: { ...(cert.metadata || {}), verification_id: verificationId }
        });

        await SupabaseDB.createNotification(
            cert.student_email,
            'Certificate Approved',
            'Your certificate is ready for download.',
            null,
            'cert_approved'
        );

        UI.showNotification('Certificate approved and PDF generated!', 'success');
        renderReports('certificates');
    } catch (e) {
        console.error('Approval error:', e);
        UI.showNotification('Error: ' + e.message, 'error');
    }
}

async function rejectCert(certId) {
    const reason = await UI.prompt('Please provide a reason for rejection:', 'Course requirements not fully met', 'Rejection Reason');
    if (reason === null) return;
    try {
        await SupabaseDB.updateCertificate(certId, { status: 'rejected', metadata: { reason } });

        const { data: cert } = await supabaseClient.from('certificates').select('student_email').eq('id', certId).single();
        if (cert) {
            await SupabaseDB.createNotification(
                cert.student_email,
                'Certificate Request Rejected',
                `Your certificate request was rejected. Reason: ${reason}`,
                null,
                'cert_rejected'
            );
        }

        UI.showNotification('Certificate rejected', 'info');
        renderReports('certificates');
    } catch (e) {
        UI.showNotification('Error: ' + e.message, 'error');
    }
}

async function consolidateAndApproveCert(certId, studentEmail) {
    if (!await UI.confirm('This will create or update a consolidated certificate including all enrolled courses. Proceed?')) return;

    try {
        UI.showLoading('pageContent', 'Fetching enrolled courses and generating PDF...');

        // 1. Fetch all courses the student is currently enrolled in to auto-propagate onto the certificate
        const enrollRes = await SupabaseDB.getEnrollments(studentEmail);
        const enrolledCourses = (enrollRes.data || []).map(e => e.courses).filter(Boolean);

        if (enrolledCourses.length === 0) {
            throw new Error('This student is not enrolled in any courses.');
        }

        // 2. Identify the target certificate (either the existing consolidated one or the one currently selected)
        const query = supabaseClient.from('certificates').select('*').eq('student_email', studentEmail);
        const allCerts = await SupabaseDB._getAll(query);
        const existingConsolidated = allCerts.find(c => c.type === 'consolidated');
        const currentCert = allCerts.find(c => c.id === certId);

        // We prioritize the existing consolidated cert if it exists, otherwise we transform the current cert
        const targetId = existingConsolidated?.id || certId;
        const targetCert = existingConsolidated || currentCert;

        const student = await SupabaseDB.getUser(studentEmail);
        if (!student) throw new Error('Student data not found');

        const verificationId = targetCert?.metadata?.verification_id || crypto.randomUUID().slice(0, 13).toUpperCase();
        const issueDate = targetCert?.issued_at || new Date().toISOString();
        const verificationUrl = `${window.location.origin}/index.html?page=verify&id=${verificationId}`;

        const doc = await CertificateGenerator.generatePDF(
            student.full_name,
            'All Enrolled Courses',
            issueDate,
            verificationId,
            {
                type: 'consolidated',
                courses: enrolledCourses,
                verificationUrl: verificationUrl,
                teacherName: 'SmartLMS Registrar',
                isApproved: true
            }
        );

        if (!doc) throw new Error('PDF Generation failed');

        const pdfBlob = doc.output('blob');
        const path = `certificates/${studentEmail}/consolidated_${TimerManager.getTime()}.pdf`;

        if (targetCert?.certificate_url) {
            await SupabaseDB.deleteFileByUrl(targetCert.certificate_url);
        }

        await SupabaseDB.uploadFile('certificates', path, pdfBlob);
        const certUrl = await SupabaseDB.getPublicUrl('certificates', path);

        const payload = {
            id: targetId,
            student_email: studentEmail,
            certificate_url: certUrl,
            status: 'approved',
            type: 'consolidated',
            metadata: { ...(targetCert?.metadata || {}), verification_id: verificationId },
            issued_at: issueDate,
            updated_at: new Date().toISOString()
        };

        // Use upsert to handle both creation (if targetId was from a single cert) and update
        const { error: upsertError } = await supabaseClient.from('certificates').upsert(payload);
        if (upsertError) throw upsertError;

        await SupabaseDB.createNotification(
            studentEmail,
            'Consolidated Certificate Ready',
            'Your consolidated certificate has been updated with all your verified courses.',
            null,
            'cert_approved'
        );

        UI.showNotification('Consolidated certificate approved and updated!', 'success');
        renderReports('certificates');
    } catch (e) {
        console.error('Consolidation error:', e);
        UI.showNotification('Error: ' + (e.message || 'PDF Generation failed'), 'error');
    } finally {
        UI.hideLoading('pageContent');
    }
}

async function deleteCert(certId) {
    if (!await UI.confirm('Are you sure you want to delete this certificate record and its file? This action cannot be undone.')) return;
    try {
        await SupabaseDB.deleteCertificate(certId);
        UI.showNotification('Certificate deleted successfully.', 'info');
        renderReports('certificates');
    } catch (e) {
        UI.showNotification('Error deleting certificate: ' + e.message, 'error');
    }
}

async function editCert(certId) {
    const { data: cert } = await supabaseClient.from('certificates').select('*, users!student_email(full_name)').eq('id', certId).single();
    if (!cert) return;
    const currentTitle = cert.metadata?.course_title || cert.courses?.title || (cert.type === 'consolidated' ? 'All Enrolled Courses' : '');

    const newTitle = await UI.prompt('Enter new course title for this certificate:', currentTitle, 'Edit Certificate');
    if (newTitle === null || newTitle === currentTitle) return;

    try {
        UI.showLoading('pageContent', 'Regenerating Certificate PDF...');
        const verificationId = cert.metadata?.verification_id || cert.id.slice(0, 13).toUpperCase();
        const issueDate = cert.issued_at || new Date().toISOString();
        const verificationUrl = `${window.location.origin}/index.html?page=verify&id=${verificationId}`;
        const teacher = cert.teacher_email ? await SupabaseDB.getUser(cert.teacher_email) : null;

        // If consolidated, fetch enrolled courses to ensure consistency in PDF regeneration
        let consolidatedCourses = null;
        if (cert.type === 'consolidated') {
            const enrollRes = await SupabaseDB.getEnrollments(cert.student_email);
            consolidatedCourses = (enrollRes.data || []).map(e => e.courses).filter(Boolean);
        }

        const doc = await CertificateGenerator.generatePDF(
            cert.users?.full_name || cert.student_email,
            newTitle,
            issueDate,
            verificationId,
            {
                type: cert.type,
                courses: consolidatedCourses,
                verificationUrl: verificationUrl,
                teacherName: teacher?.full_name,
                isApproved: cert.status === 'approved'
            }
        );

        if (!doc) throw new Error('PDF Generation failed');

        const pdfBlob = doc.output('blob');
        const path = `certificates/${cert.student_email}/${cert.course_id || 'consolidated'}_${TimerManager.getTime()}.pdf`;

        if (cert.certificate_url) {
            await SupabaseDB.deleteFileByUrl(cert.certificate_url);
        }

        await SupabaseDB.uploadFile('certificates', path, pdfBlob);
        const certUrl = await SupabaseDB.getPublicUrl('certificates', path);

        await SupabaseDB.updateCertificate(certId, {
            certificate_url: certUrl,
            metadata: { ...(cert.metadata || {}), course_title: newTitle, verification_id: verificationId }
        });

        UI.showNotification('Certificate updated and PDF regenerated!', 'success');
        renderReports('certificates');
    } catch (e) {
        console.error('Edit error:', e);
        UI.showNotification('Error updating certificate: ' + e.message, 'error');
        renderReports('certificates');
    }
}

window.approveCert = approveCert;
window.rejectCert = rejectCert;
window.consolidateAndApproveCert = consolidateAndApproveCert;
window.renderMaintenance = renderMaintenance;
window.renderHealth = renderHealth;
window.renderManagement = renderManagement;
window.renderSettings = renderSettings;
window.renderSystem = renderSystem;
window.editUser = editUser;
window.toggleUserStatus = toggleUserStatus;
window.editCert = editCert;
window.deleteCert = deleteCert;
window.deleteUserByEmail = deleteUserByEmail;
window.lockUser = lockUser;
window.unlockUser = unlockUser;
window.toggleUserFlag = toggleUserFlag;
window.showCreateUserForm = showCreateUserForm;
window.showInviteForm = showInviteForm;
window.exportUsersCSV = exportUsersCSV;
window.approveReset = approveReset;
window.denyReset = denyReset;
window.revokeInvite = revokeInvite;
window.deleteBroadcast = deleteBroadcast;
window.broadcastNotif = broadcastNotif;
window.showAddScheduleForm = showAddScheduleForm;
window.removeSchedule = removeSchedule;
function filterUsers() { renderUsers(); }
window.filterUsers = filterUsers;
window.previewCleanup = previewCleanup;
window.executeCleanup = executeCleanup;
window.executePurge = executePurge;
window.saveAutoTask = saveAutoTask;
window.exportBackup = exportBackup;
window.importBackup = importBackup;

async function editUser(email) {
  const user = await SupabaseDB.getUser(email);
  if (user) showUserForm(user);
}

async function toggleUserStatus(email, currentStatus) {
  try {
    const user = await SupabaseDB.getUser(email);
    if (user) {
      user.active = !currentStatus;

      // Explicit session invalidation if deactivating
      if (!user.active) {
          user.session_id = 'deactivated_' + Date.now();
          user.metadata = { ...(user.metadata || {}), last_invalidation_reason: 'deactivated' };
      }

      // Our refactored saveUser handles session synchronization if session_id is present.
      // For Admins, setSupabaseSession will be called with the target user's sid,
      // but since we immediately re-fetch the dashboard state, this is typically handled by the UI refresh.
      await SupabaseDB.saveUser(user);
      UI.showNotification(`User ${user.active ? 'activated' : 'deactivated'}`, 'success');

      // Update local state if filtered
      const idx = allUsers.findIndex(u => u.email === email);
      if (idx !== -1) {
          allUsers[idx].active = user.active;
          allUsers[idx].metadata = user.metadata;
      }

      filterUsers(); // Refresh display with current filters
    }
  } catch (e) { UI.showNotification('Error: ' + e.message, 'error'); }
}

async function deleteUserByEmail(email) {
  if (await UI.confirm(`Are you sure you want to delete ${email}? This cannot be undone.`, 'Delete User')) {
    try {
      await SupabaseDB.deleteUser(email);
      UI.showNotification('User deleted', 'success');
      renderUsers();
    } catch (e) { UI.showNotification('Error: ' + e.message, 'error'); }
  }
}

async function lockUser(email, minutes) {
  try {
    const user = await SupabaseDB.getUser(email);
    if (user) {
      user.locked_until = new Date(Date.now() + minutes * 60000).toISOString();

      // Explicit session invalidation
      user.session_id = 'locked_' + Date.now();
      user.metadata = { ...(user.metadata || {}), last_invalidation_reason: 'locked' };

      // Our refactored saveUser handles session synchronization.
      await SupabaseDB.saveUser(user);
      UI.showNotification(`User locked for ${minutes} minutes`);
      renderUsers();
    }
  } catch (e) { UI.showNotification('Error: ' + e.message, 'error'); }
}

async function unlockUser(email) {
  try {
    const user = await SupabaseDB.getUser(email);
    if (user) {
      user.locked_until = null;
      user.failed_attempts = 0;
      await SupabaseDB.saveUser(user);
      UI.showNotification('User unlocked', 'success');
      renderUsers();
    }
  } catch (e) { UI.showNotification('Error: ' + e.message, 'error'); }
}

async function toggleUserFlag(email, currentFlag) {
  try {
    const user = await SupabaseDB.getUser(email);
    if (user) {
      user.flagged = !currentFlag;

      // Explicit session invalidation if flagging
      if (user.flagged) {
          user.session_id = 'flagged_' + Date.now();
          user.metadata = { ...(user.metadata || {}), last_invalidation_reason: 'flagged' };
      }

      await SupabaseDB.saveUser(user);
      UI.showNotification(`User ${user.flagged ? 'flagged' : 'unflagged'}`, user.flagged ? 'warn' : 'success');

      // Update local state
      const idx = allUsers.findIndex(u => u.email === email);
      if (idx !== -1) {
          allUsers[idx].flagged = user.flagged;
          allUsers[idx].metadata = user.metadata;
      }

      filterUsers();
    }
  } catch (e) { UI.showNotification('Error: ' + e.message, 'error'); }
}

function showCreateUserForm() {
  showUserForm(null);
}

async function exportUsersCSV() {
  const searchTerm = document.getElementById('userSearch')?.value?.toLowerCase() || '';
  const roleFilter = document.getElementById('roleFilter')?.value || 'all';
  const statusFilter = document.getElementById('statusFilter')?.value || 'all';

  UI.showNotification('Preparing export...', 'info');

  try {
      // Fetch matching users (bypass pagination by using a large page size)
      const { data: listToExport } = await SupabaseDB.getUsers({
          searchTerm,
          role: roleFilter === 'all' ? null : roleFilter,
          status: statusFilter === 'all' ? null : statusFilter,
          page: 1,
          pageSize: 5000 // Sufficient for most LMS instances
      });

      if (!listToExport || listToExport.length === 0) {
          return UI.showNotification('No users to export matching current filters', 'warn');
      }

      const headers = ['Full Name', 'Email', 'Role', 'Status', 'Joined'];
      const rows = listToExport.map(u => [
          u.full_name || '',
          u.email || '',
          u.role || '',
          u.active ? 'Active' : 'Inactive',
          u.created_at ? new Date(u.created_at).toISOString().split('T')[0] : 'N/A'
      ]);

      Exporter.csv('users_export.csv', headers, rows);
      UI.showNotification(`Exported ${listToExport.length} users successfully.`, 'success');
  } catch (e) {
      console.error('Export failed:', e);
      UI.showNotification('Export failed: ' + e.message, 'error');
  }
}

async function broadcastNotif() {
  const title = document.getElementById('bcTitle').value.trim();
  const role = document.getElementById('bcRole').value;
  const msg = document.getElementById('bcMsg').value.trim();
  const expiryDays = parseInt(document.getElementById('bcExpiry').value) || 30;

  const vTitle = Validator.required(title, 'Title');
  if (!vTitle.valid) return UI.showNotification(vTitle.message, 'warn');

  const vMsg = Validator.required(msg, 'Message');
  if (!vMsg.valid) return UI.showNotification(vMsg.message, 'warn');

  try {
    // Utilize centralized createBroadcast which leverages the secure SQL RPC
    // to handle business logic (expiry, role normalization) server-side.
    await SupabaseDB.createBroadcast({
        title,
        message: msg,
        targetRole: role,
        expiresInDays: expiryDays
    });

    UI.showNotification(`Broadcast sent successfully.`, 'success');
    document.getElementById('bcTitle').value = '';
    document.getElementById('bcMsg').value = '';

    // Refresh dashboard if visible to show local broadcast count update
    if (document.querySelector('[data-page="dashboard"].active')) {
        renderDashboard();
    }
  } catch (e) { UI.showNotification('Broadcast failed: ' + e.message, 'error'); }
}

async function removeSchedule(idx) {
  if (await UI.confirm('Remove this maintenance schedule?', 'Remove Schedule')) {
    try {
      const maintenance = await SupabaseDB.getMaintenance();
      maintenance.schedules.splice(idx, 1);
      await SupabaseDB.saveMaintenance(maintenance);
      renderMaintenance();
    } catch (e) { UI.showNotification('Error: ' + e.message, 'error'); }
  }
}


let _ticketPage = 1;
async function renderSupportTickets(page = 1) {
  const renderId = ++window.currentRenderId;
  _ticketPage = page;
  const content = document.getElementById('pageContent');
  if (!content) return;

  const pageSize = 15;

  try {
    if (renderId !== window.currentRenderId) return;
    const { data: tickets, total } = await SupabaseDB.getSupportTickets(null, { page, pageSize });
    if (renderId !== window.currentRenderId) return;
    allTickets = tickets;

    content.innerHTML = `
    <section>
      <div class="flex-between mb-20">
        <h3 class="m-0">User Concerns: Support Tickets</h3>
        <div class="small text-muted">${total} Tickets</div>
      </div>
      <div id="ticketsTable"></div>
      <div id="ticketsPagination"></div>
    </section>
    `;

    UI.renderTable('ticketsTable', ['User', 'Subject', 'Status', 'Date', 'Action'], tickets, (t) => {
        return `
            <tr>
              <td>
                <div class="bold small">${escapeHtml(t.user_email)}</div>
                <div class="tiny text-muted">${escapeHtml(t.role || 'Unknown')}</div>
              </td>
              <td>
                <div class="bold small">${escapeHtml(t.subject)}</div>
                <div class="tiny text-muted">${escapeHtml(t.message.substring(0, 50))}${t.message.length > 50 ? '...' : ''}</div>
              </td>
              <td><span class="badge-${t.status === 'open' ? 'warn' : (t.status === 'pending' ? 'warn' : 'active')}">${t.status.toUpperCase()}</span></td>
              <td>${new Date(t.created_at).toLocaleDateString()}</td>
              <td>
                <div class="flex gap-5">
                    <button class="button small w-auto" onclick="viewTicketDetails('${escapeAttr(t.id)}')">View</button>
                    <select class="small w-auto m-0" onchange="updateTicketStatus('${escapeAttr(t.id)}', this.value)">
                        <option value="open" ${t.status === 'open' ? 'selected' : ''}>Open</option>
                        <option value="pending" ${t.status === 'pending' ? 'selected' : ''}>Pending</option>
                        <option value="resolved" ${t.status === 'resolved' ? 'selected' : ''}>Resolved</option>
                        <option value="closed" ${t.status === 'closed' ? 'selected' : ''}>Closed</option>
                    </select>
                    <button class="button danger small w-auto" onclick="deleteSupportTicket('${escapeAttr(t.id)}')">Delete</button>
                </div>
              </td>
            </tr>
        `;
    });

    UI.renderPagination('ticketsPagination', total, page, pageSize, (newPage) => renderSupportTickets(newPage));

  } catch (error) {
    console.error('Tickets error:', error);
    content.innerHTML = `<div class="card danger-border"><h3>Error Loading Tickets</h3><p class="small">${escapeHtml(error.message)}</p></div>`;
  }
}

function viewTicketDetails(id) {
    const t = allTickets.find(x => x.id === id);
    if (!t) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.display = 'flex';
    backdrop.innerHTML = `
        <div class="modal" style="max-width:600px">
            <div class="flex-between mb-20">
                <h3 class="m-0">Ticket Details</h3>
                <button class="button secondary tiny w-auto" onclick="this.closest('.modal-backdrop').remove()">✕</button>
            </div>
            <div class="mb-15">
                <strong>From:</strong> ${escapeHtml(t.user_email)} (${escapeHtml(t.role)})
            </div>
            <div class="mb-15">
                <strong>Subject:</strong> ${escapeHtml(t.subject)}
            </div>
            <div class="mb-15">
                <strong>Status:</strong> <span class="badge-${t.status === 'open' ? 'warn' : 'active'}">${t.status.toUpperCase()}</span>
            </div>
            <div class="card bg-light p-15" style="white-space: pre-wrap">
                ${escapeHtml(t.message)}
            </div>
            <div class="mt-20">
                <label>Resolution Notes:</label>
                <textarea id="resNotes-${escapeAttr(t.id)}" rows="3" placeholder="Enter resolution details...">${escapeHtml(t.resolution_notes || '')}</textarea>
            </div>
            <div class="mt-20 flex-end gap-10">
                <button class="button w-auto px-20" onclick="saveTicketNotes('${escapeAttr(t.id)}')">Save Notes</button>
                <button class="button secondary px-40" onclick="this.closest('.modal-backdrop').remove()">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);
}
window.viewTicketDetails = viewTicketDetails;

async function updateTicketStatus(id, newStatus) {
    try {
        await SupabaseDB.updateSupportTicket(id, { status: newStatus });
        UI.showNotification('Ticket status updated.', 'success');
        updateSidebarBadges();
        renderSupportTickets();
    } catch (e) {
        UI.showNotification('Failed to update status: ' + e.message, 'error');
    }
}

async function saveTicketNotes(id) {
    const notes = document.getElementById(`resNotes-${id}`).value;
    try {
        await SupabaseDB.updateSupportTicket(id, { resolution_notes: notes });
        UI.showNotification('Resolution notes saved.', 'success');
        renderSupportTickets();
    } catch (e) {
        UI.showNotification('Failed to save notes: ' + e.message, 'error');
    }
}

window.updateTicketStatus = updateTicketStatus;
window.saveTicketNotes = saveTicketNotes;

async function deleteSupportTicket(id) {
    if (!await UI.confirm('Are you sure you want to delete this ticket?', 'Delete Ticket')) return;
    try {
        await SupabaseDB.deleteSupportTicket(id);
        UI.showNotification('Ticket deleted.', 'success');
        updateSidebarBadges();
        renderSupportTickets();
    } catch (e) {
        UI.showNotification('Failed to delete ticket: ' + e.message, 'error');
    }
}
window.deleteSupportTicket = deleteSupportTicket;

async function renderInvites() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;

  try {
    if (renderId !== window.currentRenderId) return;
    const invites = await SupabaseDB.getAllTableData('invites');
    if (renderId !== window.currentRenderId) return;
    const now = new Date();

    content.innerHTML = `
    <section>
      <div class="flex-between mb-20">
        <h3 class="m-0">Invitations</h3>
        <button class="button w-auto" onclick="showInviteForm()">+ Generate Invite</button>
      </div>
      ${invites.length === 0 ? '<p class="empty">No invitations generated yet.</p>' : `
        <div class="card" style="padding:0; overflow-x:auto">
          <table>
            <thead><tr><th>Recipient / Role</th><th>Token</th><th>Status</th><th>Expires</th><th>Action</th></tr></thead>
            <tbody>
              ${invites.map(i => {
                const isExpired = new Date(i.expires_at) < now;
                const isUsed = !!i.used_at;
                let statusHtml = '<span class="badge badge-active">ACTIVE</span>';
                if (isUsed) statusHtml = '<span class="badge" style="background:#edf2f7; color:#4a5568">USED</span>';
                else if (isExpired) statusHtml = '<span class="badge badge-inactive">EXPIRED</span>';

                return `
                <tr>
                  <td>
                    <div class="bold small">${escapeHtml(i.email || 'Open Invite')}</div>
                    <div class="tiny text-muted">Role: ${escapeHtml(i.role)}</div>
                  </td>
                  <td><code class="tiny">${escapeHtml(i.token)}</code></td>
                  <td>${statusHtml}</td>
                  <td><div class="tiny">${new Date(i.expires_at).toLocaleString()}</div></td>
                  <td>
                    ${!isUsed ? `<button class="button danger tiny w-auto" onclick="revokeInvite('${escapeAttr(i.token)}')">Revoke</button>` : '-'}
                  </td>
                </tr>
              `}).join('')}
            </tbody>
          </table>
        </div>
      `}
    </section>
    `;
  } catch (error) {
    console.error('Invites error:', error);
    content.innerHTML = `<div class="card danger-border"><h3>Error Loading Invites</h3><p class="small">${escapeHtml(error.message)}</p></div>`;
  }
}

async function revokeInvite(token) {
    if (!await UI.confirm('Revoke this invitation? The link will no longer work.', 'Revoke Invite')) return;
    try {
        await SupabaseDB.deleteInvite(token);
        UI.showNotification('Invitation revoked.', 'info');
        renderInvites();
    } catch (e) {
        UI.showNotification('Failed to revoke: ' + e.message, 'error');
    }
}
window.revokeInvite = revokeInvite;

async function renderBroadcasts() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;

  try {
    if (renderId !== window.currentRenderId) return;
    const { data: broadcasts, total } = await SupabaseDB.getBroadcasts();
    if (renderId !== window.currentRenderId) return;

    content.innerHTML = `
    <section>
      <div class="flex-between mb-20">
        <h3 class="m-0">Active Broadcasts</h3>
        <button class="button w-auto" onclick="renderDashboard()">+ New Broadcast</button>
      </div>
      ${broadcasts.length === 0 ? '<p class="empty">No active broadcasts found.</p>' : `
        <div class="card" style="padding:0; overflow-x:auto">
          <table>
            <thead><tr><th>Message</th><th>Target</th><th>Sent At</th><th>Expires</th><th>Action</th></tr></thead>
            <tbody>
              ${broadcasts.map(b => `
                <tr>
                  <td>
                    <div class="bold small">${escapeHtml(b.title)}</div>
                    <div class="tiny text-muted">${escapeHtml(b.message.substring(0, 50))}${b.message.length > 50 ? '...' : ''}</div>
                  </td>
                  <td><span class="badge" style="background:#edf2f7; color:#4a5568">${(b.target_role || 'ALL').toUpperCase()}</span></td>
                  <td><div class="tiny">${new Date(b.created_at).toLocaleString()}</div></td>
                  <td><div class="tiny">${new Date(b.expires_at).toLocaleString()}</div></td>
                  <td>
                    <button class="button danger tiny w-auto" onclick="deleteBroadcast('${escapeAttr(b.id)}')">Delete</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </section>
    `;
  } catch (error) {
    console.error('Broadcasts error:', error);
    content.innerHTML = `<div class="card danger-border"><h3>Error Loading Broadcasts</h3><p class="small">${escapeHtml(error.message)}</p></div>`;
  }
}

async function deleteBroadcast(id) {
    if (!await UI.confirm('Delete this broadcast? It will be removed for all users.', 'Delete Broadcast')) return;
    try {
        await SupabaseDB.deleteBroadcast(id);
        UI.showNotification('Broadcast deleted.', 'info');
        renderBroadcasts();
    } catch (e) {
        UI.showNotification('Failed to delete: ' + e.message, 'error');
    }
}
window.deleteBroadcast = deleteBroadcast;

let _violationPage = 1;
async function renderViolations(page = 1) {
  const renderId = ++window.currentRenderId;
  _violationPage = page;
  const content = document.getElementById('pageContent');
  if (!content) return;

  const pageSize = 20;
  const severity = document.getElementById('violSevFilter')?.value || null;
  const type = document.getElementById('violTypeFilter')?.value || null;

  if (!document.getElementById('violationsTable')) {
    content.innerHTML = `
    <section>
      <div class="flex-between mb-20">
        <h3 class="m-0">Global Security Violations</h3>
        <div class="flex gap-10">
          <select id="violSevFilter" class="small m-0" onchange="renderViolations(1)">
            <option value="">All Severities</option>
            <option value="CRITICAL" ${severity === 'CRITICAL' ? 'selected' : ''}>Critical</option>
            <option value="HIGH" ${severity === 'HIGH' ? 'selected' : ''}>High</option>
            <option value="LOW" ${severity === 'LOW' ? 'selected' : ''}>Low</option>
          </select>
          <select id="violTypeFilter" class="small m-0" onchange="renderViolations(1)">
            <option value="">All Types</option>
            <option value="assignment" ${type === 'assignment' ? 'selected' : ''}>Assignments</option>
            <option value="quiz" ${type === 'quiz' ? 'selected' : ''}>Quizzes</option>
          </select>
        </div>
      </div>
      <div id="violationsTable"></div>
      <div id="violationsPagination"></div>
    </section>
    `;
  }

  try {
    if (renderId !== window.currentRenderId) return;
    const { data: violations, total } = await SupabaseDB.getViolations(null, null, null, {
      severity: severity === '' ? null : severity,
      assessmentType: type === '' ? null : type,
      page,
      pageSize
    });
    if (renderId !== window.currentRenderId) return;

    UI.renderTable('violationsTable', ['Time', 'User', 'Assessment', 'Type', 'Severity', 'Score'], violations, (v) => {
        let sevClass = 'badge-active';
        if (v.severity === 'CRITICAL') sevClass = 'badge-inactive';
        else if (v.severity === 'HIGH') sevClass = 'badge-warn';

        return `
            <tr>
              <td><div class="tiny">${new Date(v.timestamp).toLocaleString()}</div></td>
              <td><div class="small bold">${escapeHtml(v.user_email)}</div></td>
              <td>
                <div class="small">${escapeHtml(v.assessment_type.toUpperCase())}</div>
                <div class="tiny text-muted">${escapeHtml(v.assessment_id)}</div>
              </td>
              <td><div class="small">${escapeHtml(v.type.replace(/_/g, ' '))}</div></td>
              <td><span class="badge ${sevClass}">${v.severity}</span></td>
              <td><div class="bold">${v.score || 0}</div></td>
            </tr>
        `;
    });

    UI.renderPagination('violationsPagination', total, page, pageSize, (newPage) => renderViolations(newPage));

  } catch (error) {
    console.error('Violations error:', error);
    content.innerHTML = `<div class="card danger-border"><h3>Error Loading Violations</h3><p class="small">${escapeHtml(error.message)}</p></div>`;
  }
}

async function renderResets() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;

  try {
    if (renderId !== window.currentRenderId) return;
    // Optimization: Use server-side filtering for pending resets
    const { data: pendingResets, total } = await SupabaseDB.getUsers({
        resetStatus: 'pending'
    });
    if (renderId !== window.currentRenderId) return;

    content.innerHTML = `
    <section>
      <div class="flex-between mb-20">
        <h3 class="m-0">Security: Password Resets</h3>
        <div class="small text-muted">${total} Pending</div>
      </div>
      <div id="resetsTable"></div>
    </section>
    `;

    UI.renderTable('resetsTable', ['Name', 'Email', 'Category', 'Level', 'Requested At', 'Actions'], pendingResets, (user) => {
        const req = user.reset_request || {};
        const level = req.security_level || 'N/A';
        let levelClass = 'badge-lock';
        if (level === 'Critical') levelClass = 'badge-inactive';
        else if (level === 'High') levelClass = 'badge-warn';
        else if (level === 'Low') levelClass = 'badge-active';

        return `
            <tr>
                <td>${escapeHtml(user.full_name)}</td>
                <td>${escapeHtml(user.email)}</td>
                <td>
                    <div class="small bold">${escapeHtml(req.category || 'N/A')}</div>
                    <div class="tiny text-muted">${escapeHtml(req.reason || '')}</div>
                    ${req.custom_reason ? `<div class="tiny mt-5 p-5" style="background:var(--bg); border-radius:4px; max-width:200px"><strong>Note:</strong> ${escapeHtml(req.custom_reason)}</div>` : ''}
                </td>
                <td><span class="badge ${levelClass}">${escapeHtml(level)}</span></td>
                <td>${escapeHtml(new Date(req.created_at).toLocaleString())}</td>
                <td>
                    <button class="button" style="width:auto; padding:4px 8px; font-size:12px" onclick="approveReset('${escapeAttr(user.email)}')">Approve</button>
                    <button class="button danger" style="width:auto; padding:4px 8px; font-size:12px" onclick="denyReset('${escapeAttr(user.email)}')">Deny</button>
                </td>
            </tr>
        `;
    }, { emptyMessage: 'No pending reset requests.' });
  } catch (error) {
    console.error('Resets error:', error);
    content.innerHTML = `
    <div class="card danger-border">
      <h3>Error Loading Resets</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button" onclick="renderResets()" style="width:auto; margin-top:10px">Retry</button>
    </div>`;
  }
}

async function updateSidebarBadges() {
  const [pendingResets, openTickets, pendingCerts] = await Promise.all([
    SupabaseDB.getCount('users', q => q.eq('reset_request->>status', 'pending')),
    SupabaseDB.getCount('support_tickets', q => q.or('status.eq.open,status.eq.pending')),
    SupabaseDB.getCount('certificates', q => q.in('status', ['requested', 'pending_approval']))
  ]);

  const resetBadge = document.getElementById('resetBadge');
  if (resetBadge) {
    resetBadge.textContent = pendingResets;
    resetBadge.style.display = pendingResets > 0 ? 'inline-block' : 'none';
  }

  const supportBadge = document.getElementById('supportBadge');
  if (supportBadge) {
    supportBadge.textContent = openTickets;
    supportBadge.style.display = openTickets > 0 ? 'inline-block' : 'none';
  }

  const reportsBadge = document.getElementById('reportsBadge');
  if (reportsBadge) {
    reportsBadge.textContent = pendingCerts;
    reportsBadge.style.display = pendingCerts > 0 ? 'inline-block' : 'none';
  }
}

async function approveReset(email) {
  const row = document.querySelector(`button[onclick*="'${email}'"]`)?.closest('tr') ||
              document.querySelector(`button[onclick*="approveReset('${email}')"]`)?.closest('tr');
  const buttons = row ? row.querySelectorAll('button') : [];
  const approveBtn = Array.from(buttons).find(b => b.textContent.includes('Approve'));
  const originalText = approveBtn ? approveBtn.textContent : 'Approve';

  try {
    if (approveBtn) {
        approveBtn.disabled = true;
        approveBtn.textContent = 'Approving...';
    }
    buttons.forEach(b => b.disabled = true);

    const tempPassword = await SupabaseDB.approvePasswordReset(email);

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.display = 'flex';
    backdrop.innerHTML = `
        <div class="modal" style="max-width:400px; text-align:center">
            <h3>Reset Approved</h3>
            <p>Reset request approved. Temporary password:</p>
            <div class="card mb-20" style="background:var(--bg-light); font-family:monospace; font-size:1.5rem; letter-spacing:2px">
                ${escapeHtml(tempPassword)}
            </div>
            <p class="small danger-text bold">PLEASE COPY THIS NOW. IT WILL NOT BE SHOWN AGAIN.</p>
            <button class="button mt-20" onclick="this.closest('.modal-backdrop').remove()">Done</button>
        </div>
    `;
    document.body.appendChild(backdrop);
    updateSidebarBadges();
    renderResets();
  } catch (e) {
    UI.showNotification('Error approving reset: ' + e.message, 'error');
    if (approveBtn) {
        approveBtn.disabled = false;
        approveBtn.textContent = originalText;
    }
    buttons.forEach(b => b.disabled = false);
  }
}

async function denyReset(email) {
  const reason = await UI.prompt("Enter denial reason:", "Verification failed", "Deny Reset Request");
  if (reason === null) return;

  const row = document.querySelector(`button[onclick*="'${email}'"]`)?.closest('tr') ||
              document.querySelector(`button[onclick*="denyReset('${email}')"]`)?.closest('tr');
  const buttons = row ? row.querySelectorAll('button') : [];
  const denyBtn = Array.from(buttons).find(b => b.textContent.includes('Deny'));
  const originalText = denyBtn ? denyBtn.textContent : 'Deny';

  try {
    if (denyBtn) {
        denyBtn.disabled = true;
        denyBtn.textContent = 'Denying...';
    }
    buttons.forEach(b => b.disabled = true);

    await SupabaseDB.denyPasswordReset(email, reason);
    UI.showNotification('Reset request denied', 'info');
    updateSidebarBadges();
    renderResets();
  } catch (e) {
    UI.showNotification('Error denying reset: ' + e.message, 'error');
    if (denyBtn) {
        denyBtn.disabled = false;
        denyBtn.textContent = originalText;
    }
    buttons.forEach(b => b.disabled = false);
  }
}

async function renderReports(tab = 'submissions', page = 1) {
    const renderId = ++window.currentRenderId;
    const content = document.getElementById('pageContent');
    if (!content) return;

    const pageSize = 20;

    content.innerHTML = `
    <section>
        <div class="flex-between mb-20">
            <h3 class="m-0">Global Academic Reports</h3>
        </div>

        <div class="tabs mb-20">
            <button class="tab-btn ${tab === 'submissions' ? 'active' : ''}" onclick="renderReports('submissions', 1)">Submissions</button>
            <button class="tab-btn ${tab === 'quiz_submissions' ? 'active' : ''}" onclick="renderReports('quiz_submissions', 1)">Quiz Attempts</button>
            <button class="tab-btn ${tab === 'attendance' ? 'active' : ''}" onclick="renderReports('attendance', 1)">Attendance</button>
            <button class="tab-btn ${tab === 'certificates' ? 'active' : ''}" onclick="renderReports('certificates', 1)">Certificates</button>
            <button class="tab-btn ${tab === 'study_sessions' ? 'active' : ''}" onclick="renderReports('study_sessions', 1)">Study Sessions</button>
        </div>

        <div id="reportsTable"></div>
        <div id="reportsPagination"></div>
    </section>
    `;

    try {
        if (renderId !== window.currentRenderId) return;
        let res;
        if (tab === 'submissions') {
            res = await SupabaseDB.getSubmissions(null, null, null, { page, pageSize });
            if (renderId !== window.currentRenderId) return;
            UI.renderTable('reportsTable', ['User', 'Assignment', 'Status', 'Grade', 'Submitted'], res.data, (s) => `
                <tr>
                    <td><div class="small bold">${escapeHtml(s.student_email)}</div></td>
                    <td><div class="small">${escapeHtml(s.assignments?.title || 'Unknown')}</div></td>
                    <td><span class="badge badge-${s.status === 'graded' ? 'active' : 'warn'}">${s.status.toUpperCase()}</span></td>
                    <td>${s.final_grade !== null ? s.final_grade + '%' : '-'}</td>
                    <td><div class="tiny">${new Date(s.submitted_at).toLocaleString()}</div></td>
                </tr>
            `);
        } else if (tab === 'quiz_submissions') {
            res = await SupabaseDB.getQuizSubmissions(null, null, null, { page, pageSize });
            if (renderId !== window.currentRenderId) return;
            UI.renderTable('reportsTable', ['User', 'Quiz', 'Attempt', 'Score', 'Status', 'Started'], res.data, (s) => `
                <tr>
                    <td><div class="small bold">${escapeHtml(s.student_email)}</div></td>
                    <td><div class="small">${escapeHtml(s.quizzes?.title || 'Unknown')}</div></td>
                    <td>${s.attempt_number || '-'}</td>
                    <td>${s.score !== null ? s.score + '%' : '-'}</td>
                    <td><span class="badge badge-${s.status === 'submitted' ? 'active' : 'warn'}">${s.status.toUpperCase()}</span></td>
                    <td><div class="tiny">${new Date(s.started_at).toLocaleString()}</div></td>
                </tr>
            `);
        } else if (tab === 'attendance') {
            res = await SupabaseDB.getAttendance(null, null, { page, pageSize });
            if (renderId !== window.currentRenderId) return;
            UI.renderTable('reportsTable', ['User', 'Course', 'Live Class', 'Join Time', 'Duration'], res.data, (a) => `
                <tr>
                    <td><div class="small bold">${escapeHtml(a.student_email)}</div></td>
                    <td><div class="small">${escapeHtml(a.courses?.title || 'Unknown')}</div></td>
                    <td><div class="small">${escapeHtml(a.live_classes?.title || 'Unknown')}</div></td>
                    <td><div class="tiny">${new Date(a.join_time).toLocaleString()}</div></td>
                    <td>${Math.round((a.duration || 0) / 60)}m</td>
                </tr>
            `);
        } else if (tab === 'certificates') {
            res = await SupabaseDB.getCertificates(null, null, { page, pageSize });
            if (renderId !== window.currentRenderId) return;
            UI.renderTable('reportsTable', ['User', 'Course/Type', 'Status', 'Info', 'Action'], res.data, (c) => {
                // For single certs, 'pending_approval' is the trigger.
                // For consolidated certs, we allow 'requested' or 'pending_approval' to be approved.
                const canApprove = (c.type === 'single' && c.status === 'pending_approval') ||
                                   (c.type === 'consolidated' && (c.status === 'requested' || c.status === 'pending_approval'));

                const typeLabel = c.type === 'consolidated' ? '<span class="badge-active">CONSOLIDATED</span>' : '<span class="badge-inactive">SINGLE</span>';
                const displayTitle = c.metadata?.course_title || c.courses?.title || 'Consolidated';
                return `
                <tr>
                    <td><div class="small bold">${escapeHtml(c.student_email)}</div></td>
                    <td>
                        <div class="small">${escapeHtml(displayTitle)}</div>
                        <div class="tiny">${typeLabel}</div>
                    </td>
                    <td><span class="badge-${c.status === 'approved' ? 'active' : (c.status === 'rejected' ? 'inactive' : 'warn')}">${c.status.toUpperCase()}</span></td>
                    <td><div class="tiny text-muted">${escapeHtml(c.request_reason || 'Teacher Issued')}</div></td>
                    <td>
                        <div class="flex gap-5 flex-wrap">
                            <button class="button secondary tiny w-auto" onclick="UI.viewFile('${escapeAttr(c.certificate_url)}', 'Certificate')">View</button>
                            ${canApprove ? (c.type === 'single' ? `
                                <button class="button small tiny w-auto" style="background:var(--ok)" onclick="approveCert('${escapeAttr(c.id)}')">Approve</button>
                                <button class="button danger tiny w-auto" onclick="rejectCert('${escapeAttr(c.id)}')">Reject</button>
                            ` : `
                                <button class="button small tiny w-auto" style="background:var(--purple)" onclick="consolidateAndApproveCert('${escapeAttr(c.id)}', '${escapeAttr(c.student_email)}')">Consolidate & Approve</button>
                                <button class="button danger tiny w-auto" onclick="rejectCert('${escapeAttr(c.id)}')">Reject</button>
                            `) : (c.type === 'consolidated' && c.status === 'approved' ? `
                                <button class="button small tiny w-auto" style="background:var(--purple)" onclick="consolidateAndApproveCert('${escapeAttr(c.id)}', '${escapeAttr(c.student_email)}')">Update Consolidation</button>
                            ` : '')}
                            <button class="button secondary tiny w-auto" onclick="editCert('${escapeAttr(c.id)}')">Edit</button>
                            <button class="button danger tiny w-auto" onclick="deleteCert('${escapeAttr(c.id)}')">Delete</button>
                        </div>
                    </td>
                </tr>
            `});
        } else if (tab === 'study_sessions') {
            res = await SupabaseDB.getStudySessions(null, { page, pageSize });
            if (renderId !== window.currentRenderId) return;
            UI.renderTable('reportsTable', ['User', 'Duration', 'Started', 'Ended'], res.data, (s) => `
                <tr>
                    <td><div class="small bold">${escapeHtml(s.user_email)}</div></td>
                    <td>${Math.round(s.duration / 60)}m</td>
                    <td><div class="tiny">${new Date(s.started_at).toLocaleString()}</div></td>
                    <td><div class="tiny">${new Date(s.ended_at).toLocaleString()}</div></td>
                </tr>
            `);
        }

        UI.renderPagination('reportsPagination', res.total, page, pageSize, (newPage) => renderReports(tab, newPage));

    } catch (e) {
        console.error('Reports error:', e);
        document.getElementById('reportsTable').innerHTML = `<div class="card danger-border"><p class="small">${escapeHtml(e.message)}</p></div>`;
    }
}

async function renderAnalytics() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;

  try {
    if (renderId !== window.currentRenderId) return;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

    const [
        totalSubs,
        activeUsers,
        totalCourses,
        totalEnrollments,
        totalViolations,
        recentSubsRes
    ] = await Promise.all([
      SupabaseDB.getCount('submissions'),
      SupabaseDB.getCount('users', q => q.eq('active', true)),
      SupabaseDB.getCount('courses'),
      SupabaseDB.getCount('enrollments'),
      SupabaseDB.getCount('violations'),
      supabaseClient.from('submissions').select('submitted_at').gte('submitted_at', thirtyDaysAgo.toISOString())
    ]);
    if (renderId !== window.currentRenderId) return;

    const recentSubs = recentSubsRes.data || [];

    const submissionsByDate = {};
    recentSubs.forEach(s => {
      const date = (s.submitted_at || new Date().toISOString()).split('T')[0];
      submissionsByDate[date] = (submissionsByDate[date] || 0) + 1;
    });

    const dates = Object.keys(submissionsByDate).sort();
    const counts = dates.map(d => submissionsByDate[d]);

    content.innerHTML = `
    <section>
      <h3>System Analytics</h3>
      <div class="stats-grid">
        <div class="stat-card"><h4>Total Submissions</h4><div class="value">${escapeHtml(totalSubs)}</div></div>
        <div class="stat-card"><h4>Active Users</h4><div class="value">${escapeHtml(activeUsers)}</div></div>
        <div class="stat-card"><h4>Total Courses</h4><div class="value">${escapeHtml(totalCourses)}</div></div>
        <div class="stat-card"><h4>Total Enrollments</h4><div class="value">${escapeHtml(totalEnrollments)}</div></div>
        <div class="stat-card" style="border-left-color:var(--danger)"><h4>Total Violations</h4><div class="value">${escapeHtml(totalViolations)}</div></div>
      </div>
      <div class="card" style="margin-top:20px">
        <h4>Submission Activity (Last 30 Days)</h4>
        <div style="height:300px; margin-top:20px">
          <canvas id="analyticsChart"></canvas>
        </div>
      </div>
    </section>
    `;

    if (dates.length > 0) {
      const ctx = document.getElementById('analyticsChart').getContext('2d');
      new Chart(ctx, {
        type: 'line',
        data: {
          labels: dates,
          datasets: [{
            label: 'Submissions',
            data: counts,
            borderColor: '#5b2ea6',
            backgroundColor: 'rgba(91, 46, 166, 0.1)',
            tension: 0.3,
            fill: true
          }]
        },
        options: {
          scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
          responsive: true,
          maintainAspectRatio: false
        }
      });
    }
  } catch (error) {
    console.error('Analytics error:', error);
    content.innerHTML = `
    <div class="card danger-border">
      <h3>Error Loading Analytics</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button" onclick="renderAnalytics()" style="width:auto; margin-top:10px">Retry</button>
    </div>`;
  }
}

async function renderMaintenance() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;

  try {
    if (renderId !== window.currentRenderId) return;
    const maintenance = await SupabaseDB.getMaintenance(true);
    if (renderId !== window.currentRenderId) return;

    // Auto-cleanup expired schedules
    const now = Date.now();
    const originalCount = maintenance.schedules?.length || 0;
    maintenance.schedules = (maintenance.schedules || []).filter(s => new Date(s.endAt).getTime() > now);
    if (maintenance.schedules.length !== originalCount) {
        await SupabaseDB.saveMaintenance(maintenance);
    }

    const isActive = isActiveMaintenance(maintenance);

    content.innerHTML = `
    <section>
      <div class="flex-between">
        <h3>Maintenance Settings</h3>
        <span class="badge ${isActive ? 'badge-warn' : 'badge-active'}" style="font-size: 0.9rem; padding: 5px 15px;">
            STATUS: ${isActive ? 'ACTIVE' : 'INACTIVE'}
        </span>
      </div>
      <form id="maintenanceForm" class="card">
        <div style="margin-bottom:15px">
            <label class="flex" style="align-items:center; gap:10px">
                <input type="checkbox" id="maintenanceEnabled" ${maintenance.enabled ? 'checked' : ''} style="width:auto; margin:0">
                Enable Maintenance Mode (Master Toggle)
            </label>
        </div>
        <div style="margin-bottom:15px">
            <label>Manual Until (optional):</label>
            <input type="datetime-local" id="manualUntil" value="${maintenance.manual_until ? new Date(maintenance.manual_until).toISOString().slice(0, 16) : ''}">
        </div>
        <div style="margin-bottom:15px">
            <label>Public Maintenance Message:</label>
            <textarea id="maintenanceMessage" rows="2" placeholder="e.g. System is undergoing scheduled upgrades. Expect downtime.">${escapeHtml(maintenance.message || '')}</textarea>
        </div>
        <button type="submit" id="saveMaintBtn" class="button" style="width:auto; padding:10px 40px">Save Settings</button>
      </form>

      <div style="margin-top:30px">
        <h4>Scheduled Maintenance</h4>
        <div id="schedulesList" class="grid">
          ${(maintenance.schedules || []).map((schedule, idx) => `
            <div class="card flex-between">
              <div>
                <div class="small">From: ${escapeHtml(new Date(schedule.startAt).toLocaleString())}</div>
                <div class="small">To: ${escapeHtml(new Date(schedule.endAt).toLocaleString())}</div>
              </div>
              <button class="button danger" onclick="removeSchedule(${escapeAttr(idx)})" style="width:auto; padding:6px 12px; font-size:12px">Remove</button>
            </div>
          `).join('') || '<div class="empty">No upcoming schedules.</div>'}
        </div>
        <button class="button" onclick="showAddScheduleForm()" style="width:auto; margin-top:15px">+ Add Schedule</button>
      </div>
    </section>
  `;
  document.getElementById('maintenanceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('saveMaintBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
        maintenance.enabled = document.getElementById('maintenanceEnabled').checked;
        maintenance.manual_until = document.getElementById('manualUntil').value ? new Date(document.getElementById('manualUntil').value).toISOString() : null;
        maintenance.message = document.getElementById('maintenanceMessage').value.trim();

        const vMsg = Validator.required(maintenance.message, 'Maintenance Message');
        if (!vMsg.valid) {
            UI.showNotification(vMsg.message, 'warn');
            return;
        }

        if (await SupabaseDB.saveMaintenance(maintenance)) {
            UI.showNotification('Maintenance settings updated', 'success');
            renderMaintenance();
        }
    } catch (err) {
        UI.showNotification('Failed to save: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save Settings';
    }
  });
  } catch (error) {
    console.error('Maintenance error:', error);
    content.innerHTML = `<div class="card danger-border">
      <h3>Error Loading Settings</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button" onclick="renderMaintenance()" style="width:auto; margin-top:10px">Retry</button>
    </div>`;
  }
}

async function renderHealth() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;

  try {
    if (renderId !== window.currentRenderId) return;
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - (60 * 60 * 1000));
    const thirtyMinsAgo = new Date(now.getTime() - (30 * 60 * 1000));

    const [
        maint,
        totalUsers,
        totalAssignments,
        totalSubmissions,
        totalCourses,
        totalQuizzes,
        loginsLastHour,
        activeSessions
    ] = await Promise.all([
      SupabaseDB.getMaintenance(true),
      SupabaseDB.getCount('users'),
      SupabaseDB.getCount('assignments'),
      SupabaseDB.getCount('submissions'),
      SupabaseDB.getCount('courses'),
      SupabaseDB.getCount('quizzes'),
      SupabaseDB.getCount('users', q => q.gt('created_at', oneHourAgo.toISOString())),
      SupabaseDB.getCount('users', q => q.gt('updated_at', thirtyMinsAgo.toISOString()))
    ]);
    if (renderId !== window.currentRenderId) return;

    const apiStats = SupabaseDB.getStats();
    const dbLatency = apiStats.lastRequestTime;

    const totalRecords = totalUsers + totalAssignments + totalSubmissions + totalCourses + totalQuizzes;
    const dbSizeMb = (totalRecords * 0.1 / 1024).toFixed(2); // Reduced multiplier for better estimation of small records

    const isOnline = apiStats.successRate > 50 || apiStats.totalRequests === 0;

    content.innerHTML = `
      <section>
        <h3>System Health & Performance</h3>
        <div class="stats-grid">
          <div class="stat-card"><h4>DB Latency</h4><div class="value">${escapeHtml(dbLatency)}ms</div></div>
          <div class="stat-card"><h4>Service Status</h4><div class="value ${isOnline ? 'success-text' : 'danger-text'}">${isOnline ? 'OPERATIONAL' : 'DEGRADED'}</div></div>
          <div class="stat-card"><h4>DB Size (Est)</h4><div class="value">${escapeHtml(dbSizeMb)}MB</div></div>
          <div class="stat-card"><h4>API Health</h4><div class="value" style="color:${apiStats.successRate > 95 ? 'var(--ok)' : 'var(--danger)'}">${escapeHtml(apiStats.successRate)}%</div></div>
        </div>

        <div class="grid-2 mt-20">
          <div class="card">
            <h4>Real-time Traffic</h4>
            <ul style="list-style:none; padding:0">
              <li style="padding:10px 0; border-bottom:1px solid var(--border)"><strong>New Signups (1h):</strong> ${escapeHtml(loginsLastHour)}</li>
              <li style="padding:10px 0; border-bottom:1px solid var(--border)"><strong>Active Sessions (30m):</strong> ${escapeHtml(activeSessions)}</li>
              <li style="padding:10px 0"><strong>Total Requests:</strong> ${escapeHtml(apiStats.totalRequests)}</li>
            </ul>
          </div>
          <div class="card">
            <h4>Backend Health</h4>
            <p class="small">All services operational. Maintenance mode: <strong style="color:${isActiveMaintenance(maint) ? 'var(--danger)' : 'var(--ok)'}">${isActiveMaintenance(maint) ? 'ACTIVE' : 'INACTIVE'}</strong></p>
          </div>
        </div>
      </section>
    `;
  } catch (error) {
    console.error('Health error:', error);
    content.innerHTML = `<div class="card danger-border"><h3>Health Check Failed</h3><button class="button" onclick="renderHealth()" style="width:auto">Retry</button></div>`;
  }
}

async function renderManagement() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;

  try {
    if (renderId !== window.currentRenderId) return;
    const maintenance = await SupabaseDB.getMaintenance();
    if (renderId !== window.currentRenderId) return;
    const autoSettings = maintenance.metadata?.autoTasks || {};

    content.innerHTML = `
      <section>
        <div class="flex-between mb-20">
          <h3>System Management</h3>
        </div>
        <div class="grid-2">
          <div class="card">
            <h4>Database Cleanup</h4>
            <p class="small">Remove old logs, drafts, and unused records.</p>
            <div class="flex gap-10 mt-10">
                <button class="button small" onclick="previewCleanup()">Preview Cleanup</button>
                <button class="button danger small" onclick="executePurge()">Execute Purge</button>
            </div>
          </div>
          <div class="card">
            <h4>System Backup</h4>
            <p class="small">Export or Restore complete system data.</p>
            <div class="flex gap-10" style="margin-top:10px">
              <button class="button" onclick="exportBackup()">Export Backup</button>
              <button class="button secondary" onclick="document.getElementById('importFile').click()">Import/Restore</button>
              <input type="file" id="importFile" class="hidden" onchange="importBackup(event)">
            </div>
          </div>
          <div class="card">
            <h4>Automated Tasks</h4>
            <p class="small">Configure scheduled system maintenance.</p>
            <div class="flex" style="flex-direction:column; gap:8px; margin-top:10px">
              <label class="small flex" style="align-items:center; gap:8px">
                <input type="checkbox" id="autoCleanupCheck" ${autoSettings.autoCleanup ? 'checked' : ''} style="width:auto; margin:0" onchange="saveAutoTask('autoCleanup', this.checked)">
                Daily Auto-Cleanup
              </label>
              <label class="small flex" style="align-items:center; gap:8px">
                <input type="checkbox" id="autoBackupCheck" ${autoSettings.autoBackup ? 'checked' : ''} style="width:auto; margin:0" onchange="saveAutoTask('autoBackup', this.checked)">
                Weekly Cloud Backup
              </label>
            </div>
          </div>
        </div>
        <div id="mgt-area" style="margin-top:20px"></div>
      </section>
    `;
  } catch (error) {
    console.error('Management error:', error);
    content.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Management</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderManagement()">Retry</button>
    </div>`;
  }
}

async function previewCleanup() {
  const [inactiveCount, draftCount] = await Promise.all([
      SupabaseDB.getCount('users', q => q.eq('active', false)),
      SupabaseDB.getCount('courses', q => q.eq('status', 'draft'))
  ]);

  const area = document.getElementById('mgt-area');
  area.innerHTML = `
    <div class="card">
      <h4>Cleanup Preview</h4>
      <p class="small">The following items are candidates for cleanup:</p>
      <ul class="small">
        <li>Inactive Users: ${escapeHtml(inactiveCount)}</li>
        <li>Draft Courses: ${escapeHtml(draftCount)}</li>
      </ul>
      <button class="button danger" style="width:auto; margin-top:10px" onclick="executeCleanup()">Execute Cleanup Now</button>
    </div>
  `;
}

async function executeCleanup() {
  if (!await UI.confirm('Are you sure? This action is irreversible. It will delete all inactive users and draft courses.', 'Execute Cleanup')) return;
  try {
    UI.showLoading('mgt-area', 'Performing cleanup...');

    const [{ data: users }, { data: courses }] = await Promise.all([
        SupabaseDB.getUsers({ page: 1, pageSize: 1000, status: 'inactive' }),
        SupabaseDB.getCourses(null, 'draft', { page: 1, pageSize: 1000 })
    ]);

    const inactiveUsers = users || [];
    const draftCourses = courses || [];

    const userProms = inactiveUsers.map(u => SupabaseDB.deleteUser(u.email));
    const courseProms = draftCourses.map(c => SupabaseDB.deleteCourse(c.id));

    await Promise.all([...userProms, ...courseProms]);

    UI.showNotification(`Cleanup successful: ${inactiveUsers.length} users and ${draftCourses.length} courses removed.`, 'success');
  } catch (e) {
    UI.showNotification('Cleanup failed: ' + e.message, 'error');
  } finally {
    UI.hideLoading('mgt-area');
    renderManagement();
  }
}

async function executePurge() {
    if (!await UI.confirm('This will permanently delete all EXPIRED broadcasts, notifications, and security violations. Proceed?', 'System Purge')) return;

    UI.showLoading('mgt-area', 'Purging expired records...');
    try {
        const now = new Date().toISOString();
        const results = await Promise.all([
            supabaseClient.from('broadcasts').delete().lt('expires_at', now),
            supabaseClient.from('notifications').delete().lt('expires_at', now),
            supabaseClient.from('violations').delete().lt('expires_at', now)
        ]);

        const errors = results.filter(r => r.error);
        if (errors.length > 0) throw new Error(errors[0].error.message);

        UI.showNotification('System purge completed successfully.', 'success');
    } catch (e) {
        UI.showNotification('Purge failed: ' + e.message, 'error');
    } finally {
        UI.hideLoading('mgt-area');
        renderManagement();
    }
}

/**
 * Advanced Audit Manager for verifying backup data integrity.
 */
class BackupAuditManager {
    static audit(backupData) {
        const tables = backupData.tables;
        const issues = [];
        const recordMaps = {};

        // 1. Build lookup maps for all tables and check for missing required tables
        BACKUP_CONFIG.tables.forEach(config => {
            const hasTable = Object.prototype.hasOwnProperty.call(tables, config.name);
            const data = tables[config.name] || [];

            recordMaps[config.name] = {
                exists: hasTable,
                ids: new Set(data.map(r => r.id).filter(Boolean)),
                emails: new Set(data.map(r => r.email).filter(Boolean)),
                tokens: new Set(data.map(r => r.token).filter(Boolean))
            };

            if (!hasTable && !config.optional) {
                issues.push({
                    table: config.name,
                    type: 'MISSING_TABLE',
                    isOptional: false,
                    message: `Required table "${config.name}" is missing from the backup data.`
                });
            }
        });

        // 2. Perform dependency checks
        BACKUP_CONFIG.tables.forEach(config => {
            const records = tables[config.name] || [];
            if (!config.dependencies) return;

            records.forEach(record => {
                config.dependencies.forEach(dep => {
                    const value = record[dep.field];
                    if (!value) {
                        if (!dep.optional) {
                            issues.push({
                                table: config.name,
                                recordId: record.id,
                                recordEmail: record.email,
                                recordToken: record.token,
                                type: 'MISSING_FIELD',
                                field: dep.field,
                                parentTable: dep.table,
                                isOptional: false,
                                message: `Required field "${dep.field}" is empty.`
                            });
                        }
                        return;
                    }

                    const targetTables = Array.isArray(dep.table) ? dep.table : [dep.table];
                    let exists = false;
                    let tableMissing = false;
                    let searchedTables = [];

                    targetTables.forEach(t => {
                        if (recordMaps[t]) {
                            searchedTables.push(t);
                            if (!recordMaps[t].exists) tableMissing = true;
                            const maps = recordMaps[t];
                            if (maps.ids.has(value) || maps.emails.has(value) || maps.tokens.has(value)) {
                                exists = true;
                            }
                        }
                    });

                    if (searchedTables.length > 0 && !exists) {
                        const issueType = tableMissing ? 'MISSING_PARENT_TABLE' : 'ORPHANED_RECORD';
                        const tableLabel = targetTables.join(' | ');
                        issues.push({
                            table: config.name,
                            recordId: record.id,
                            recordEmail: record.email,
                            recordToken: record.token,
                            type: issueType,
                            field: dep.field,
                            parentTable: tableLabel,
                            orphanId: value,
                            isOptional: !!dep.optional,
                            message: tableMissing
                                ? `References missing parent table(s) ${tableLabel} via field "${dep.field}".`
                                : `References missing record in ${tableLabel} (${value}) via field "${dep.field}".`
                        });
                    }
                });
            });
        });

        return issues;
    }

    /**
     * Attempts to resolve orphans by nullifying optional missing references.
     */
    static sanitizeOrphans(backupData, issues) {
        let fixedCount = 0;
        issues.forEach(issue => {
            if (issue.type === 'ORPHANED_RECORD' && issue.isOptional) {
                const records = backupData.tables[issue.table];
                if (!records) return;

                const record = records.find(r => {
                    if (issue.recordId && r.id === issue.recordId) return true;
                    if (issue.recordEmail && r.email === issue.recordEmail) return true;
                    if (issue.recordToken && r.token === issue.recordToken) return true;
                    return false;
                });

                if (record && record[issue.field] !== null) {
                    record[issue.field] = null;
                    fixedCount++;
                }
            }
        });
        return fixedCount;
    }

    static formatReport(issues, backupData = null) {
        if (issues.length === 0) return 'No integrity issues found.';

        const groups = {};
        issues.forEach(i => {
            if (!groups[i.table]) groups[i.table] = [];
            groups[i.table].push(i);
        });

        let report = `### Backup Audit Report (${issues.length} issues found)\n\n`;
        Object.keys(groups).forEach(table => {
            report += `**Table: ${table}** (${groups[table].length} issues)\n`;
            groups[table].slice(0, 10).forEach(issue => {
                const prefix = issue.isOptional ? '[AUTO-FIXABLE] ' : '[FATAL] ';

                // Advanced record identification for various table structures
                let record = null;
                if (backupData?.tables?.[issue.table]) {
                    record = backupData.tables[issue.table].find(r =>
                        (issue.recordId && r.id === issue.recordId) ||
                        (issue.recordEmail && r.email === issue.recordEmail) ||
                        (issue.recordToken && r.token === issue.recordToken)
                    );
                }

                let id = null;
                if (record) {
                    id = record.email || record.token || record.student_email || record.user_email || record.teacher_email || record.title || record.id;
                }
                if (!id) {
                    id = issue.recordId || issue.recordEmail || issue.recordToken;
                }

                if (!id && issue.type === 'MISSING_TABLE') id = 'TABLE_MISSING';
                id = id || 'unknown';
                report += `- ${prefix}[${id}] ${issue.message}\n`;
            });
            if (groups[table].length > 10) report += `- ... and ${groups[table].length - 10} more.\n`;
            report += '\n';
        });

        return report;
    }
}

async function exportBackup() {
  const container = document.getElementById('mgt-area');
  UI.showLoading('mgt-area', 'Preparing full system backup...');
  try {
    const backupData = {
        exportedAt: new Date().toISOString(),
        version: BACKUP_CONFIG.version,
        tables: {}
    };

    const totalTables = BACKUP_CONFIG.tables.length;
    for (let i = 0; i < totalTables; i++) {
        const config = BACKUP_CONFIG.tables[i];
        const orderBy = config.orderBy || 'created_at';

        UI.showLoading('mgt-area', `Exporting table ${i + 1}/${totalTables}: ${config.name}...`);
        try {
            backupData.tables[config.name] = await SupabaseDB.getAllTableData(config.name, orderBy);
        } catch (err) {
            console.warn(`Failed to export table ${config.name}:`, err);
            backupData.tables[config.name] = [];
        }
    }

    // Align with strictly requested format and table order as per user JSON.
    // Note: Restoration always follows the topological order defined in BACKUP_CONFIG.tables
    // to ensure referential integrity regardless of the JSON file structure.
    const requestedOrder = [
        'maintenance', 'submissions', 'lessons', 'courses', 'assignments', 'materials',
        'support_tickets', 'quizzes', 'topics', 'live_classes', 'notifications', 'users',
        'enrollments', 'attendance', 'certificates', 'discussions', 'study_sessions',
        'invites', 'quiz_submissions', 'violations', 'user_secrets', 'planner', 'broadcasts'
    ];
    const orderedTables = {};
    // 1. First, include requested tables in specific order
    requestedOrder.forEach(tableName => {
        if (Object.prototype.hasOwnProperty.call(backupData.tables, tableName)) {
            orderedTables[tableName] = backupData.tables[tableName];
        }
    });
    // 2. Then, include any other tables present in backupData but NOT in requestedOrder
    // This ensures no data is lost even if requestedOrder is incomplete.
    Object.keys(backupData.tables).forEach(tableName => {
        if (!orderedTables[tableName]) {
            orderedTables[tableName] = backupData.tables[tableName];
        }
    });
    backupData.tables = orderedTables;

    // Perform Integrity Audit
    UI.showLoading('mgt-area', 'Auditing data integrity...');
    const issues = BackupAuditManager.audit(backupData);

    if (issues.length > 0) {
        UI.hideLoading('mgt-area');
        const report = BackupAuditManager.formatReport(issues, backupData);
        console.warn('Backup audit failed:', issues);

        const confirmRestore = await new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.className = 'modal-backdrop';
            backdrop.style.display = 'flex';
            backdrop.innerHTML = `
                <div class="modal" style="max-width:600px">
                    <h3>Backup Integrity Issues</h3>
                    <p class="small mb-15">The system found ${issues.length} orphaned or incomplete records. Exporting this backup may result in errors during restoration.</p>
                    <div class="card bg-light p-15 small mb-20" style="max-height:300px; overflow-y:auto; white-space: pre-wrap; font-family: monospace">
                        ${escapeHtml(report)}
                    </div>
                    <div class="flex-end gap-10">
                        <button class="button secondary w-auto" id="cancelExport">Cancel Export</button>
                        <button class="button danger w-auto" id="ignoreExport">Export Anyway</button>
                    </div>
                </div>
            `;
            document.body.appendChild(backdrop);
            document.getElementById('cancelExport').onclick = () => { backdrop.remove(); resolve(false); };
            document.getElementById('ignoreExport').onclick = () => { backdrop.remove(); resolve(true); };
        });

        if (!confirmRestore) return;
        UI.showLoading('mgt-area', 'Finalizing export...');
    }

    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smartlms_full_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    UI.showNotification('Full system backup exported successfully.', 'success');
  } catch (e) {
    UI.showNotification('Backup failed: ' + e.message, 'error');
  } finally {
    UI.hideLoading('mgt-area');
    renderManagement();
  }
}

function validateBackup(data) {
    if (!data || typeof data !== 'object') return 'Invalid backup format: Not an object.';
    if (!data.tables || typeof data.tables !== 'object') return 'Invalid backup format: Missing tables data.';

    if (data.version) {
        const [major] = data.version.split('.');
        const [sysMajor] = BACKUP_CONFIG.version.split('.');
        if (major !== sysMajor) return `Incompatible backup version: System is v${BACKUP_CONFIG.version}, Backup is v${data.version}`;
    }

    // Verify all core tables are present (at least as empty arrays)
    const missingTables = BACKUP_CONFIG.tables.filter(t => !data.tables[t.name] && !t.optional);
    if (missingTables.length > 0) {
        console.warn('Backup is missing data for tables:', missingTables.map(t => t.name));
        if (missingTables.length > 3) return 'Invalid backup: Significant portion of data tables are missing.';
    }

    return null;
}

let _isRestoring = false;
async function importBackup(event) {
  if (_isRestoring) return UI.showNotification('A restore operation is already in progress.', 'warn');

  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const backupData = JSON.parse(e.target.result);

      const validationError = validateBackup(backupData);
      if (validationError) return UI.showNotification(validationError, 'error');

      const tableList = Object.keys(backupData.tables);

      if (!await UI.confirm(`Restore data from ${tableList.length} tables? Existing records with matching IDs will be OVERWRITTEN.`, 'Critical System Restore')) {
          event.target.value = '';
          return;
      }

      _isRestoring = true;
      sessionStorage.setItem('migrationMode', 'true');
      UI.showLoading('mgt-area', 'Initializing restoration...');

      // 1. Pre-Restore Integrity Audit & Auto-Fix
      let issues = BackupAuditManager.audit(backupData);
      if (issues.length > 0) {
          const fixableCount = issues.filter(i => i.isOptional).length;
          const fatalCount = issues.length - fixableCount;

          let auditMsg = `The backup file has ${issues.length} integrity issues.`;
          if (fixableCount > 0) auditMsg += `\n\n- ${fixableCount} optional orphans can be auto-fixed (nullified).`;
          if (fatalCount > 0) auditMsg += `\n- ${fatalCount} fatal issues may cause database errors.`;

          const userChoice = await UI.confirm(auditMsg + '\n\nAttempt auto-fix for optional orphans before restoring?', 'Integrity Audit');

          if (userChoice) {
              const fixed = BackupAuditManager.sanitizeOrphans(backupData, issues);
              UI.showNotification(`Auto-fixed ${fixed} orphaned references.`, 'info');
              // Re-audit after fix
              issues = BackupAuditManager.audit(backupData);
          }

          if (issues.some(i => !i.isOptional)) {
              const proceed = await UI.confirm('Remaining fatal issues found. Database errors are likely. Proceed anyway?', 'Warning');
              if (!proceed) throw new Error('Restore cancelled by user.');
          }
      }

      // 2. Perform Restore using strictly ordered tables from BACKUP_CONFIG
      const sortedConfigs = BACKUP_CONFIG.tables.filter(config => tableList.includes(config.name));
      const totalSteps = sortedConfigs.length;

      for (let step = 0; step < totalSteps; step++) {
          const config = sortedConfigs[step];
          const table = config.name;
          const records = backupData.tables[table] || [];

          if (records.length === 0) continue;

          UI.showLoading('mgt-area', `Restoring table [${step+1}/${totalSteps}]: ${table} (${records.length} records)...`);

          // 2.1 Multi-pass logic for self-referencing tables (e.g. discussions)
          const hasSelfDep = config.dependencies?.some(d => d.self);

          const processBatch = async (batchRecords) => {
              const batch = batchRecords.map(r => {
                  const sanitized = SupabaseDB._sanitizePayload(r, table);
                  // Critical logic for updating existing records correctly:
                  // If onConflict is NOT 'id' (meaning we match by natural key like email),
                  // we remove the surrogate 'id' to prevent UniqueViolation during restoration
                  // when a record with the same natural key already exists but with a different UUID.
                  // Note: This is safe because relationships in this schema are either email-based
                  // (for users) or reference parent IDs that are preserved (courses, assignments, etc.).
                  if (config.onConflict !== 'id' && Object.prototype.hasOwnProperty.call(sanitized, 'id')) {
                      delete sanitized.id;
                  }
                  return sanitized;
              });
              const { error } = await supabaseClient
                  .from(table)
                  .upsert(batch, { onConflict: config.onConflict });

              if (error) {
                  const firstId = batch[0].id || batch[0].email || 'unknown';
                  console.error(`Restore failed at table "${table}":`, error);
                  throw new Error(`[Table: ${table}] [Record ID: ${firstId}] ${error.message} (Code: ${error.code})`);
              }
          };

          const batchSize = 50;

          if (hasSelfDep) {
              console.log(`Using two-pass restore for self-referencing table: ${table}`);
              const selfFields = config.dependencies.filter(d => d.self).map(d => d.field);

              // Pass 1: Restore with self-references nullified
              for (let i = 0; i < records.length; i += batchSize) {
                  const batch = records.slice(i, i + batchSize).map(r => {
                      const temp = { ...r };
                      selfFields.forEach(f => temp[f] = null);
                      return temp;
                  });
                  await processBatch(batch);
              }
              // Pass 2: Restore with real self-references
              for (let i = 0; i < records.length; i += batchSize) {
                  const batch = records.slice(i, i + batchSize);
                  await processBatch(batch);
              }
          } else {
              // Regular single pass restore
              for (let i = 0; i < records.length; i += batchSize) {
                  const batch = records.slice(i, i + batchSize);
                  await processBatch(batch);
              }
          }
      }

      UI.showNotification('System Restore completed successfully.', 'success');
      renderManagement();
    } catch (err) {
      console.error('Restore failed:', err);
      UI.showNotification('Restoration Failed: ' + err.message, 'error');
    } finally {
      _isRestoring = false;
      sessionStorage.removeItem('migrationMode');
      UI.hideLoading('mgt-area');
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

async function renderSettings() {
    const renderId = ++window.currentRenderId;
    SettingsManager.render('Enable real-time desktop notifications for system health, server alerts, and password reset requests.');
}

async function renderHelp() {
  const renderId = ++window.currentRenderId;
  UI.renderHelp('pageContent', 'admin');
}
window.renderHelp = renderHelp;

async function renderSystem() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;

  try {
    if (renderId !== window.currentRenderId) return;
    const [maint, serverTimeRes] = await Promise.all([
        SupabaseDB.getMaintenance(),
        supabaseClient.rpc('get_server_time')
    ]);
    if (renderId !== window.currentRenderId) return;

    const serverTime = serverTimeRes.data;

    content.innerHTML = `
      <section>
        <h3>System Information</h3>
        <div class="grid-2">
          <div class="card">
            <h4>Application Info</h4>
            <ul class="small" style="list-style:none; padding:0">
                <li class="mb-10"><strong>Version:</strong> SmartLMS v${BACKUP_CONFIG.version}-PROD</li>
                <li class="mb-10"><strong>Environment:</strong> Production</li>
                <li class="mb-10"><strong>Platform:</strong> Web / PWA</li>
                <li><strong>Local Time:</strong> ${new Date().toLocaleString()}</li>
            </ul>
          </div>
          <div class="card">
            <h4>Backend Status</h4>
            <ul class="small" style="list-style:none; padding:0">
                <li class="mb-10"><strong>API Status:</strong> <span class="success-text bold">ONLINE</span></li>
                <li class="mb-10"><strong>Database:</strong> Supabase (PostgreSQL)</li>
                <li class="mb-10"><strong>Server Time:</strong> ${serverTime ? new Date(serverTime).toLocaleString() : 'Unavailable'}</li>
                <li><strong>Maintenance:</strong> ${isActiveMaintenance(maint) ? '<span class="danger-text bold">ACTIVE</span>' : '<span class="success-text bold">INACTIVE</span>'}</li>
            </ul>
          </div>
          <div class="card">
            <h4>Client Security</h4>
            <ul class="small" style="list-style:none; padding:0">
                <li class="mb-10"><strong>Session:</strong> ${sessionStorage.getItem('currentUser') ? '✅ Valid' : '❌ None'}</li>
                <li class="mb-10"><strong>Session ID:</strong> <code class="tiny">${escapeHtml(SessionManager.getSessionId())}</code></li>
                <li><strong>Encryption:</strong> AES-256 (SubtleCrypto)</li>
            </ul>
          </div>
          <div class="card">
            <h4>Resource Usage</h4>
            <ul class="small" style="list-style:none; padding:0">
                <li class="mb-10"><strong>API Requests (Session):</strong> ${SupabaseDB.getStats().totalRequests}</li>
                <li class="mb-10"><strong>API Errors:</strong> ${SupabaseDB.getStats().failedRequests}</li>
                <li><strong>Storage Buckets:</strong> 3 Active</li>
            </ul>
          </div>
        </div>
      </section>
    `;
  } catch (error) {
    console.error('System Info error:', error);
    content.innerHTML = `<div class="card danger-border">
      <h3>System Error</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderSystem()">Retry</button>
    </div>`;
  }
}

function showUserForm(user = null) {
  const content = document.getElementById('pageContent');
  if (!content) return;
  const isEdit = !!user;
  content.innerHTML = `
    <section>
      <h3>${isEdit ? 'Edit User' : 'Create User'}</h3>
      <form id="userForm" class="card">
        <label>Full Name</label>
        <input type="text" id="fullName" placeholder="Full Name" value="${isEdit ? escapeHtml(user.full_name) : ''}" required>
        <label>Email</label>
        <input type="email" id="email" placeholder="Email" value="${isEdit ? escapeHtml(user.email) : ''}" required>
        <label>Phone Number</label>
        <input type="tel" id="phone" placeholder="Phone Number" value="${isEdit ? escapeHtml(user.phone || '') : ''}">
        <label>Password</label>
        <div class="password-wrapper">
          <input type="password" id="password" placeholder="${isEdit ? 'New Password (leave blank to keep current)' : 'Password'}" ${isEdit ? '' : 'required'}>
          <span class="password-toggle" onclick="const p=document.getElementById('password'); const isPass=p.type==='password'; p.type=isPass?'text':'password'; this.textContent=isPass?'🔒':'👁️'">👁️</span>
        </div>
        <label>Role</label>
        <select id="role">
          <option value="student" ${isEdit && user.role === 'student' ? 'selected' : ''}>Student</option>
          <option value="teacher" ${isEdit && user.role === 'teacher' ? 'selected' : ''}>Teacher</option>
          <option value="admin" ${isEdit && user.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select>
        <div class="mb-10 mt-10">
            <label class="flex-center-y gap-10">
                <input type="checkbox" id="active" ${(!isEdit || user.active) ? 'checked' : ''} class="w-auto m-0">
                Active Account
            </label>
        </div>
        <div class="flex gap-10 mt-20">
            <button type="submit" class="button w-auto px-40">${isEdit ? 'Update User' : 'Create User'}</button>
            <button type="button" class="button secondary w-auto px-40" onclick="renderUsers()">Cancel</button>
        </div>
      </form>
    </section>
  `;
  document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const fullName = document.getElementById('fullName').value.trim();
      const email = document.getElementById('email').value.trim();
      const phone = document.getElementById('phone').value.trim();
      const password = document.getElementById('password').value;

      const vName = Validator.fullName(fullName);
      if (!vName.valid) return UI.showNotification(vName.message, 'warn');

      const vEmail = Validator.email(email);
      if (!vEmail.valid) return UI.showNotification(vEmail.message, 'warn');

      const vPhone = Validator.phone(phone);
      if (!vPhone.valid) return UI.showNotification(vPhone.message, 'warn');

      const normalizedEmail = normalizeEmail(email);
      let hashedPassword = isEdit ? user.password : '';

      if (!isEdit && !password) {
          return UI.showNotification('Password is required for new users.', 'warn');
      }

      if (password) {
        const vPass = Validator.password(password);
        if (!vPass.valid) return UI.showNotification(vPass.message, 'warn');
        hashedPassword = await window.hashPassword(password, normalizedEmail);
      }
      const userData = {
          ...user,
          full_name: fullName,
          email: normalizedEmail,
          phone: phone,
          password: hashedPassword,
          role: document.getElementById('role').value,
          active: document.getElementById('active').checked
      };
      if (isEdit) userData.created_at = user.created_at;
      if (isEdit) {
          const roleChanged = user.role !== userData.role;
          const statusChanged = user.active !== userData.active;
          const emailChanged = user.email !== userData.email;
          const passwordChanged = !!password;

          if (roleChanged || (statusChanged && !userData.active) || emailChanged || passwordChanged) {
              userData.session_id = 'admin_mod_' + Date.now();
              userData.metadata = {
                  ...(user.metadata || {}),
                  last_invalidation_reason: roleChanged ? 'role_change' : (emailChanged ? 'email_change' : (passwordChanged ? 'password_change' : 'deactivated'))
              };
          }
      }

      if (isEdit && user.email !== userData.email) {
          if (await SupabaseDB.updateUserEmail(user.email, userData.email, userData)) {
            UI.showNotification('User updated including email', 'success');
              renderUsers();
          }
      } else {
          if (await SupabaseDB.saveUser(userData)) {
          UI.showNotification(isEdit ? 'User updated' : 'User created', 'success');
            renderUsers();
          }
      }
    } catch (err) {
    UI.showNotification('Error saving user: ' + err.message, 'error');
    }
  });
}

function showInviteForm() {
  const area = document.createElement('div');
  area.id = 'inviteModal';
  area.className = 'modal-backdrop';
  area.style.display = 'flex';
  area.innerHTML = `
    <div class="modal" style="max-width:500px">
      <h3>Generate Invite Link</h3>
      <p class="small">Invites bypass the public registration limits for Admin and Teacher roles.</p>
      <form id="inviteForm">
        <label>Recipient Email (Optional for Students)</label>
        <input type="email" id="inviteEmail" placeholder="email@example.com">
        <label>Target Role</label>
        <select id="inviteRole" required>
          <option value="student">Student</option>
          <option value="teacher">Teacher</option>
          <option value="admin">Admin</option>
        </select>
        <label>Expires In</label>
        <select id="inviteExpiry">
          <option value="1">24 Hours</option>
          <option value="7" selected>7 Days</option>
          <option value="30">30 Days</option>
        </select>
        <div id="inviteResult" style="margin-top:15px; display:none">
          <label>Invitation Link:</label>
          <div class="flex gap-5">
            <input type="text" id="inviteLink" readonly style="margin:0">
            <button type="button" class="button w-auto px-15" onclick="copyInviteLink()">Copy</button>
          </div>
          <p class="tiny success-text mt-5">Share this link with the recipient.</p>
        </div>
        <div class="flex gap-10 mt-20" id="inviteActions">
            <button type="submit" class="button w-auto px-30">Generate Link</button>
            <button type="button" class="button secondary w-auto px-30" onclick="this.closest('#inviteModal').remove()">Cancel</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(area);

  window.copyInviteLink = () => {
    const link = document.getElementById('inviteLink');
    if (!link) return;
    link.select();
    document.execCommand('copy');
    UI.showNotification('Link copied to clipboard!');
  };

  const inviteForm = document.getElementById('inviteForm');
  if (inviteForm) inviteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const emailEl = document.getElementById('inviteEmail');
      const roleEl = document.getElementById('inviteRole');
      const expiryEl = document.getElementById('inviteExpiry');

      if (!roleEl || !expiryEl) return UI.showNotification('System error: Form fields missing.', 'error');

      const email = emailEl ? emailEl.value.trim() : '';
      const role = roleEl.value;
      const expiryDays = parseInt(expiryEl.value);

      if ((role === 'admin' || role === 'teacher') && !email) {
        return UI.showNotification('Email is required for Admin and Teacher invites.', 'warn');
      }

      if (email) {
        const vEmail = Validator.email(email);
        if (!vEmail.valid) return UI.showNotification(vEmail.message, 'warn');

        const existing = await SupabaseDB.getUser(email);
        if (existing) return UI.showNotification('A user with this email already exists.', 'warn');
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiryDays);

      const user = await SessionManager.getCurrentUser();
      const invite = {
          token,
          email: email || null,
          role,
          expires_at: expiresAt.toISOString(),
          created_by: user.email
      };

      if (await SupabaseDB.saveInvite(invite)) {
          const baseUrl = window.location.origin + window.location.pathname.replace('admin.html', 'index.html');
          const inviteUrl = `${baseUrl}?invite=${token}`;

          const resultEl = document.getElementById('inviteResult');
          const linkEl = document.getElementById('inviteLink');
          const actionsEl = document.getElementById('inviteActions');

          if (linkEl) linkEl.value = inviteUrl;
          if (resultEl) resultEl.style.display = 'block';
          if (actionsEl) {
              const submitBtn = actionsEl.querySelector('button[type="submit"]');
              if (submitBtn) submitBtn.style.display = 'none';
          }
          UI.showNotification('Invite generated!');
      }
  } catch (err) { UI.showNotification('Failed to generate invite: ' + err.message, 'error'); }
  });
}

function showAddScheduleForm() {
  const area = document.createElement('div');
  area.id = 'scheduleModal';
  area.className = 'modal-backdrop';
  area.style.display = 'flex';
  area.innerHTML = `
    <div class="modal">
      <h3>Add Maintenance Schedule</h3>
      <form id="scheduleForm">
        <div class="grid-2">
            <div><label class="small">Start At</label><input type="datetime-local" id="scheduleStart" required></div>
            <div><label class="small">End At</label><input type="datetime-local" id="scheduleEnd" required></div>
        </div>
        <div class="flex gap-10 mt-15">
            <button type="submit" class="button w-auto px-30">Add Schedule</button>
            <button type="button" class="button secondary w-auto px-30" onclick="this.closest('#scheduleModal').remove()">Cancel</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(area);

  document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const maintenance = await SupabaseDB.getMaintenance();
      maintenance.schedules = maintenance.schedules || [];
      maintenance.schedules.push({
          startAt: new Date(document.getElementById('scheduleStart').value).toISOString(),
          endAt: new Date(document.getElementById('scheduleEnd').value).toISOString()
      });
      if (await SupabaseDB.saveMaintenance(maintenance)) {
          UI.showNotification('Schedule added');
          area.remove();
          renderMaintenance();
      }
    } catch (err) { UI.showNotification('Failed to add schedule: ' + err.message, 'error'); }
  });
}

function initNav() {
  const adminNav = document.getElementById('adminNav');
  if (adminNav) {
    adminNav.querySelectorAll('button').forEach(button => {
      button.addEventListener('click', (e) => {
        adminNav.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        button.classList.add('active');
        const page = button.dataset.page;
        if(page === 'dashboard') renderDashboard();
        else if(page === 'users') renderUsers();
        else if(page === 'courses') renderCourses();
        else if(page === 'reports') renderReports();
        else if(page === 'support') renderSupportTickets();
        else if(page === 'invites') renderInvites();
        else if(page === 'broadcasts') renderBroadcasts();
        else if(page === 'resets') renderResets();
        else if(page === 'violations') renderViolations();
        else if(page === 'analytics') renderAnalytics();
        else if(page === 'maintenance') renderMaintenance();
        else if(page === 'health') renderHealth();
        else if(page === 'management') renderManagement();
        else if(page === 'settings') renderSettings();
        else if(page === 'system') renderSystem();
        else if(page === 'help') renderHelp();
      });
    });
  }
}

async function saveAutoTask(task, enabled) {
  try {
    const maintenance = await SupabaseDB.getMaintenance();
    maintenance.metadata = maintenance.metadata || {};
    maintenance.metadata.autoTasks = maintenance.metadata.autoTasks || {};
    maintenance.metadata.autoTasks[task] = enabled;
    await SupabaseDB.saveMaintenance(maintenance);
    UI.showNotification('Automated task setting updated', 'success');
  } catch (err) {
    UI.showNotification('Failed to save setting: ' + err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await initDashboard('admin');
  if (user) {
    initNav();
    NotificationManager.init();
    NotificationManager.initRealtimeSubscriptions(user.email, 'admin', () => {
        const activeEl = document.activeElement;
        const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
        if (!isTyping && document.querySelector('[data-page="dashboard"].active')) {
            renderDashboard();
            updateSidebarBadges();
        }
    });
    renderDashboard();
    updateSidebarBadges();

    setInterval(updateMaintBanner, 30000);
    updateMaintBanner();
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await SessionManager.clearCurrentUser('manual_logout');
        window.location.href = 'index.html';
      });
    }
  }
});
