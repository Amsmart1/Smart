const StudentState = {
  activeCountdowns: [],
  quizTimer: null,
  isStartingQuiz: false,
  isSubmittingQuiz: false,
  isSubmittingAssignment: false,
  studyInterval: null,
  studyStartTime: null,
  currentStudyCourseId: null,
  currentQuiz: null,
  currentSubmission: null,
  currentQuestionIndex: 0,
  currentQuizQuestions: [],
  quizDebounceTimer: null
};

function clearActiveCountdowns() {
    UI.clearCountdowns(StudentState.activeCountdowns, StudentState.quizTimer);
    StudentState.quizTimer = null;
}

async function updateHeaderStats() {
  try {
  const me = await SessionManager.getCurrentUser();
  if (!me) return;
  const [user, enrollmentsCount, dueSoonCount] = await Promise.all([
    SupabaseDB.getUser(me.email),
    SupabaseDB.getCount('enrollments', q => q.eq('student_email', me.email)),
    _getDueSoonCount(me.email)
  ]);
  
  const statCourses = document.getElementById('statCourses');
  const statDue = document.getElementById('statDue');
  const profileName = document.getElementById('profileName');
  if (statCourses) statCourses.textContent = enrollmentsCount;
  if (statDue) statDue.textContent = dueSoonCount;
  if (profileName) profileName.textContent = user.full_name || 'Student';
  } catch (e) {
      console.warn('Failed to update header stats:', e);
  }
}

async function _getDueSoonCount(email) {
  try {
    const enrollRes = await SupabaseDB.getEnrollments(email);
    const enrollments = enrollRes.data || [];
    const enrolledCourseIds = enrollments.map(e => e.course_id);
    if (enrolledCourseIds.length === 0) return 0;

    const [{ data: assigns }, { data: submissions }] = await Promise.all([
      SupabaseDB.getAssignments(null, null, enrolledCourseIds),
      SupabaseDB.getSubmissions(null, email, null)
    ]);

    const now = TimerManager.getTime();
    return assigns.filter(a => {
      const dueDate = new Date(a.due_date).getTime();
      const isSubmitted = submissions.some(s => s.assignment_id === a.id);
      return a.status === 'published' && !isSubmitted && dueDate > now && (dueDate - now) < (7 * 24 * 60 * 60 * 1000);
    }).length;
  } catch (e) {
    console.warn('Due soon count error:', e);
    return 0;
  }
}
window._getDueSoonCount = _getDueSoonCount;

async function renderCourses() {
  const renderId = ++window.currentRenderId;
  const container = document.getElementById('pageContent');
  if (!container) return;
  clearActiveCountdowns();

  const searchTerm = document.getElementById('catalogSearch')?.value || '';

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const [{ data: courses }, enrollRes] = await Promise.all([
      SupabaseDB.getCourses(null, 'published', { searchTerm }),
      SupabaseDB.getEnrollments(user.email)
    ]);
    if (renderId !== window.currentRenderId) return;
    const enrollments = enrollRes.data || [];

    container.innerHTML = `
      <div class="flex-between mb-20">
        <h2 class="m-0">Course Catalog</h2>
        <div class="flex gap-10">
          <input type="text" id="catalogSearch" placeholder="Search courses..." class="m-0" style="width:200px" value="${escapeAttr(searchTerm)}" oninput="renderCourses()">
        </div>
      </div>
      <div class="grid" id="catalogGrid" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))"></div>
    `;

    window.myEnrollments = enrollments;
    displayCatalog(courses);
  } catch (error) {
    console.error('Courses error:', error);
    container.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Catalog</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderCourses()">Retry</button>
    </div>`;
  }
}

function displayCatalog(courses) {
  const grid = document.getElementById('catalogGrid');
  if (!grid) return;

  if (!courses.length) {
    grid.innerHTML = '<div class="empty" style="grid-column: 1/-1">No courses found matching your criteria.</div>';
    return;
  }

  grid.innerHTML = courses.map(c => {
    const enrolled = window.myEnrollments.some(e => e.course_id === c.id);

    return `
      <div class="card flex-column gap-10" style="transition:transform 0.2s">
        <div style="width:100%; height:160px; background:linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius:6px; display:flex; align-items:center; justify-content:center; color:white; font-size:40px">📚</div>
        <div style="flex:1">
          <h3 class="m-0 mt-10" style="font-size:18px">${escapeHtml(c.title)}</h3>
          <div class="small-text color-dim mt-5">By: ${escapeHtml(c.created_by || 'Unknown Teacher')}</div>
          <div class="small mt-10 mb-20" style="line-height:1.4">${UI.renderRichText((c.description || '').substring(0, 150))}...</div>
          <div class="flex-between">
            ${enrolled ?
              `<button class="button secondary w-auto small" onclick="viewCourse('${escapeAttr(c.id)}', false)">View Details</button>` :
              `<button class="button w-auto small" onclick="enroll('${escapeAttr(c.id)}')">Enroll Now</button>`
            }
          </div>
        </div>
      </div>
    `;
  }).join('');
}


async function renderMyCourses() {
  const renderId = ++window.currentRenderId;
  clearActiveCountdowns();
  const container = document.getElementById('pageContent');
  if (!container) return;

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const [{ data: myCourses }, enrollRes] = await Promise.all([
      SupabaseDB.getEnrolledCourses(user.email),
      SupabaseDB.getEnrollments(user.email)
    ]);
    if (renderId !== window.currentRenderId) return;
    const enrollments = enrollRes.data || [];

    container.innerHTML = `
      <h2 class="mb-20">My Enrolled Courses</h2>
      <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))">
        ${myCourses.map(c => {
          const enrollment = enrollments.find(e => e.course_id === c.id);
          const progress = enrollment?.progress || 0;
          return `
            <div class="card flex-column gap-10">
              <div style="width:100%; height:120px; background:linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius:6px; display:flex; align-items:center; justify-content:center; color:white; font-size:40px">📖</div>
              <h3 class="m-0">${escapeHtml(c.title)}</h3>
              <div class="small-text color-dim">By: ${escapeHtml(c.created_by || 'Unknown Teacher')}</div>
              <div class="progress-container" style="background:#eee; height:8px; border-radius:4px; overflow:hidden">
                <div class="progress-bar" style="background:var(--ok); height:100%; width:${progress}%"></div>
              </div>
              <div class="flex-between">
                <span class="tiny text-muted">${progress}% Complete</span>
                ${enrollment?.completed ? '<span class="badge badge-active tiny">Completed</span>' : ''}
              </div>
              <div class="small" style="flex:1">${UI.renderRichText((c.description || '').substring(0, 150))}...</div>
              <button class="button w-auto small" onclick="viewCourse('${escapeAttr(c.id)}', true)">Open Course</button>
            </div>
          `;
        }).join('') || '<div class="empty" style="grid-column:1/-1">You haven\'t enrolled in any courses yet. Visit the Catalog to find some!</div>'}
      </div>
    `;
  } catch (error) {
    console.error('My Courses error:', error);
    container.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Your Courses</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderMyCourses()">Retry</button>
    </div>`;
  }
}
async function enroll(courseId) {
  const renderId = window.currentRenderId;
  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const course = await SupabaseDB.getCourse(courseId);
    if (renderId !== window.currentRenderId) return;

    let enrollmentId = null;
    if (course.enrollment_id) {
        enrollmentId = await new Promise((resolve) => {
            const backdrop = document.createElement('div');
            backdrop.className = 'modal-backdrop';
            backdrop.style.display = 'flex';
            backdrop.innerHTML = `
                <div class="modal" style="max-width:400px">
                    <h3>Enrollment Required</h3>
                    <p class="small">This course requires an Enrollment ID to join.</p>
                    <input type="text" id="enrollmentIdInput" class="input mt-15" placeholder="Enter Enrollment ID">
                    <div class="flex gap-10 mt-20">
                        <button class="button w-auto" id="confirmEnroll">Enroll</button>
                        <button class="button secondary w-auto" id="cancelEnroll">Cancel</button>
                    </div>
                </div>
            `;
            document.body.appendChild(backdrop);
            document.getElementById('confirmEnroll').onclick = () => {
                const val = document.getElementById('enrollmentIdInput').value;
                backdrop.remove();
                resolve(val || null);
            };
            document.getElementById('cancelEnroll').onclick = () => {
                backdrop.remove();
                resolve(null);
            };
        });
        if (enrollmentId === null) return; // User cancelled
    }

    await SupabaseDB.enrollInCourse(courseId, user.email, enrollmentId);
    if (renderId !== window.currentRenderId) return;
    UI.showNotification('Successfully enrolled!', 'success');
    renderCourses();
  } catch (e) {
    UI.showNotification('Enrollment failed: ' + e.message, 'danger');
  }
}
async function viewCourse(courseId, fromMyCourses = false) {
  const renderId = ++window.currentRenderId;
  // Ensure any active study session is stopped if navigating to course view
  if (StudentState.studyInterval) await stopStudySession();

  try {
  const course = await SupabaseDB.getCourse(courseId);
  if (renderId !== window.currentRenderId) return;
  if (!course || course.status !== 'published') {
      UI.showNotification('This course is not available.', 'warn');
      if (fromMyCourses) renderMyCourses(); else renderCourses();
      return;
  }

  const [topicRes, lessonRes, { data: allCourseAssignments }] = await Promise.all([
      SupabaseDB.getTopics(courseId),
      SupabaseDB.getLessons(courseId),
      SupabaseDB.getAssignments(null, courseId, null)
  ]);
  if (renderId !== window.currentRenderId) return;
  const topics = topicRes.data || [];
  const lessons = lessonRes.data || [];
  const courseAssignments = (allCourseAssignments || []).filter(a => a.status === 'published');
  const container = document.getElementById('pageContent');
  if (!container) return;

  const backAction = fromMyCourses ? 'renderMyCourses()' : 'renderCourses()';
  const backLabel = fromMyCourses ? '← Back to My Courses' : '← Back to Catalog';

  const topicsWithLessons = topics.map(t => ({
      ...t,
      lessons: lessons.filter(l => l.topic_id === t.id).sort((a, b) => a.order_index - b.order_index)
  })).sort((a, b) => a.order_index - b.order_index);

  const uncategorizedLessons = lessons.filter(l => !l.topic_id).sort((a, b) => a.order_index - b.order_index);

  container.innerHTML = `
    <button class="button secondary w-auto mb-15" onclick="${backAction}">${backLabel}</button>
    <div class="grid-2 mt-20">
      <section class="card">
        <h3 class="m-0">Lessons</h3>
        <div class="mt-15">
            ${topicsWithLessons.map(t => `
                <div class="mb-20">
                    <div class="p-10 bg-light border-radius-sm mb-5">
                        <strong class="small">${escapeHtml(t.title)}</strong>
                        ${t.description ? `<div class="tiny text-muted m-0 mt-2">${UI.renderRichText(t.description)}</div>` : ''}
                    </div>
                    <div class="pl-15">
                        ${t.lessons.map(l => `
                            <div class="question py-10" style="cursor:pointer; border-bottom: 1px solid #eee" onclick="showLesson('${escapeAttr(l.id)}', '${escapeAttr(courseId)}', ${fromMyCourses})">
                                <span class="small bold">${escapeHtml(l.title)}</span>
                            </div>
                        `).join('') || '<p class="tiny text-muted italic p-5">No lessons in this topic.</p>'}
                    </div>
                </div>
            `).join('')}

            ${uncategorizedLessons.length > 0 ? `
                <div class="mb-20">
                    <div class="p-10 bg-light border-radius-sm mb-5">
                        <strong class="small italic">Other Lessons</strong>
                    </div>
                    <div class="pl-15">
                        ${uncategorizedLessons.map(l => `
                            <div class="question py-10" style="cursor:pointer; border-bottom: 1px solid #eee" onclick="showLesson('${escapeAttr(l.id)}', '${escapeAttr(courseId)}', ${fromMyCourses})">
                                <span class="small bold">${escapeHtml(l.title)}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}

            ${topics.length === 0 && uncategorizedLessons.length === 0 ? '<p class="small">No lessons yet.</p>' : ''}
        </div>
      </section>
      <section class="card">
        <h3 class="m-0">Course Assignments</h3>
        <div class="mt-15">
            ${courseAssignments.map(a => `
                <div class="question">
                    <strong class="bold">${escapeHtml(a.title)}</strong>
                    <p class="small mt-5">Due: ${new Date(a.due_date).toLocaleString()}</p>
                    <button class="button small w-auto mt-10" onclick="renderAssignments()">Go to Assignments</button>
                </div>
            `).join('') || '<p class="small">No assignments yet.</p>'}
        </div>
      </section>
    </div>`;
  } catch (error) {
    console.error('View course error:', error);
    const container = document.getElementById('pageContent');
    if (container) {
        container.innerHTML = `<div class="stat-card danger">
          <h3>Error Loading Course</h3>
          <div class="small danger-text">${escapeHtml(error.message)}</div>
          <button class="button w-auto mt-10" onclick="viewCourse('${escapeAttr(courseId)}', ${fromMyCourses})">Retry</button>
        </div>`;
    }
  }
}
async function showLesson(lessonId, courseId, fromMyCourses = false) {
  const renderId = ++window.currentRenderId;
  try {
  const lessonRes = await SupabaseDB.getLessons(courseId);
  if (renderId !== window.currentRenderId) return;
  const lessons = lessonRes.data || [];
  const lesson = lessons.find(l => l.id === lessonId);
  const container = document.getElementById('pageContent');
  if (!container) return;

  // Automate Focus Timer: Start session when lesson is viewed
  startStudySession(courseId);

  // Track lesson completion
  const user = await SessionManager.getCurrentUser();
  if (user && user.role === 'student') {
      SupabaseDB.markLessonComplete(courseId, user.email, lessonId).catch(e => console.warn('Completion tracking failed:', e));
  }

  let videoHtml = '';
  if (lesson.video_url) {
      const vidId = extractYoutubeId(lesson.video_url);
      if (vidId) {
          videoHtml = `<div class="video-container mb-20" style="position:relative; padding-bottom:56.25%; height:0; overflow:hidden; border-radius:8px">
            <iframe src="https://www.youtube.com/embed/${vidId}" style="position:absolute; top:0; left:0; width:100%; height:100%; border:none" allowfullscreen></iframe>
          </div>`;
      } else if (lesson.video_url.includes('youtube.com') || lesson.video_url.includes('youtu.be')) {
          videoHtml = `<div class="card danger-border small">Invalid video ID detected. For security, this embed has been blocked.</div>`;
      } else {
          videoHtml = `<div class="mb-20"><video src="${escapeAttr(lesson.video_url)}" controls style="width:100%; border-radius:8px; background:#000"></video></div>`;
      }
  }

  container.innerHTML = `
    <button class="button secondary w-auto mb-15" onclick="viewCourse('${escapeAttr(courseId)}', ${fromMyCourses})">← Back to Lessons</button>
    <div class="card">
      <h2 class="m-0 mb-20">${escapeHtml(lesson.title)}</h2>
      ${videoHtml}
      <div class="mt-20" style="line-height:1.6">${UI.renderRichText(lesson.content)}</div>
    </div>`;
  } catch (error) {
    console.error('Show lesson error:', error);
    const container = document.getElementById('pageContent');
    if (container) {
      container.innerHTML = `<div class="stat-card danger">
        <h3>Error Loading Lesson</h3>
        <div class="small danger-text">${escapeHtml(error.message)}</div>
        <button class="button w-auto mt-10" onclick="showLesson('${escapeAttr(lessonId)}', '${escapeAttr(courseId)}', ${fromMyCourses})">Retry</button>
      </div>`;
    }
  }
}

async function stopAndNavigateToViewCourse(courseId, fromMyCourses) {
  if (StudentState.studyInterval) await stopStudySession();
  viewCourse(courseId, fromMyCourses);
}
window.stopAndNavigateToViewCourse = stopAndNavigateToViewCourse;
async function renderAssignments(openId = null){
  const renderId = ++window.currentRenderId;
  const container = document.getElementById('pageContent');
  if (!container) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    if(!user || user.role!=='student'){ UI.showNotification('Login as student'); window.location.href='index.html'; return; }

    const enrollRes = await SupabaseDB.getEnrollments(user.email);
    if (renderId !== window.currentRenderId) return;
    const enrollments = enrollRes.data || [];
    const enrolledCourseIds = enrollments.map(e => e.course_id);

    const [{ data: courses }, { data: allAssignments, total }, { data: submissions }] = await Promise.all([
      SupabaseDB.getEnrolledCourses(user.email),
      SupabaseDB.getAssignments(null, null, enrolledCourseIds),
      SupabaseDB.getSubmissions(null, user.email, null)
    ]);
    if (renderId !== window.currentRenderId) return;

    const now = TimerManager.getTime();

    container.innerHTML = `
      <div class="flex-between mb-20">
        <h2 class="m-0">Assignments</h2>
        <div class="small text-muted">${total} Total</div>
      </div>
      <div class="card" style="padding:0; overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Assignment</th>
              <th>Course</th>
              <th>Due Date</th>
              <th>Status</th>
              <th>Grade</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="assignTableBody"></tbody>
        </table>
      </div>

      <div id="assignmentForm" class="hidden" style="margin-top:20px"></div>
    `;

  const tbody = document.getElementById('assignTableBody');
  if(!allAssignments.length){ tbody.innerHTML = '<tr><td colspan="6" class="empty">No assignments found.</td></tr>'; return; }

  allAssignments.forEach(a => {
    if (a.status !== 'published') return;

    const submission = submissions.find(s => s.assignment_id === a.id);
    const startAt = a.start_at ? new Date(a.start_at).getTime() : 0;
    const isUpcoming = startAt > now;

    // Check if it's past due and late submissions are NOT allowed
    const dueDate = new Date(a.due_date);
    const isPastDue = dueDate.getTime() < now;
    if (isPastDue && !a.allow_late_submissions && !submission) return;

    const course = courses.find(c => c.id === a.course_id);
    const isOverdue = dueDate.getTime() < now && !submission;

    let statusHtml = '';
    if (submission) {
      const badgeClass = submission.status === 'graded' ? 'badge-active' : 'badge-warn';
      statusHtml = `<span class="badge ${badgeClass}">${submission.status.toUpperCase()}</span>`;
    } else if (isOverdue) {
      statusHtml = `<span class="badge badge-inactive">OVERDUE</span>`;
    } else if (isUpcoming) {
      const createdAtTs = a.created_at ? new Date(a.created_at).getTime() : now;
      statusHtml = `<div class="assign-open-countdown" data-target="${startAt}" data-start="${createdAtTs}" data-status="${a.status || 'published'}"></div>`;
    } else {
      statusHtml = `<span class="badge" style="background:#edf2f7; color:#4a5568">PENDING</span>`;
    }

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>
        <div style="font-weight:600">${escapeHtml(a.title)}</div>
        <div class="small">${UI.renderRichText((a.description || '').substring(0, 80))}...</div>
      </td>
      <td>${escapeHtml(course?.title || 'Unknown')}</td>
      <td>
        <div class="${isOverdue ? 'danger-text' : ''}">${dueDate.toLocaleDateString()}</div>
        ${isOverdue ? '<div class="small danger-text">(Overdue)</div>' : ''}
        ${!isOverdue && !submission && !isUpcoming ? `<div class="assign-due-countdown" data-target="${dueDate.getTime()}" data-start="${startAt || (a.created_at ? new Date(a.created_at).getTime() : now)}" data-status="${a.status || 'published'}"></div>` : ''}
      </td>
      <td>${statusHtml}</td>
      <td>${submission?.grade !== undefined && submission?.grade !== null ? `
          <div class="success-text bold">${submission.final_grade}%</div>
          <div class="tiny text-muted">${submission.grade} / ${a.points_possible}</div>
        ` : '-'}</td>
      <td>
        <div class="flex gap-5">
          ${isUpcoming ? `
              <span class="badge badge-warn">UPCOMING</span>
            ` : !submission ?
            `<button class="button small w-auto ${isOverdue ? 'danger' : ''}" onclick="showAssignmentForm('${a.id}')">${isOverdue ? 'Submit Late' : 'Submit'}</button>` :
            (submission.status === 'submitted' || submission.status === 'draft' ?
              `<button class="button secondary small w-auto" onclick="showAssignmentForm('${a.id}')">View/Edit</button>` :
              `<span class="badge badge-active">GRADED</span>`)
          }
        </div>
      </td>
    `;
    tbody.appendChild(row);
    });

  // Initialize countdowns
  Countdown.createAll('.assign-open-countdown', {
      showProgress: true,
      compact: true,
      label: 'Opens in:',
      onEnd: () => renderAssignments()
  }).forEach(c => StudentState.activeCountdowns.push(c));

  Countdown.createAll('.assign-due-countdown', {
      showProgress: true,
      compact: true,
      label: 'Due in:',
      onEnd: () => {
          if (!document.getElementById('assignmentForm') || document.getElementById('assignmentForm').classList.contains('hidden')) {
              renderAssignments();
          }
      }
  }).forEach(c => StudentState.activeCountdowns.push(c));

  if (openId) {
      showAssignmentForm(openId);
  }

  } catch (error) {
    console.error('Assignments error:', error);
    container.innerHTML = `<div class="card" style="border-left: 4px solid var(--danger)">
      <h3>Error Loading Assignments</h3>
      <div class="small" style="color:var(--danger)">${escapeHtml(error.message)}</div>
      <button class="button" onclick="renderAssignments()" style="margin-top:10px; width:auto">Retry</button>
    </div>`;
  }
}

async function showAssignmentForm(assignmentId) {
  const renderId = window.currentRenderId;
  const formWrap = document.getElementById('assignmentForm');
  if (formWrap) {
      formWrap.classList.remove('hidden');
      formWrap.style.display = 'block';
      formWrap.scrollIntoView({ behavior: 'smooth' });
  }

  const user = await SessionManager.getCurrentUser();
  if (renderId !== window.currentRenderId) return;
  const [a, submission] = await Promise.all([
    SupabaseDB.getAssignment(assignmentId),
    SupabaseDB.getSubmission(assignmentId, user.email)
  ]);
  if (renderId !== window.currentRenderId) return;

  const now = new Date();
  const startAt = a.start_at ? new Date(a.start_at) : null;
  if (startAt && now < startAt) {
      UI.showNotification('This assignment is not open for submission yet.');
      if (formWrap) formWrap.style.display = 'none';
      return;
  }

  if (!formWrap) return;

  // Initialize Anti-Cheat if configured
  if (a.anti_cheat_config && Object.values(a.anti_cheat_config).some(v => v === true)) {
    AntiCheat.init(a.id, 'assignment', user.email, {
        ...a.anti_cheat_config,
        callbacks: {
            onViolation: (v) => {
                UI.showNotification(`Security Violation: ${v.type.replace(/_/g, ' ')} detected and logged.`, 'danger');
            }
        }
    });
  }
  const dueDate = new Date(a.due_date);
  const isLate = now > dueDate;

  formWrap.innerHTML = `
    <div class="card">
      <div class="flex-between">
        <h3 class="m-0">${submission ? 'Review' : 'Submit'}: ${escapeHtml(a.title)}</h3>
        <button class="button secondary w-auto small" onclick="const f=document.getElementById('assignmentForm'); f.classList.add('hidden'); f.style.display='none'; AntiCheat.destroy();">Close</button>
      </div>

      <div class="small mt-10 mb-10 p-10 bg-light border-radius-sm">${UI.renderRichText(a.description)}</div>

      ${submission && submission.status === 'submitted' ? `
        <div class="card success-border p-10 mt-10" style="background:#f0fff4">
            <div class="bold success-text">SUBMITTED</div>
            <p class="small">You have already submitted this assignment. You can update your submission below.</p>
        </div>
      ` : ''}

      ${isLate && !submission ? `
        <div class="card danger-border p-10 mt-10">
            <div class="bold danger-text">LATE SUBMISSION</div>
            <p class="small">The due date was ${dueDate.toLocaleString()}. A late penalty of ${a.late_penalty_per_day}% per day will be applied.</p>
        </div>
      ` : ''}

      ${a.attachments && a.attachments.length > 0 ? `
        <div class="mt-20">
            <h4 class="m-0 mb-10">Supporting Materials</h4>
            <div class="grid" style="gap:10px">
                ${a.attachments.map(att => `
                    <div class="flex-between list-item p-10">
                        <span class="small bold">${escapeHtml(att.name)}</span>
                        <button class="button secondary tiny w-auto" onclick="UI.viewFile('${escapeAttr(att.url)}', '${escapeAttr(att.name)}')">View / Download</button>
                    </div>
                `).join('')}
            </div>
        </div>
      ` : ''}

      <div id="qwrap-${a.id}" class="mt-20"></div>
      <div class="flex gap-10 mt-20 flex-wrap">
        <button class="button w-auto px-40" id="submitAssignBtn" onclick="submitAssignment('${a.id}', '${user.email}', false)">Submit Assignment</button>
        <button class="button secondary w-auto px-40" id="saveDraftBtn" onclick="submitAssignment('${a.id}', '${user.email}', true)">Save Draft</button>
        ${submission ? `<button class="button danger w-auto px-40" onclick="deleteSubmissionById('${a.id}', '${user.email}')">Delete Submission</button>` : ''}
      </div>
    </div>
  `;

  const qwrap = formWrap.querySelector(`#qwrap-${a.id}`);
  const submissionAnswers = submission?.answers || {};

  (a.questions || []).forEach((q, idx) => {
    const qDiv = document.createElement('div');
    qDiv.className = 'question mb-30';
    qDiv.id = `question-${idx}`;

    const allowedTypes = q.types || (q.type ? [q.type] : []);
    const answerObj = submissionAnswers[idx];
    const legacyAnswer = typeof answerObj === 'string' ? answerObj : null;
    const activeType = (typeof answerObj === 'object' && answerObj?.type) ? answerObj.type : (legacyAnswer ? (q.type || allowedTypes[0]) : allowedTypes[0]);
    const activeValue = (typeof answerObj === 'object') ? (answerObj?.value || '') : (legacyAnswer || '');

    qDiv.setAttribute('data-active-type', activeType);

    let switcherHtml = '';
    if (allowedTypes.length > 1) {
        switcherHtml = `
            <div class="flex gap-10 mb-15">
                <span class="tiny bold text-muted uppercase">Method:</span>
                ${allowedTypes.map(t => `
                    <button type="button" class="button tiny w-auto q-type-btn ${activeType === t ? '' : 'secondary'}"
                            data-type="${t}" onclick="switchSubmissionType(${idx}, '${t}')">
                        ${t === 'essay' ? 'Essay' : t === 'file' ? 'File' : 'Link'}
                    </button>
                `).join('')}
            </div>
        `;
    }

    const essayHtml = `
        <div class="q-input-wrapper" data-type="essay" style="${activeType === 'essay' ? '' : 'display:none'}">
            <textarea class="input q-essay" rows="6" placeholder="Your answer" data-q-idx="${idx}">${activeType === 'essay' ? escapeHtml(activeValue) : ''}</textarea>
        </div>
    `;

    const fileHtml = `
        <div class="q-input-wrapper" data-type="file" style="${activeType === 'file' ? '' : 'display:none'}">
            <div class="small mb-5">Upload File ${q.extensions ? `(${escapeHtml(q.extensions)})` : ''}:</div>
            <input type="file" class="input q-file" data-q-idx="${idx}" accept="${q.extensions || '*'}" onchange="previewFile(this, '${idx}')">
            <div id="preview-${idx}" class="mt-8">
                ${(activeType === 'file' && activeValue) ? `<button type="button" class="button secondary tiny w-auto" onclick="UI.viewFile('${escapeAttr(activeValue)}', 'Current Submission')">View Current File</button>` : '<span class="small text-muted italic">No file uploaded</span>'}
            </div>
        </div>
    `;

    const linkHtml = `
        <div class="q-input-wrapper" data-type="link" style="${activeType === 'link' ? '' : 'display:none'}">
            <div class="small mb-5">Submission Link:</div>
            <input type="url" class="input q-link" placeholder="https://..." data-q-idx="${idx}" value="${activeType === 'link' ? escapeHtml(activeValue) : ''}">
        </div>
    `;

    let inputsHtml = '';
    allowedTypes.forEach(t => {
        if (t === 'essay') inputsHtml += essayHtml;
        else if (t === 'file') inputsHtml += fileHtml;
        else if (t === 'link') inputsHtml += linkHtml;
    });

    qDiv.innerHTML = `
      <div class="flex-between mb-10">
        <div class="bold">Q${idx + 1}. ${UI.renderRichText(q.text || '')}</div>
        <div class="badge badge-lock">${q.points || 0} pts</div>
      </div>
      ${switcherHtml}
      <div class="q-inputs-container mt-10">
        ${inputsHtml}
      </div>
    `;
    qwrap.appendChild(qDiv);
  });
  formWrap.scrollIntoView({ behavior: 'smooth' });
}

window.previewFile = function(input, idx) {
  const preview = document.getElementById(`preview-${idx}`);
  if (input.files && input.files[0]) {
    preview.innerHTML = `<span class="small bold text-success">Selected: ${escapeHtml(input.files[0].name)}</span>`;
  }
};

window.switchSubmissionType = function(qIdx, type) {
    const qDiv = document.getElementById(`question-${qIdx}`);
    if (!qDiv) return;

    qDiv.setAttribute('data-active-type', type);

    // Update buttons
    qDiv.querySelectorAll('.q-type-btn').forEach(btn => {
        if (btn.getAttribute('data-type') === type) {
            btn.classList.remove('secondary');
        } else {
            btn.classList.add('secondary');
        }
    });

    // Update visibility
    qDiv.querySelectorAll('.q-input-wrapper').forEach(wrapper => {
        wrapper.style.display = wrapper.getAttribute('data-type') === type ? 'block' : 'none';
    });
};

async function viewFeedback(assignmentId) {
  const renderId = ++window.currentRenderId;
  const user = await SessionManager.getCurrentUser();
  try {
  const [assignment, submission] = await Promise.all([
    SupabaseDB.getAssignment(assignmentId),
    SupabaseDB.getSubmission(assignmentId, user.email)
  ]);
  if (renderId !== window.currentRenderId) return;

  const now = TimerManager.getTime();
  if (assignment.start_at && new Date(assignment.start_at).getTime() > now) {
      UI.showNotification('This assignment is not available yet.');
      return;
  }

  const container = document.getElementById('pageContent');
  if (!container) return;

  container.innerHTML = `
    <button class="button secondary w-auto mb-10" onclick="renderAssignments()">← Back to Assignments</button>
    <div class="card">
      <div class="flex-between">
        <h2 class="m-0">Feedback: ${escapeHtml(assignment.title)}</h2>
        <div class="text-right">
          <div class="bold" style="font-size:32px; color:var(--purple)">${submission.grade || 0} / ${assignment.points_possible}</div>
          <div class="bold" style="font-size:20px; color:var(--purple)">${submission.final_grade || 0}%</div>
          <div class="small">Final Grade</div>
        </div>
      </div>

      <div class="grid-2 mt-20 p-15" style="background:var(--bg); border-radius:8px">
        <div>
          <div class="small">Status:</div>
          <div class="bold">${submission.status.toUpperCase()}</div>
        </div>
      </div>

      ${assignment.attachments && assignment.attachments.length > 0 ? `
        <div class="mt-20">
            <h4 class="m-0 mb-10">Assignment Materials</h4>
            <div class="grid" style="gap:10px">
                ${assignment.attachments.map(att => `
                    <div class="flex-between list-item p-10">
                        <span class="small bold">${escapeHtml(att.name)}</span>
                        <button class="button secondary tiny w-auto" onclick="UI.viewFile('${escapeAttr(att.url)}', '${escapeAttr(att.name)}')">View</button>
                    </div>
                `).join('')}
            </div>
        </div>
      ` : ''}

      <div class="mt-20 pt-20" style="border-top:1px solid var(--border)">
        <h4>Your Submission & Grades</h4>
        <div class="mt-15">
          ${(assignment.questions || []).map((q, idx) => {
            const answerObj = submission.answers[idx];
            const isStructured = typeof answerObj === 'object' && answerObj !== null && answerObj.type;
            const type = isStructured ? answerObj.type : (typeof answerObj === 'string' && isValidUrl(answerObj) ? 'file' : 'essay');
            const value = isStructured ? answerObj.value : answerObj;

            const score = submission.question_scores?.[idx] || 0;

            let displayAnswer = '<div class="small p-10 mt-5 text-muted italic">No answer provided.</div>';
            if (value) {
                if (type === 'essay') {
                    displayAnswer = `<div class="small p-10 mt-5" style="background: #f7fafc; border-radius: 4px;">${UI.renderRichText(value)}</div>`;
                } else {
                    displayAnswer = `<div class="mt-5 flex gap-10">
                        <span class="badge badge-purple tiny">${type.toUpperCase()}</span>
                        <button type="button" class="button secondary small w-auto" onclick="UI.viewFile('${escapeAttr(value)}', 'Question ${idx + 1} Submission')">View Submitted ${type === 'link' ? 'Link' : 'File'}</button>
                    </div>`;
                }
            }

            return `<div class="list-item mb-20 card border-light">
              <div class="flex-between">
                <div class="bold">Question ${idx + 1}: ${UI.renderRichText(q.text)}</div>
                <div class="badge ${score >= (q.points * 0.7) ? 'badge-active' : 'badge-warn'}">${score} / ${q.points} pts</div>
              </div>
              <div class="mt-10">${displayAnswer}</div>
              ${submission.question_feedback?.[idx] ? `
                <div class="mt-10 p-10 bg-light border-radius-sm">
                  <div class="tiny text-muted bold">Teacher Comment:</div>
                  <div class="small italic">${UI.renderRichText(submission.question_feedback[idx])}</div>
                </div>
              ` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="mt-20 pt-20" style="border-top:1px solid var(--border)">
        <h4>Teacher Feedback</h4>
        <div class="small p-15" style="background:#fffcf0; border-radius:8px; border:1px solid #ffeeba">${UI.renderRichText(submission.feedback || 'No written feedback yet.')}</div>
      </div>

      <div class="mt-20 pt-20" style="border-top:1px solid var(--border)">
        <h4>Request Regrade</h4>
        <p class="small">If you believe there is a mistake in your grade, provide a reason below.</p>
        <textarea id="regradeReason" class="input" rows="3" placeholder="Reason for regrade..."></textarea>
        <button class="button secondary w-auto mt-10" onclick="requestRegrade('${escapeAttr(assignmentId)}')">Submit Regrade Request</button>
      </div>

    </div>
  `;
  } catch (error) {
    console.error('View feedback error:', error);
    const container = document.getElementById('pageContent');
    if (container) {
      container.innerHTML = `<div class="stat-card danger">
        <h3>Error Loading Feedback</h3>
        <div class="small danger-text">${escapeHtml(error.message)}</div>
        <button class="button w-auto mt-10" onclick="viewFeedback('${escapeAttr(assignmentId)}')">Retry</button>
      </div>`;
    }
  }
}


async function renderDashboardOverview() {
  const renderId = ++window.currentRenderId;
  NotificationManager.init();
  clearActiveCountdowns();
  const container = document.getElementById('pageContent');
  if (!container) return;

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;

    const [enrollRes, gradedCount, violationsCount] = await Promise.all([
      SupabaseDB.getEnrollments(user.email),
      SupabaseDB.getCount('submissions', q => q.eq('student_email', user.email).eq('status', 'graded')),
      SupabaseDB.getCount('violations', q => q.eq('user_email', user.email))
    ]);
    if (renderId !== window.currentRenderId) return;
    const enrollments = enrollRes.data || [];

    const enrolledCourseIds = enrollments.map(e => e.course_id);

    const [{ data: assigns }, { data: submissions }] = await Promise.all([
        SupabaseDB.getAssignments(null, null, enrolledCourseIds),
        SupabaseDB.getSubmissions(null, user.email, null)
    ]);
    if (renderId !== window.currentRenderId) return;

    updateHeaderStats().catch(e => console.warn('Header stats error:', e));
    const now = TimerManager.getTime();

    const pendingAssignments = assigns.filter(a =>
      a.status === 'published' &&
      !submissions.some(s => s.assignment_id === a.id) &&
      new Date(a.due_date).getTime() > now
    ).sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

    container.innerHTML = `
      <h2>Welcome Back, ${escapeHtml(user.full_name)}!</h2>
      <div class="stats-grid">
        <div class="stat-card"><h4>Enrolled Courses</h4><div class="value">${escapeHtml(enrollments.length)}</div></div>
        <div class="stat-card"><h4>Completed Assignments</h4><div class="value">${escapeHtml(gradedCount)}</div></div>
        <div class="stat-card ${violationsCount > 0 ? 'danger' : ''}">
          <h4>Security Violations</h4>
          <div class="value">${escapeHtml(violationsCount)}</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <h3>Recent Activity</h3>
          <p class="small">You have ${escapeHtml(enrollments.length)} active courses. Check your assignments to stay on track!</p>
        </div>

        <div class="card">
          <h3>Upcoming Assignments</h3>
          <div class="mt-15">
            ${pendingAssignments.slice(0, 5).map(a => `
              <div class="flex-between list-item" style="align-items: flex-start">
                <div style="flex: 1">
                  <div class="bold">${escapeHtml(a.title)}</div>
                  <div class="tiny text-muted mb-5">Due: ${new Date(a.due_date).toLocaleDateString()}</div>
                  <div class="dashboard-assign-countdown" data-target="${new Date(a.due_date).getTime()}" data-start="${a.start_at || (a.created_at ? new Date(a.created_at).getTime() : now)}" data-status="${a.status || 'published'}"></div>
                </div>
                <button class="button small w-auto mt-10" style="width: 80px" onclick="renderAssignments('${a.id}')">Submit</button>
              </div>
            `).join('') || '<p class="small">No pending assignments! Good job.</p>'}
            ${pendingAssignments.length > 5 ? `<button class="button secondary small w-100 mt-10" onclick="renderAssignments()">View All Assignments</button>` : ''}
          </div>
        </div>
      </div>
    `;

    Countdown.createAll('.dashboard-assign-countdown', {
        showProgress: true,
        compact: true,
        label: 'Due in:',
        onEnd: () => renderDashboardOverview()
    }).forEach(c => StudentState.activeCountdowns.push(c));
  } catch (error) {
    console.error('Dashboard error:', error);
    container.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Dashboard</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderDashboardOverview()">Retry</button>
    </div>`;
  }
}

async function renderProgress() {
  const renderId = ++window.currentRenderId;
  clearActiveCountdowns();
  const container = document.getElementById('pageContent');
  if (!container) return;

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const [sessionsRes, enrollRes, { data: courses }] = await Promise.all([
      SupabaseDB.getStudySessions(user.email),
      SupabaseDB.getEnrollments(user.email),
      SupabaseDB.getCourses(null, null)
    ]);
    if (renderId !== window.currentRenderId) return;
    const sessions = sessionsRes.data || [];
    const enrollments = enrollRes.data || [];

  const totalSeconds = sessions.reduce((acc, s) => acc + s.duration, 0);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);

  container.innerHTML = `
    <h2 class="m-0">My Progress & Study Tracking</h2>
    <div class="grid-2 mt-20 mb-20">
      <div class="card">
        <h3 class="m-0">Total Study Time</h3>
        <div class="bold mt-10" style="font-size:32px; color:var(--purple);">${h}h ${m}m</div>
        <p class="small mt-5">Logged across ${sessions.length} sessions</p>
      </div>
    </div>

    <div class="card">
      <h3 class="m-0">Focus Tracking</h3>
      <p class="small mt-5">Your study time is automatically tracked while viewing lessons.</p>
      <div id="studyTimerDisplay" class="bold mt-10" style="font-size:24px; display:none">00:00:00</div>
    </div>

    <div class="card mt-20">
      <h3 class="m-0">Recent Sessions</h3>
      <div class="mt-15">
        ${sessions.slice(0, 5).map(s => {
          const c = courses.find(x => x.id === s.course_id);
          return `<div class="flex-between list-item">
            <span>${escapeHtml(c?.title || 'Course')}</span>
            <span class="small">${Math.floor(s.duration / 60)}m logged on ${new Date(s.started_at).toLocaleDateString()}</span>
          </div>`;
        }).join('') || '<div class="empty">No sessions logged yet.</div>'}
      </div>
    </div>
  `;
  } catch (e) {
    console.error('Progress render error:', e);
    container.innerHTML = `<div class="empty">Error loading progress.</div>`;
  }
}


async function startStudySession(courseId) {
    if (StudentState.studyInterval) {
        if (StudentState.currentStudyCourseId === courseId) return;
        await stopStudySession();
    }

    StudentState.currentStudyCourseId = courseId;
    StudentState.studyStartTime = new Date();

    if (!StudentState.studyInterval) {
        // Start
        StudentState.studyStartTime = new Date();
        const display = document.getElementById('studyTimerDisplay');
        if (display) display.style.display = 'block';
    }

    StudentState.studyInterval = setInterval(() => {
        const elapsed = Math.floor((new Date() - StudentState.studyStartTime) / 1000);
        const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
        const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
        const s = (elapsed % 60).toString().padStart(2, '0');
        const display = document.getElementById('studyTimerDisplay');
        if (display) display.textContent = `${h}:${m}:${s}`;
    }, 1000);
}

async function stopStudySession() {
    if (!StudentState.studyInterval) return;

    const _startTime = StudentState.studyStartTime;
    const _courseId = StudentState.currentStudyCourseId;

    clearInterval(StudentState.studyInterval);
    StudentState.studyInterval = null;
    StudentState.studyStartTime = null;
    StudentState.currentStudyCourseId = null;

    const endTime = new Date();
    const duration = Math.floor((endTime - _startTime) / 1000);

    if (duration > 10) { // Only save if more than 10 seconds
        const user = await SessionManager.getCurrentUser();
        if (user && _courseId) {
            try {
                const payload = {
                    user_email: user.email,
                    course_id: _courseId,
                    duration: duration,
                    started_at: _startTime.toISOString(),
                    ended_at: endTime.toISOString()
                };

                // If browser supports sendBeacon and we're unloading, use it
                // Otherwise, normal save
                await SupabaseDB.saveStudySession(payload);
                UI.showNotification(`Study session saved: ${Math.floor(duration/60)} minutes logged!`, 'success');

                // Update Progress
                await SupabaseDB.updateCourseProgress(_courseId, user.email);
            } catch (e) {
                console.warn('Failed to save study session:', e);
            }
        }
    }
}

window.startStudySession = startStudySession;
window.stopStudySession = stopStudySession;

async function renderGrades() {
  const renderId = ++window.currentRenderId;
  clearActiveCountdowns();
  const container = document.getElementById('pageContent');
  if (!container) return;

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const now = TimerManager.getTime();
    // Optimization: Filter graded status on the server
    const [{ data: submissions }, { data: assigns }] = await Promise.all([
      SupabaseDB.getSubmissions(null, user.email, null, { status: 'graded' }),
      SupabaseDB.getAssignments(null, null, null)
    ]);
    if (renderId !== window.currentRenderId) return;

    // Sort graded submissions by date
    const graded = submissions.sort((a,b) => new Date(a.submitted_at) - new Date(b.submitted_at));

    container.innerHTML = `
      <div class="flex-between">
        <h2 class="m-0">My Grades</h2>
        <button class="button secondary small w-auto" onclick="exportStudentGrades()">Export PDF</button>
      </div>
      <div class="card p-0 mt-20" style="overflow-x:auto">
        <table>
          <thead><tr><th>Assignment</th><th>Date</th><th>Grade</th><th>Feedback</th></tr></thead>
          <tbody>
            ${graded.map(s => {
              const a = assigns.find(x => x.id === s.assignment_id);
              return `<tr><td><strong class="bold">${escapeHtml(a?.title || 'Unknown')}</strong></td><td class="small">${new Date(s.submitted_at).toLocaleDateString()}</td><td><span class="badge ${s.final_grade >= 70 ? 'badge-active' : 'badge-inactive'}">${s.final_grade}%</span></td><td><div class="flex gap-5">${escapeHtml(s.feedback || '-')} ${a ? `<button class="button tiny w-auto success" onclick="viewFeedback('${a.id}')" style="background:var(--ok); margin-left:10px">View Details</button>` : ''}</div></td></tr>`;
            }).join('') || '<tr><td colspan="4" class="empty">No graded assignments yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;

    window.exportStudentGrades = async () => {
        const headers = ['Assignment', 'Date', 'Grade', 'Score'];
        const rows = graded.map(s => {
            const a = assigns.find(x => x.id === s.assignment_id);
            return [
                a?.title || 'Unknown',
                new Date(s.submitted_at).toLocaleDateString(),
                `${s.final_grade}%`,
                `${s.grade} / ${a?.points_possible || '-'}`
            ];
        });

        if (rows.length === 0) return UI.showNotification('No grades to export', 'warn');
        await Exporter.pdf('my_grades.pdf', 'My Academic Grades Report', headers, rows);
    };

  } catch (error) {
    console.error('Grades error:', error);
    container.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Grades</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderGrades()">Retry</button>
    </div>`;
  }
}

async function renderAnalytics() {
  const renderId = ++window.currentRenderId;
  clearActiveCountdowns();
  const container = document.getElementById('pageContent');
  if (!container) return;

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    // Optimization: Filter graded status on the server
    const [{ data: submissions }, { data: assigns }] = await Promise.all([
      SupabaseDB.getSubmissions(null, user.email, null, { status: 'graded' }),
      SupabaseDB.getAssignments(null, null, null)
    ]);
    if (renderId !== window.currentRenderId) return;

    // Sort graded submissions by date
    const graded = submissions.sort((a,b) => new Date(a.submitted_at) - new Date(b.submitted_at));

    container.innerHTML = `
      <h2 class="m-0">Performance Analytics</h2>
      <div class="grid-2 mt-20 mb-20">
        <div class="card">
          <h3 class="m-0">Grade Trends</h3>
          <div class="mt-15" style="height: 200px">
              <canvas id="gradeChart"></canvas>
          </div>
        </div>
        <div class="card">
          <h3 class="m-0">Performance Summary</h3>
          <div id="gradeStats" class="mt-15"></div>
        </div>
      </div>
    `;

    if (graded.length > 0) {
      const ctx = document.getElementById('gradeChart').getContext('2d');
      new Chart(ctx, {
        type: 'line',
        data: {
          labels: graded.map(s => {
            const a = assigns.find(x => x.id === s.assignment_id);
            return a ? a.title.substring(0, 10) + '...' : 'Assignment';
          }),
          datasets: [{
            label: 'Grade %',
            data: graded.map(s => s.final_grade),
            borderColor: '#5b2ea6',
            backgroundColor: 'rgba(91, 46, 166, 0.1)',
            tension: 0.3,
            fill: true
          }]
        },
        options: {
          scales: { y: { min: 0, max: 100 } },
          responsive: true,
          maintainAspectRatio: false
        }
      });

      const avg = Math.round(graded.reduce((acc, s) => acc + s.final_grade, 0) / graded.length);
      document.getElementById('gradeStats').innerHTML = `
        <div class="flex-center flex-column p-20">
          <div class="bold" style="font-size:48px; color:var(--purple)">${avg}%</div>
          <p class="small">Overall Average Score</p>
          <div class="flex-between w-auto gap-20 mt-15">
            <div class="text-center"><div class="bold">${graded.length}</div><div class="small">Graded</div></div>
            <div class="text-center"><div class="bold">${Math.max(...graded.map(s => s.final_grade))}%</div><div class="small">Highest</div></div>
          </div>
        </div>
      `;
    } else {
      document.getElementById('gradeStats').innerHTML = '<div class="empty">No data to display summary.</div>';
    }
  } catch (error) {
    console.error('Analytics error:', error);
    container.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Analytics</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderAnalytics()">Retry</button>
    </div>`;
  }
}


async function renderMaterials() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    // Reconcile any abandoned attempts on load
    try { await SupabaseDB.reconcileQuizAttempts(null, user.email); } catch(e) { console.warn('Reconciliation failed:', e); }

    const enrollRes = await SupabaseDB.getEnrollments(user.email);
    if (renderId !== window.currentRenderId) return;
    const enrollments = enrollRes.data || [];
    const enrolledIds = enrollments.map(e => e.course_id);

    const [{ data: myCourses }, materialsRes] = await Promise.all([
      SupabaseDB.getEnrolledCourses(user.email),
      SupabaseDB.getMaterials(null, enrolledIds)
    ]);
    if (renderId !== window.currentRenderId) return;
    const myMaterials = materialsRes.data || [];

    content.innerHTML = `
      <h2 class="m-0">Course Materials</h2>
      <div class="grid mt-20">
        ${myCourses.map(c => {
          const courseMaterials = myMaterials.filter(m => m.course_id === c.id);
          return `
            <div class="card">
              <h3 class="m-0">${escapeHtml(c.title)}</h3>
              <div class="mt-15">
                ${courseMaterials.map(m => `
                  <div class="flex-between list-item">
                    <span>${escapeHtml(m.title)}</span>
                    <div class="flex gap-5">
                      <button class="button small w-auto" onclick="UI.viewFile('${escapeAttr(m.file_url)}', '${escapeAttr(m.title)}')">View</button>
                      <a href="${m.file_url}" target="_blank" class="button secondary small w-auto">Download</a>
                    </div>
                  </div>
                `).join('') || '<p class="small">No materials shared for this course.</p>'}
              </div>
            </div>
          `;
        }).join('') || '<div class="empty">Enroll in courses to see shared materials.</div>'}
      </div>
    `;
  } catch (error) {
    console.error('Materials error:', error);
    content.innerHTML = `<div class="stat-card danger"><h3>Error Loading Materials</h3></div>`;
  }
}

async function renderDiscussions() {
  const renderId = ++window.currentRenderId;
  clearActiveCountdowns();
  const container = document.getElementById('pageContent');
  if (!container) return;

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const { data: myCourses } = await SupabaseDB.getEnrolledCourses(user.email);
    if (renderId !== window.currentRenderId) return;

    UI.renderCourseList('pageContent', myCourses, {
        title: 'Discussions',
        buttonText: 'View Discussion',
        onButtonClick: (id) => viewStudentDiscussions(id),
        emptyMessage: 'Enroll in a course to join discussions.'
    });
  } catch (e) {
    console.error('Discussions render error:', e);
    container.innerHTML = `<div class="empty">Error loading discussions.</div>`;
  }
}

async function viewStudentDiscussions(courseId) {
  const renderId = ++window.currentRenderId;
  try {
  const user = await SessionManager.getCurrentUser();
  if (renderId !== window.currentRenderId) return;
  const { data: disc } = await SupabaseDB.getDiscussions(courseId);
  if (renderId !== window.currentRenderId) return;
  const container = document.getElementById('pageContent');
  if (!container) return;

  container.innerHTML = `<button class="button secondary w-auto mb-10" onclick="renderDiscussions()">← Back</button><div id="discussionArea"></div>`;

  UI.renderDiscussion('discussionArea', disc, user.email, {
      onPost: async (content, parentId) => {
          if (await DiscussionManager.post(courseId, content, parentId)) viewStudentDiscussions(courseId);
      },
      onEdit: (id) => DiscussionManager.edit(id, async (id, content) => {
          const { data: disc } = await SupabaseDB.getDiscussions(courseId);
          const existing = disc.find(d => d.id === id);
          await SupabaseDB.saveDiscussion({ ...existing, content });
          viewStudentDiscussions(courseId);
          return true;
      }),
      onDelete: (id) => DiscussionManager.delete(id, () => viewStudentDiscussions(courseId))
  });
  } catch (error) {
    console.error('Discussions error:', error);
    if (container) {
      container.innerHTML = `<div class="stat-card danger">
        <h3>Error Loading Discussions</h3>
        <div class="small danger-text">${escapeHtml(error.message)}</div>
        <button class="button w-auto mt-10" onclick="viewStudentDiscussions('${escapeAttr(courseId)}')">Retry</button>
      </div>`;
    }
  }
}
window.enroll = enroll;
window.viewCourse = viewCourse;
window.showLesson = showLesson;
window.renderCourses = renderCourses;
window.renderMyCourses = renderMyCourses;
window.renderAssignments = renderAssignments;
window.renderQuizzes = renderQuizzes;
window.renderDashboardOverview = renderDashboardOverview;
window.renderProgress = renderProgress;
window.renderGrades = renderGrades;
window.renderAnalytics = renderAnalytics;
window.renderCalendar = renderCalendar;
window.renderMaterials = renderMaterials;
window.renderDiscussions = renderDiscussions;
window.renderCertificates = renderCertificates;
window.showCertificateDetails = showCertificateDetails;

async function showCertRequestModal() {
  const modal = document.getElementById('certRequestModal');
  const select = document.getElementById('requestCourseId');
  if(!modal || !select) return;

  try {
    const user = await SessionManager.getCurrentUser();
    const enrollments = await SupabaseDB.getEnrollments(user.email);

    const options = enrollments.data.map(e => `
      <option value="${escapeAttr(e.course_id)}">${escapeHtml(e.courses.title)}</option>
    `);

    if (enrollments.data.length > 0) {
        options.unshift('<option value="all">All Enrolled Courses (Notify all teachers)</option>');
    }

    select.innerHTML = options.join('') || '<option value="" disabled>No enrolled courses</option>';

    modal.classList.remove('hidden');
  } catch (e) {
    console.error('Show cert modal error:', e);
    UI.showNotification('Failed to load courses', 'error');
  }
}

async function submitCertRequest() {
  const btn = document.getElementById('submitRequestBtn');
  const courseId = document.getElementById('requestCourseId').value;
  const reason = document.getElementById('requestReason').value;

  if(!courseId) {
    UI.showNotification('Please select a course', 'warn');
    return;
  }

  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const user = await SessionManager.getCurrentUser();
    await SupabaseDB.requestCertificate(user.email, courseId, reason);
    UI.showNotification('Certificate request submitted successfully!', 'success');
    document.getElementById('certRequestModal').classList.add('hidden');
    renderCertificates();
  } catch (e) {
    console.error('Cert request error:', e);
    UI.showNotification('Failed to submit request', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Submit Request';
  }
}

window.showCertRequestModal = showCertRequestModal;
window.submitCertRequest = submitCertRequest;
window.renderPlanner = renderPlanner;
window.renderLiveClasses = renderLiveClasses;
window.renderSettings = renderSettings;
window.renderHelp = renderHelp;
window.showAssignmentForm = showAssignmentForm;
window.viewFeedback = viewFeedback;
window.submitAssignment = submitAssignment;
window.deleteSubmissionById = deleteSubmissionById;
window.startQuiz = startQuiz;
window.viewQuizResults = viewQuizResults;
window.selectQuizOption = selectQuizOption;
window.handleShortAnswer = handleShortAnswer;
window.autoSubmitQuiz = autoSubmitQuiz;
window.submitQuiz = submitQuiz;
window.addPlannerItem = addPlannerItem;
window.deletePlannerItem = deletePlannerItem;
function filterCatalog() { renderCourses(); }
window.filterCatalog = filterCatalog;
window.viewStudentDiscussions = viewStudentDiscussions;

async function renderCertificates() {
  const renderId = ++window.currentRenderId;
  clearActiveCountdowns();
  const container = document.getElementById('pageContent');
  if (!container) return;

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const certsRes = await SupabaseDB.getCertificates(user.email);
    if (renderId !== window.currentRenderId) return;
    let certs = certsRes.data || [];

    // Filter logic to auto-propagate: If a student has a consolidated request or record,
    // we prioritize it to ensure "only one certificate containing all courses" is displayed
    // as the primary tracking item.
    const hasConsolidated = certs.some(c => c.type === 'consolidated');
    if (hasConsolidated) {
        certs = certs.filter(c => {
            // If a consolidated record exists, we hide ALL individual 'single' course certificates
            // that are either pending OR already approved (if they are redundant with the master cert).
            // This strictly enforces the "only one certificate containing all courses" rule in the UI.
            if (c.type === 'single') {
                return false;
            }
            return true;
        });
    }

  container.innerHTML = `
    <div class="flex-between mb-30">
      <div>
        <h2 class="m-0">My Certificates</h2>
        <p class="small text-muted mt-5">View and download your earned certificates of completion.</p>
      </div>
      <button class="button small w-auto px-30" onclick="showCertRequestModal()">Request Certificate</button>
    </div>
    <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 25px;">
      ${certs.map(c => {
        const isApproved = c.status === 'approved';
        const title = c.courses?.title || (c.type === 'consolidated' ? 'Consolidated Certificate' : 'Course Certificate');
        const statusClass = c.status === 'approved' ? 'badge-active' : (c.status === 'rejected' ? 'badge-inactive' : 'badge-warn');

        return `
        <div class="card cert-card relative flex-column" style="padding: 0; overflow: hidden; transition: all 0.3s ease;">
          <div class="cert-card-header" style="height: 120px; background: ${isApproved ? 'linear-gradient(135deg, #5b2ea6 0%, #7c3aed 100%)' : '#f1f5f9'}; display: flex; align-items: center; justify-content: center; position: relative;">
            <div style="font-size: 50px; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.1));">${isApproved ? '📜' : '⏳'}</div>
            <div class="absolute top-10 right-10">
                <span class="badge ${statusClass} tiny" style="box-shadow: 0 2px 4px rgba(0,0,0,0.1);">${c.status.toUpperCase()}</span>
            </div>
          </div>

          <div class="p-20 flex-column flex-1">
            <h3 class="m-0 text-dark" style="font-size: 1.15rem; line-height: 1.4;">${escapeHtml(title)}</h3>
            <div class="flex-center-y gap-10 mt-10">
                <div class="tiny text-muted uppercase bold" style="letter-spacing: 0.5px;">Type: ${c.type.toUpperCase()}</div>
                <div style="width: 4px; height: 4px; border-radius: 50%; background: #cbd5e1;"></div>
                <div class="tiny text-muted">${new Date(c.updated_at).toLocaleDateString()}</div>
            </div>

            ${c.status === 'rejected' ? `
                <div class="mt-15 p-10 bg-light border-radius-sm" style="border: 1px solid #fee2e2;">
                    <div class="tiny bold danger-text uppercase mb-2">Rejection Reason</div>
                    <div class="small text-muted italic">${escapeHtml(c.metadata?.reason || 'No reason provided.')}</div>
                </div>
            ` : ''}

            <div class="flex gap-10 mt-auto pt-20">
              ${isApproved ? `
                <button class="button small w-auto px-15" onclick="UI.viewFile('${escapeAttr(c.certificate_url)}', 'Certificate - ${escapeAttr(title)}')">
                    <span style="margin-right: 6px;">👁️</span> View
                </button>
              ` : ''}
              <button class="button secondary small w-auto px-15" onclick="showCertificateDetails('${c.id}')">
                Details
              </button>
            </div>
          </div>
        </div>
      `}).join('') || '<div class="empty" style="grid-column: 1/-1;">No certificates earned yet. Finish a course to get one!</div>'}
    </div>

    <!-- Request Modal -->
    <div id="certRequestModal" class="modal-overlay hidden">
      <div class="modal-content card">
        <h3>Request Course Certificate</h3>
        <p class="small text-muted mb-15">Request a certificate for a course you have completed.</p>

        <label>Select Course</label>
        <select id="requestCourseId" class="mb-15">
          <!-- Populated dynamically -->
        </select>

        <label>Reason / Additional Info</label>
        <textarea id="requestReason" placeholder="e.g. Completed all lessons and passed final quiz..." rows="3"></textarea>

        <div class="flex gap-10 mt-20">
          <button class="button w-auto px-30" id="submitRequestBtn" onclick="submitCertRequest()">Submit Request</button>
          <button class="button secondary w-auto px-30" onclick="document.getElementById('certRequestModal').classList.add('hidden')">Cancel</button>
        </div>
      </div>
    </div>
  `;
  } catch (e) {
    console.error('Certificates render error:', e);
    container.innerHTML = `<div class="empty">Error loading certificates.</div>`;
  }
}

async function showCertificateDetails(certId) {
    try {
        const user = await SessionManager.getCurrentUser();
        const { data: certs } = await SupabaseDB.getCertificates(user.email);
        const cert = certs.find(c => c.id === certId);
        if (!cert) return;

        const title = cert.courses?.title || (cert.type === 'consolidated' ? 'Consolidated Certificate' : 'Course Certificate');
        const verificationId = cert.metadata?.verification_id;
        const verificationUrl = verificationId ? `${window.location.origin}/index.html?page=verify&id=${verificationId}` : null;

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.style.display = 'flex';
        backdrop.innerHTML = `
            <div class="modal animate-fade-in" style="max-width: 500px;">
                <div class="flex-between mb-20">
                    <h3 class="m-0">Certificate Details</h3>
                    <button class="button secondary tiny w-auto" onclick="this.closest('.modal-backdrop').remove()">✕</button>
                </div>

                <div class="flex-column gap-15">
                    <div class="card p-15" style="background: var(--bg);">
                        <label class="tiny text-muted uppercase bold">Title</label>
                        <div class="bold">${escapeHtml(title)}</div>
                    </div>

                    <div class="grid-2 gap-15">
                        <div class="card p-10" style="background: var(--bg);">
                            <label class="tiny text-muted uppercase bold">Status</label>
                            <div class="bold uppercase" style="font-size: 0.85rem;">${escapeHtml(cert.status)}</div>
                        </div>
                        <div class="card p-10" style="background: var(--bg);">
                            <label class="tiny text-muted uppercase bold">Type</label>
                            <div class="bold uppercase" style="font-size: 0.85rem;">${escapeHtml(cert.type)}</div>
                        </div>
                    </div>

                    <div class="card p-15" style="background: var(--bg);">
                        <label class="tiny text-muted uppercase bold">Issued On</label>
                        <div class="bold">${cert.issued_at ? new Date(cert.issued_at).toLocaleString() : 'N/A'}</div>
                    </div>

                    ${verificationId ? `
                    <div class="card p-15" style="background: #f0f4ff; border: 1px dashed var(--purple);">
                        <label class="tiny text-muted uppercase bold" style="color: var(--purple);">Verification Link</label>
                        <div class="flex-between mt-5 gap-10">
                            <input type="text" value="${escapeAttr(verificationUrl)}" readonly style="font-size: 0.75rem; margin: 0; background: #fff; border: 1px solid #d0d7de;">
                            <button class="button small w-auto" onclick="navigator.clipboard.writeText('${escapeAttr(verificationUrl)}'); UI.showNotification('Link copied!', 'success')">Copy</button>
                        </div>
                        <div class="tiny text-muted mt-5">Anyone with this link can verify the authenticity of your certificate.</div>
                    </div>
                    ` : ''}

                    <div class="flex gap-10 mt-10">
                        <button class="button secondary w-auto" onclick="this.closest('.modal-backdrop').remove()">Close</button>
                        ${(cert.status === 'approved' && cert.certificate_url) ? `<button class="button primary w-auto" onclick="UI.viewFile('${escapeAttr(cert.certificate_url)}', 'Certificate')">View Certificate</button>` : ''}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
    } catch (e) {
        console.error('Show cert details error:', e);
        UI.showNotification('Error loading details', 'error');
    }
}

async function renderPlanner() {
  const renderId = ++window.currentRenderId;
  clearActiveCountdowns();
  const container = document.getElementById('pageContent');
  if (!container) return;

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const itemsRes = await SupabaseDB.getPlannerItems(user.email);
    if (renderId !== window.currentRenderId) return;
    const items = itemsRes.data || [];

    const now = new Date();
    now.setHours(0,0,0,0);

    const todayTasks = items.filter(i => !i.completed && new Date(i.due_date).setHours(0,0,0,0) === now.getTime());
    const upcomingTasks = items.filter(i => !i.completed && new Date(i.due_date).setHours(0,0,0,0) > now.getTime());
    const overdueTasks = items.filter(i => !i.completed && new Date(i.due_date).setHours(0,0,0,0) < now.getTime());
    const completedTasks = items.filter(i => i.completed);

    const renderTask = (item) => {
      const priorityClass = item.priority === 'high' ? 'badge-inactive' : (item.priority === 'low' ? 'badge-active' : 'badge-warn');
      // Badge mapping: high -> inactive (red), medium -> warn (yellow), low -> active (green)
      return `
      <div class="flex-between list-item">
        <div class="flex-center-y gap-10">
          <input type="checkbox" class="w-auto m-0" ${item.completed ? 'checked' : ''} onchange="togglePlannerItem('${item.id}', this.checked)">
          <div class="${item.completed ? 'text-muted' : ''}" style="${item.completed ? 'text-decoration: line-through' : ''}">
            <div class="flex-center-y gap-5">
              <span class="bold small">${escapeHtml(item.title)}</span>
              ${item.priority ? `<span class="badge ${priorityClass} tiny" style="padding: 2px 6px; font-size: 9px">${item.priority.toUpperCase()}</span>` : ''}
            </div>
            <div class="tiny ${!item.completed && new Date(item.due_date) < now ? 'danger-text' : 'text-muted'}">${new Date(item.due_date).toLocaleDateString()}</div>
          </div>
        </div>
        <button class="button danger tiny w-auto" onclick="deletePlannerItem('${item.id}')">✕</button>
      </div>
    `;};

    container.innerHTML = `
      <div class="flex-between mb-20">
        <h2 class="m-0">Study Planner</h2>
        <div class="small text-muted">${items.length} tasks recorded</div>
      </div>

      <div class="card">
        <h3 class="m-0 small mb-15">Quick Add Task</h3>
        <div class="flex gap-10 flex-wrap">
          <input type="text" id="plannerTitle" placeholder="What needs to be done?" class="m-0" style="flex: 1; min-width: 200px">
          <input type="date" id="plannerDate" class="m-0" value="${new Date().toISOString().split('T')[0]}" style="width: 150px">
          <select id="plannerPriority" class="m-0" style="width: 120px">
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="high">High</option>
          </select>
          <button class="button w-auto px-30" onclick="addPlannerItem()">Add</button>
        </div>
      </div>

      <div class="grid-2 mt-20">
        <div class="flex-column gap-20">
          <div class="card">
            <h3 class="m-0 mb-10" style="color: var(--danger)">Overdue</h3>
            <div id="overdueList">
              ${overdueTasks.map(renderTask).join('') || '<p class="tiny text-muted italic">No overdue tasks.</p>'}
            </div>
          </div>
          <div class="card">
            <h3 class="m-0 mb-10" style="color: var(--purple)">Today</h3>
            <div id="todayList">
              ${todayTasks.map(renderTask).join('') || '<p class="tiny text-muted italic">Nothing scheduled for today.</p>'}
            </div>
          </div>
          <div class="card">
            <h3 class="m-0 mb-10">Upcoming</h3>
            <div id="upcomingList">
              ${upcomingTasks.map(renderTask).join('') || '<p class="tiny text-muted italic">No upcoming tasks.</p>'}
            </div>
          </div>
        </div>

        <div class="flex-column">
          <div class="card">
            <h3 class="m-0 mb-10" style="color: var(--ok)">Completed</h3>
            <div id="completedList" style="max-height: 400px; overflow-y: auto">
              ${completedTasks.map(renderTask).join('') || '<p class="tiny text-muted italic">Completed tasks will appear here.</p>'}
            </div>
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    console.error('Planner render error:', e);
    container.innerHTML = `<div class="stat-card danger"><h3>Error Loading Planner</h3></div>`;
  }
}

async function togglePlannerItem(id, completed) {
  try {
    const user = await SessionManager.getCurrentUser();
    const itemsRes = await SupabaseDB.getPlannerItems(user.email);
    const items = itemsRes.data || [];
    const item = items.find(i => i.id === id);
    if (item) {
        item.completed = completed;
        await SupabaseDB.savePlannerItem(item);
        renderPlanner();
    }
  } catch (e) {
      UI.showNotification('Failed to update task.');
  }
}
window.togglePlannerItem = togglePlannerItem;

async function addPlannerItem() {
  const user = await SessionManager.getCurrentUser();
  const title = document.getElementById('plannerTitle').value;
  const date = document.getElementById('plannerDate').value;
  const priority = document.getElementById('plannerPriority').value;
  if (!title || !date) return;
  await SupabaseDB.savePlannerItem({
      id: crypto.randomUUID(),
      user_email: user.email,
      title,
      due_date: date,
      priority: priority,
      completed: false,
      created_at: new Date().toISOString()
  });
  renderPlanner();
}

async function deletePlannerItem(id) {
  await SupabaseDB.deletePlannerItem(id);
  renderPlanner();
}

async function renderLiveClasses() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    // Reconcile any abandoned attempts on load
    try { await SupabaseDB.reconcileQuizAttempts(null, user.email); } catch(e) { console.warn('Reconciliation failed:', e); }

    const enrollRes = await SupabaseDB.getEnrollments(user.email);
    if (renderId !== window.currentRenderId) return;
    const enrollments = enrollRes.data || [];
    const enrolledCourseIds = enrollments.map(e => e.course_id);

    const liveRes = await SupabaseDB.getLiveClasses(null, null, enrolledCourseIds);
    if (renderId !== window.currentRenderId) return;
    const myClasses = liveRes.data || [];
    const now = TimerManager.getTime();

    content.innerHTML = `
      <div class="card">
        <h2 class="m-0">Upcoming Live Classes</h2>
      </div>
      <div class="grid mt-20">
        ${myClasses.map(liveClass => {
          const isLive = liveClass.status === 'live';
          const startAt = new Date(liveClass.start_at).getTime();
          const isUpcoming = startAt > now;

          const createdAtTs = liveClass.created_at ? new Date(liveClass.created_at).getTime() : now;
          const isFinished = !isLive && !isUpcoming;
          return `
            <div class="card">
              <div class="flex-between" style="align-items:start">
                <div>
                  <h3 class="m-0">${escapeHtml(liveClass.title)}</h3>
                  <p class="small mt-5"><strong>Time:</strong> ${new Date(liveClass.start_at).toLocaleString()}</p>
                </div>
                <span class="badge ${isLive ? 'badge-active' : ''}">${liveClass.status.toUpperCase()}</span>
              </div>
              <div class="mt-15">
                ${isLive ?
                  `<button class="button w-auto" onclick="handleJoinLiveClass('${liveClass.id}', '${liveClass.room_name}', '${escapeAttr(liveClass.meeting_url || '')}')">Join Now</button>` :
                  isUpcoming ? `
                    <div class="mb-10 p-10 border-radius-sm" style="background:var(--bg); border:1px solid var(--border)">
                        <div class="live-countdown" data-target="${startAt}" data-start="${createdAtTs}" data-status="${liveClass.status === 'cancelled' ? 'draft' : 'published'}"></div>
                    </div>
                    <button class="button secondary w-auto mt-10" disabled>Not Started</button>
                  ` : `
                    <div class="mb-10 p-10 border-radius-sm" style="background:var(--bg); border:1px solid var(--border)">
                        <div class="tiny text-muted">Session Finished</div>
                        ${liveClass.recording_url ? `<div class="mt-5"><a href="${escapeAttr(liveClass.recording_url)}" target="_blank" class="button secondary tiny w-auto">View Recording</a></div>` : ''}
                    </div>
                    <button class="button secondary w-auto" disabled>Finished</button>
                  `
                }
              </div>
            </div>
          `;
        }).join('') || '<div class="empty">No live classes scheduled for your courses.</div>'}
      </div>
      <div id="jitsi-container" class="hidden mt-20" style="height:600px; border:1px solid var(--border); border-radius:8px; overflow:hidden; position:relative"></div>
    `;

    Countdown.createAll('.live-countdown', {
        showProgress: true,
        label: 'Starts in:',
        onEnd: () => renderLiveClasses()
    }).forEach(c => StudentState.activeCountdowns.push(c));

  } catch (error) {
    console.error('Live Classes error:', error);
    content.innerHTML = `<div class="stat-card danger"><h3>Error Loading Live Classes</h3></div>`;
  }
}

let jitsiAPI = null;
let attendanceRecordId = null;
let attendanceStartTime = null;

async function handleJoinLiveClass(id, roomName, meetingUrl) {
    if (meetingUrl && meetingUrl.trim() !== '') {
        const choice = await UI.showMeetingChoice(meetingUrl);
        if (!choice) return;

        const user = await SessionManager.getCurrentUser();
        await SupabaseDB.saveAttendance({
            live_class_id: id,
            student_email: user.email,
            join_time: new Date().toISOString(),
            is_present: true
        });

        if (choice === 'tab') {
            window.open(meetingUrl, '_blank');
        } else {
            // Embed in app
            const container = document.getElementById('jitsi-container');
            if (container) {
                container.classList.remove('hidden');
                container.scrollIntoView({ behavior: 'smooth' });
                container.innerHTML = `<iframe src="${escapeAttr(meetingUrl)}" style="width:100%; height:600px; border:none" allow="camera; microphone; display-capture; autoplay; clipboard-write"></iframe>`;

                const closeBtnId = 'exit-meeting-btn';
                let closeBtn = document.getElementById(closeBtnId);
                if (!closeBtn) {
                    closeBtn = document.createElement('button');
                    closeBtn.id = closeBtnId;
                    closeBtn.className = 'button secondary w-auto mt-10';
                    closeBtn.textContent = 'Exit Meeting View';
                    container.after(closeBtn);
                } else {
                    closeBtn.classList.remove('hidden');
                    closeBtn.style.display = 'inline-flex';
                }

                closeBtn.onclick = () => {
                    container.classList.add('hidden');
                    container.innerHTML = '';
                    closeBtn.style.display = 'none';
                    stopAttendanceTracking(id);
                };
            } else {
                window.open(meetingUrl, '_blank');
            }
        }
    } else {
        joinLiveClass(id, roomName);
    }
}
window.handleJoinLiveClass = handleJoinLiveClass;

async function joinLiveClass(id, roomName) {
  const user = await SessionManager.getCurrentUser();
  const container = document.getElementById('jitsi-container');
  container.classList.remove('hidden');
  container.scrollIntoView({ behavior: 'smooth' });

  // Waiting State logic
  const waitingOverlay = document.createElement('div');
  waitingOverlay.id = 'waiting-overlay';
  waitingOverlay.className = 'absolute inset-0 flex-center flex-column';
  waitingOverlay.style.background = 'rgba(255,255,255,0.9)';
  waitingOverlay.style.zIndex = '5';
  waitingOverlay.innerHTML = `
    <div class="stat-card">
        <h3 class="m-0">Moderator has left</h3>
        <p class="small mt-10">Waiting for teacher to rejoin. Voice and chat are still active.</p>
        <div class="mt-15 flex-center"><div class="bar" style="width:50px; height:4px; background:var(--purple); animation: pulse 1.5s infinite"></div></div>
    </div>
  `;
  container.appendChild(waitingOverlay);
  waitingOverlay.classList.add('hidden');

  const domain = "meet.jit.si";
  const options = {
    roomName: roomName,
    height: 600,
    parentNode: container,
    userInfo: {
      displayName: user.full_name,
      email: user.email
    },
    configOverwrite: {
      startWithAudioMuted: true,
      startWithVideoMuted: true, // Low bandwidth: video off by default
      prejoinPageEnabled: false,
      remoteVideoMenu: { disable: true },
      disableRemoteMute: true
    },
    interfaceConfigOverwrite: {
        TOOLBAR_BUTTONS: ['microphone', 'camera', 'chat', 'raisehand', 'settings', 'hangup', 'tileview']
    }
  };

  if (jitsiAPI) jitsiAPI.dispose();
  jitsiAPI = new JitsiMeetExternalAPI(domain, options);

  // Moderator status tracking
  jitsiAPI.addEventListener('participantJoined', (p) => {
      if (p.role === 'moderator') {
          waitingOverlay.classList.add('hidden');
      }
  });

  jitsiAPI.addEventListener('participantLeft', (p) => {
      // If the last moderator left, show overlay
      // In this system, there's usually only one teacher/moderator
      if (p.role === 'moderator') {
          waitingOverlay.classList.remove('hidden');
      }
  });

  jitsiAPI.on('videoConferenceJoined', async () => {
    attendanceStartTime = new Date();
    const record = await SupabaseDB.saveAttendance({
        live_class_id: id,
        student_email: user.email,
        join_time: attendanceStartTime.toISOString(),
        is_present: false
    });
    attendanceRecordId = record?.id;
  });

  jitsiAPI.on('participantRoleChanged', (event) => {
      if (event.role === 'moderator') {
          waitingOverlay.classList.add('hidden');
          UI.showNotification('Moderator joined', 'info');
      } else {
          // If no moderators left in the room
          // (Simplified: if we get a role change and no one is moderator, we could show overlay)
      }
  });

  jitsiAPI.on('videoConferenceLeft', async () => {
    await stopAttendanceTracking(id);
    container.classList.add('hidden');
    waitingOverlay.remove();
  });

  jitsiAPI.addEventListener('readyToClose', () => {
    container.classList.add('hidden');
    waitingOverlay.remove();
    jitsiAPI.dispose();
    jitsiAPI = null;
  });
}

async function stopAttendanceTracking(classId) {
    if (!attendanceRecordId || !attendanceStartTime) return;

    const leaveTime = new Date();
    const duration = Math.floor((leaveTime - attendanceStartTime) / 1000);

    // Fetch the live class to get total duration
    const liveRes = await SupabaseDB.getLiveClasses(null, null, null);
    const classes = liveRes.data || [];
    const liveClass = classes.find(x => x.id === classId);
    let isPresent = false;
    if (liveClass) {
        const totalExpected = (new Date(liveClass.end_at) - new Date(liveClass.start_at)) / 1000;
        // Mark present if duration >= 80% of class time
        if (duration >= (totalExpected * 0.8)) {
            isPresent = true;
        }
    }

    const user = await SessionManager.getCurrentUser();
    const attRes = await SupabaseDB.getAttendance(classId, user.email);
    const records = attRes.data || [];
    const existing = records.find(r => r.id === attendanceRecordId);

    await SupabaseDB.saveAttendance({
        ...existing,
        id: attendanceRecordId,
        leave_time: leaveTime.toISOString(),
        duration: duration,
        is_present: isPresent
    });

    attendanceRecordId = null;
    attendanceStartTime = null;
}

window.joinLiveClass = joinLiveClass;
window.renderLiveClasses = renderLiveClasses;

async function renderHelp() {
  const renderId = ++window.currentRenderId;
  clearActiveCountdowns();
  if (renderId !== window.currentRenderId) return;
  UI.renderHelp('pageContent', 'student');
}

async function renderSettings() {
    const renderId = ++window.currentRenderId;
    clearActiveCountdowns();
    if (renderId !== window.currentRenderId) return;
    SettingsManager.render('Enable real-time desktop notifications for assignment updates, grades, and new course content.');
}

async function viewStudentAssessmentReport(assessmentId, title) {
  const renderId = window.currentRenderId;
  const area = document.getElementById('violationDetailArea');
  if (!area) return;
  area.innerHTML = `<div class="loading-spinner"></div>`;
  area.scrollIntoView({ behavior: 'smooth' });

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const { data: violations } = await SupabaseDB.getViolations(assessmentId, user.email);
    if (renderId !== window.currentRenderId) return;

    area.innerHTML = `
      <div class="card">
        <div class="flex-between mb-20">
          <h3 class="m-0">Detailed Report: ${escapeHtml(title)}</h3>
          <button class="button secondary tiny w-auto" onclick="document.getElementById('violationDetailArea').innerHTML=''">Close Report</button>
        </div>
        <div id="integrityReportContent"></div>
      </div>
    `;

    UI.renderIntegrityReport('integrityReportContent', violations, user.email);

  } catch (e) {
    area.innerHTML = `<div class="card danger-border">Error loading report: ${e.message}</div>`;
  }
}
window.viewStudentAssessmentReport = viewStudentAssessmentReport;

async function renderAntiCheat() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const { data: summary } = await SupabaseDB.getStudentViolationSummary(user.email);
    if (renderId !== window.currentRenderId) return;

    UI.renderAntiCheatSummary('pageContent', summary, {
        title: 'Security & Integrity Dashboard',
        isStudent: true,
        onViewDetails: (id, title) => viewStudentAssessmentReport(id, title),
        onRefresh: () => renderAntiCheat()
    });
  } catch (error) {
    console.error('AntiCheat error:', error);
    content.innerHTML = `<div class="card danger-border"><h3>Error Loading Record</h3></div>`;
  }
}
window.renderAntiCheat = renderAntiCheat;

async function renderQuizzes(openId = null) {
  const renderId = ++window.currentRenderId;
  clearActiveCountdowns();
  const container = document.getElementById('pageContent');
  if (!container) return;

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    // Reconcile any abandoned attempts on load
    try { await SupabaseDB.reconcileQuizAttempts(null, user.email); } catch(e) { console.warn('Reconciliation failed:', e); }

    const enrollRes = await SupabaseDB.getEnrollments(user.email);
    if (renderId !== window.currentRenderId) return;
    const enrollments = enrollRes.data || [];
    const enrolledCourseIds = (enrollments || []).map(e => e.course_id);

    const [{ data: allQuizzes, total }, { data: allSubs }, { data: courses }] = await Promise.all([
      SupabaseDB.getQuizzes(null, null, enrolledCourseIds),
      SupabaseDB.getQuizSubmissions(null, user.email, null),
      SupabaseDB.getEnrolledCourses(user.email)
    ]);
    if (renderId !== window.currentRenderId) return;

    // Only show submissions for quizzes that belong to enrolled courses
    const subs = (allSubs || []).filter(s => enrolledCourseIds.includes(s.quizzes?.course_id));

    const activeQuizzes = (allQuizzes || []).filter(q => q.status === 'published');
    const now = TimerManager.getTime();
    container.innerHTML = `
      <div class="flex-between mb-20">
        <h2 class="m-0">My Quizzes</h2>
        <div class="small text-muted">${activeQuizzes.length} Total</div>
      </div>
      <div class="grid">
        ${activeQuizzes.map(q => {
          const mySubs = subs.filter(s => s.quiz_id === q.id && s.status === 'submitted').sort((a,b) => new Date(b.submitted_at) - new Date(a.submitted_at));
          const inProgress = subs.find(s => s.quiz_id === q.id && s.status === 'in-progress');
          const bestScore = mySubs.length ? Math.max(...mySubs.map(s => s.score || 0)) : '-';
          const attemptsUsed = mySubs.length;

          const startAt = q.start_at ? new Date(q.start_at).getTime() : 0;
          const endAt = q.end_at ? new Date(q.end_at).getTime() : Infinity;
          const isUpcoming = startAt > now;
          const isExpired = endAt < now;
          const isAvailable = now >= startAt && now <= endAt;

          const canAttempt = (attemptsUsed < q.attempts_allowed || !!inProgress) && isAvailable;

          const course = courses.find(c => c.id === q.course_id);
          return `
            <div class="card">
              <h3 class="m-0">${escapeHtml(q.title)}</h3>
              <p class="small"><strong>Course:</strong> ${escapeHtml(course?.title || 'Unknown')}</p>
              <div class="small mt-5">${UI.renderRichText(q.description || '')}</div>
              <div class="flex-between mt-15 p-10" style="background:var(--bg); border-radius:6px">
                  <div class="text-center">
                      <div class="bold" id="attempts-count-${q.id}">${attemptsUsed} / ${q.attempts_allowed}</div>
                      <div class="small">Attempts</div>
                  </div>
                  <div class="text-center">
                      <div class="bold" style="color:var(--purple)">${bestScore !== '-' ? bestScore + '%' : '-'}</div>
                      <div class="small">Best Score</div>
                  </div>
              </div>

              ${attemptsUsed > 0 ? `
                  <div class="mt-15">
                      <div class="bold small mb-5">Previous Attempts:</div>
                      <div class="flex-column gap-5 no-scrollbar" style="max-height: 150px; overflow-y: auto; padding-right: 2px;">
                          ${mySubs.map((s, i) => `
                              <div class="flex-between p-5 small border-radius-sm" style="background:#fff; border:1px solid var(--border); margin-bottom: 4px;">
                                  <span>#${s.attempt_number || attemptsUsed - i}: ${s.score}% (${Math.floor(s.time_spent / 60)}m)</span>
                                  <button class="button secondary tiny w-auto" onclick="viewQuizResults('${q.id}', '${s.id}')">View Details</button>
                              </div>
                          `).join('')}
                      </div>
                  </div>
              ` : ''}

              <div class="mt-20" id="quiz-actions-${q.id}">
                  ${isUpcoming ? `
                      <div class="p-10 border-radius-sm" style="background:var(--bg); border:1px solid var(--border)">
                          <div class="quiz-countdown" data-target="${startAt}" data-start="${q.created_at ? new Date(q.created_at).getTime() : now}" data-label="Available In:" data-status="${q.status || 'published'}"></div>
                      </div>
                  ` : isExpired ? `
                      <div class="badge badge-inactive w-100 text-center">Quiz Ended on ${new Date(endAt).toLocaleString()}</div>
                  ` : canAttempt ? `
                      ${endAt !== Infinity ? `
                          <div class="mb-10 p-10 border-radius-sm" style="background:#fffcf0; border:1px solid #ffeeba">
                              <div class="quiz-countdown" data-target="${endAt}" data-start="${startAt}" data-label="Ends In:" data-status="${q.status || 'published'}"></div>
                          </div>
                      ` : ''}
                      <button class="button w-auto small px-20" id="quiz-btn-${q.id}" onclick="startQuiz('${q.id}')">${inProgress ? 'Resume Attempt' : 'Start New Attempt'}</button>
                  ` : '<div class="badge badge-inactive w-100 text-center">No Access / Attempts Used</div>'
                  }
              </div>
            </div>
          `;
        }).join('') || '<div class="empty">No quizzes available for your courses.</div>'}
      </div>
      <div id="quizArea" class="hidden mt-20"></div>
    `;

    // Initialize countdowns
    Countdown.createAll('.quiz-countdown', {
        showProgress: true,
        onEnd: () => {
            if (!document.getElementById('quizForm')) {
                renderQuizzes();
            }
        }
    }).forEach(c => StudentState.activeCountdowns.push(c));

    if (openId) {
        startQuiz(openId);
    }
  } catch (error) {
    console.error('Quizzes error:', error);
    container.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Quizzes</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderQuizzes()">Retry</button>
    </div>`;
  }
}


async function startQuiz(quizId) {
  const renderId = ++window.currentRenderId;
  if (StudentState.isStartingQuiz) return;
  StudentState.isStartingQuiz = true;

  const listBtn = document.getElementById(`quiz-btn-${quizId}`);
  if (listBtn) {
      listBtn.disabled = true;
      listBtn.textContent = 'Starting...';
  }

  const quizArea = document.getElementById('quizArea');
  if (quizArea) {
      quizArea.classList.remove('hidden');
      quizArea.style.display = 'block';
      quizArea.scrollIntoView({ behavior: 'smooth' });
  }

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const quiz = await SupabaseDB.getQuiz(quizId);
    if (renderId !== window.currentRenderId) return;

    const now = TimerManager.getTime();
    const startAt = quiz.start_at ? new Date(quiz.start_at).getTime() : 0;
    const endAt = quiz.end_at ? new Date(quiz.end_at).getTime() : Infinity;

    if (now < startAt) {
        UI.showNotification('This quiz is not available yet.');
        if (listBtn) { listBtn.disabled = false; listBtn.textContent = 'Start New Attempt'; }
        if (quizArea) quizArea.style.display = 'none';
        return;
    }
    if (now > endAt) {
        UI.showNotification('This quiz has ended.');
        if (listBtn) { listBtn.disabled = true; listBtn.textContent = 'Quiz Ended'; }
        if (quizArea) quizArea.style.display = 'none';
        return;
    }

    StudentState.currentQuiz = quiz;
    StudentState.currentQuestionIndex = 0;
    StudentState.currentQuizQuestions = quiz.questions.map((q, idx) => ({ ...q, originalIdx: idx }));

    if (quiz.shuffle_questions) {
        for (let i = StudentState.currentQuizQuestions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [StudentState.currentQuizQuestions[i], StudentState.currentQuizQuestions[j]] = [StudentState.currentQuizQuestions[j], StudentState.currentQuizQuestions[i]];
        }
    }

    const content = document.getElementById('pageContent');
    if (!content || !quizArea) return;

    // Show Shell Immediately for better UX
    renderQuizShell();
    UI.showLoading('questionContainer', 'Initializing your attempt...');

    Array.from(content.children).forEach(c => {
        if (c.id !== 'quizArea') c.style.display = 'none';
    });

    // Handle Anti-Cheat initialization with gesture requirement
    const needsGesture = quiz.anti_cheat_config?.FULLSCREEN_REQUIRED;

    if (needsGesture) {
        const qContainer = document.getElementById('questionContainer');
        qContainer.innerHTML = `
            <div class="flex-center flex-column p-40 text-center">
                <div style="font-size: 3rem; margin-bottom: 20px;">🛡️</div>
                <h3>Security Check Required</h3>
                <p class="mb-30">This quiz requires <strong>Fullscreen Mode</strong> and other security features. <br> Please click the button below to secure your browser and start the quiz.</p>
                <button class="button px-40" id="confirmQuizStartBtn">Secure & Start Quiz</button>
            </div>
        `;

        await new Promise((resolve) => {
            document.getElementById('confirmQuizStartBtn').onclick = async () => {
                // Initialize Anti-Cheat within the user gesture
                await AntiCheat.init(quiz.id, 'quiz', user.email, {
                    ...quiz.anti_cheat_config,
                    callbacks: {
                        onViolation: (v) => {
                            UI.showNotification(`Security Violation: ${v.type.replace(/_/g, ' ')} detected and logged.`, 'danger');
                        }
                    }
                });
                resolve();
            };
        });

        UI.showLoading('questionContainer', 'Starting attempt...');
    } else if (quiz.anti_cheat_config && Object.values(quiz.anti_cheat_config).some(v => v === true)) {
      // Initialize other anti-cheat features that don't strictly require a fresh gesture
      AntiCheat.init(quiz.id, 'quiz', user.email, {
          ...quiz.anti_cheat_config,
          callbacks: {
              onViolation: (v) => {
                  UI.showNotification(`Security Violation: ${v.type.replace(/_/g, ' ')} detected and logged.`, 'danger');
              }
          }
      });
    }

    // Authoritative start via RPC
    StudentState.currentSubmission = await SupabaseDB.startQuizAttempt(quizId);
    if (renderId !== window.currentRenderId) return;

    // Calculate deadline once to avoid redundancy
    let actualDeadline = Infinity;
    const startTs = new Date(StudentState.currentSubmission.started_at).getTime();

    if (quiz.time_limit > 0 || endAt !== Infinity) {
        const limitEnd = quiz.time_limit > 0 ? startTs + (quiz.time_limit * 60 * 1000) : Infinity;
        actualDeadline = Math.min(limitEnd, endAt);

        // Immediate check for expired resume
        if (TimerManager.getTime() >= actualDeadline) {
            UI.showNotification('This attempt has already reached its time limit. Submitting...', 'warn');
            await submitQuiz(true);
            return;
        }
    }

    renderQuizQuestion(0);

    if (actualDeadline !== Infinity) {
      StudentState.quizTimer = Countdown.create('#quizTimerDisplay', {
          targetDate: actualDeadline,
          referenceDate: startTs,
          showProgress: true,
          compact: true,
          label: 'Time:',
          onEnd: () => {
              UI.showNotification('Time is up! Submitting your quiz automatically.');
              submitQuiz(true);
          }
      });
    } else {
      const timerDisplay = document.getElementById('quizTimerDisplay');
      if (timerDisplay) timerDisplay.textContent = 'No Time Limit';
    }

    quizArea.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
      console.error('Failed to start quiz:', err);
      UI.showNotification('Error starting quiz: ' + err.message);
      if (listBtn) {
          listBtn.disabled = false;
          listBtn.textContent = 'Start New Attempt';
      }
  } finally {
      StudentState.isStartingQuiz = false;
  }
}

function renderQuizShell() {
    const quizArea = document.getElementById('quizArea');
    quizArea.innerHTML = `
        <div class="card quiz-taking-container" style="max-width: 800px; margin: 0 auto; position: relative;">
            <div class="quiz-header flex-between mb-20 p-10" style="position: sticky; top:0; background:#fff; z-index:10; border-bottom:1px solid var(--border)">
                <div>
                    <h3 class="m-0">${escapeHtml(StudentState.currentQuiz.title)}</h3>
                    <div id="quizSaveStatus" class="tiny text-muted" style="height:15px"></div>
                </div>
                <div id="quizTimerDisplay" class="bold danger-text" style="font-size:1.1rem"></div>
            </div>

            <div class="quiz-progress-wrapper mb-20">
                <div class="flex-between mb-5">
                    <span class="small text-muted" id="qCounter">Question 1 of ${StudentState.currentQuizQuestions.length}</span>
                    <span class="small text-muted" id="pPercentage">0%</span>
                </div>
                <div class="progress-container" style="height: 6px; background: #edf2f7; border-radius: 3px; overflow: hidden;">
                    <div id="quizProgressBar" class="progress-bar" style="width: 0%; height: 100%; background: var(--purple); transition: width 0.3s ease;"></div>
                </div>
            </div>

            <div id="questionContainer" class="mt-30" style="min-height: 300px;"></div>

            <div class="quiz-footer flex-between mt-40 pt-20" style="border-top: 1px solid var(--border)">
                <button class="button secondary w-auto px-30" id="prevBtn" onclick="navigateQuestion(-1)">Previous</button>
                <div class="flex gap-10">
                    <button class="button secondary w-auto px-30" id="nextBtn" onclick="navigateQuestion(1)">Next</button>
                    <button class="button w-auto px-40 hidden" id="finalSubmitBtn" onclick="submitQuiz()">Submit Quiz</button>
                </div>
            </div>
        </div>
    `;
}

function renderQuizQuestion(index) {
    StudentState.currentQuestionIndex = index;
    const q = StudentState.currentQuizQuestions[index];
    const qIdx = q.originalIdx;
    const container = document.getElementById('questionContainer');
    if (!container) return;

    const progress = Math.round(((index + 1) / StudentState.currentQuizQuestions.length) * 100);
    document.getElementById('qCounter').textContent = `Question ${index + 1} of ${StudentState.currentQuizQuestions.length}`;
    document.getElementById('pPercentage').textContent = `${progress}%`;
    document.getElementById('quizProgressBar').style.width = `${progress}%`;

    document.getElementById('prevBtn').disabled = (index === 0);
    const nextBtn = document.getElementById('nextBtn');
    const submitBtn = document.getElementById('finalSubmitBtn');

    if (index === StudentState.currentQuizQuestions.length - 1) {
        nextBtn.classList.add('hidden');
        submitBtn.classList.remove('hidden');
    } else {
        nextBtn.classList.remove('hidden');
        submitBtn.classList.add('hidden');
    }

    const savedAnswer = StudentState.currentSubmission.answers[qIdx];
    let inputHtml = '';

    if (q.type === 'mcq') {
        inputHtml = q.options.map((opt, i) => {
            const isChecked = savedAnswer !== undefined && savedAnswer.toString() === i.toString();
            return `
                <div class="quiz-option-card ${isChecked ? 'selected' : ''}" onclick="selectQuizOption(this, ${qIdx}, '${i}')"
                     style="padding:15px; border:1px solid var(--border); border-radius:8px; cursor:pointer; display:flex; align-items:center; gap:15px; background:${isChecked ? '#f0f4ff' : '#fff'}; transition: all 0.2s">
                    <div class="option-marker" style="width:30px; height:30px; border-radius:50%; background:${isChecked ? 'var(--purple)' : '#edf2f7'}; color:${isChecked ? '#fff' : 'var(--text)'}; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:0.9rem">${String.fromCharCode(65 + i)}</div>
                    <div class="option-text" style="flex:1; font-size:1rem">${UI.renderRichText(opt)}</div>
                </div>
            `;
        }).join('');
    } else if (q.type === 'tf') {
        const isTrue = savedAnswer === 'True';
        const isFalse = savedAnswer === 'False';
        inputHtml = `
            <div class="grid-2 gap-15">
                <div class="quiz-option-card ${isTrue ? 'selected' : ''}" onclick="selectQuizOption(this, ${qIdx}, 'True')"
                     style="padding:20px; border:1px solid var(--border); border-radius:8px; cursor:pointer; text-align:center; background:${isTrue ? '#f0f4ff' : '#fff'}; transition: all 0.2s">
                    <div class="option-text bold" style="font-size:1.1rem">True</div>
                </div>
                <div class="quiz-option-card ${isFalse ? 'selected' : ''}" onclick="selectQuizOption(this, ${qIdx}, 'False')"
                     style="padding:20px; border:1px solid var(--border); border-radius:8px; cursor:pointer; text-align:center; background:${isFalse ? '#f0f4ff' : '#fff'}; transition: all 0.2s">
                    <div class="option-text bold" style="font-size:1.1rem">False</div>
                </div>
            </div>
        `;
    } else if (q.type === 'short') {
        inputHtml = `
            <div class="mt-10">
                <input type="text" class="input stylish-input" placeholder="Type your answer here..."
                    value="${savedAnswer || ''}"
                    oninput="handleShortAnswer(this, ${qIdx})"
                    style="font-size: 1.1rem; padding: 15px; border: 2px solid #edf2f7; border-radius: 8px; width: 100%;">
            </div>
        `;
    }

    container.innerHTML = `
        <div class="animate-fade-in">
            <div class="flex-between mb-15">
                <div class="badge badge-purple small">Points: ${q.points}</div>
                ${q.hint ? `<button class="button tiny w-auto animate-pulse" style="background: var(--ok)" onclick="UI.showNotification('💡 Hint: ' + this.dataset.hint, 'info')" data-hint="${escapeAttr(q.hint)}">View Hint</button>` : ''}
            </div>
            <h2 class="quiz-question-text mb-30" style="font-size: 1.4rem; line-height: 1.4; color: var(--text)">${UI.renderRichText(q.text)}</h2>
            <div class="quiz-options-container flex-column gap-15">
                ${inputHtml}
            </div>
        </div>
    `;
}

function selectQuizOption(el, qIdx, value) {
    const indexAtClick = StudentState.currentQuestionIndex;
    const cards = el.parentElement.querySelectorAll('.quiz-option-card');
    cards.forEach(c => {
        c.classList.remove('selected');
        c.style.background = '#fff';
        const marker = c.querySelector('.option-marker');
        if (marker) { marker.style.background = '#edf2f7'; marker.style.color = 'var(--text)'; }
    });

    el.classList.add('selected');
    el.style.background = '#f0f4ff';
    const marker = el.querySelector('.option-marker');
    if (marker) { marker.style.background = 'var(--purple)'; marker.style.color = '#fff'; }

    StudentState.currentSubmission.answers[qIdx] = value;
    autoSubmitQuiz();

    if (StudentState.currentQuestionIndex < StudentState.currentQuizQuestions.length - 1) {
        setTimeout(() => {
            if (StudentState.currentQuestionIndex === indexAtClick) {
                 navigateQuestion(1);
            }
        }, 800);
    }
}

function handleShortAnswer(input, qIdx) {
    StudentState.currentSubmission.answers[qIdx] = input.value;
    autoSubmitQuiz();
}

function navigateQuestion(dir) {
    const newIndex = StudentState.currentQuestionIndex + dir;
    if (newIndex >= 0 && newIndex < StudentState.currentQuizQuestions.length) {
        renderQuizQuestion(newIndex);
    }
}

window.navigateQuestion = navigateQuestion;

async function autoSubmitQuiz() {
  if (StudentState.isSubmittingQuiz || !StudentState.currentSubmission || StudentState.currentSubmission.status !== 'in-progress') return;

  const statusEl = document.getElementById('quizSaveStatus');
  if (statusEl) statusEl.textContent = 'Unsaved changes...';

  if (StudentState.quizDebounceTimer) clearTimeout(StudentState.quizDebounceTimer);
  StudentState.quizDebounceTimer = setTimeout(async () => {
      try {
        if (statusEl) statusEl.textContent = 'Saving...';
        const res = await SupabaseDB.saveQuizSubmission(StudentState.currentSubmission);
        if (res) StudentState.currentSubmission = res;
        if (statusEl) {
            statusEl.textContent = 'All changes saved.';
            setTimeout(() => { if(statusEl && statusEl.textContent === 'All changes saved.') statusEl.textContent = ''; }, 3000);
        }
      } catch (e) {
          console.warn('Auto-save failed:', e);
          if (statusEl) statusEl.textContent = 'Save failed (offline?)';
      }
  }, 5000);
}

async function submitQuiz(isAuto = false) {
  const renderId = window.currentRenderId;
  if (StudentState.isSubmittingQuiz) return;
  StudentState.isSubmittingQuiz = true;

  // Immediately update status in-memory to prevent autosave races even if StudentState.isSubmittingQuiz flag is bypassed
  const previousStatus = StudentState.currentSubmission?.status;
  if (StudentState.currentSubmission) StudentState.currentSubmission.status = 'submitted';

  if (!isAuto && !confirm('Are you sure you want to submit your quiz?')) {
      if (StudentState.currentSubmission) StudentState.currentSubmission.status = previousStatus || 'in-progress';
      StudentState.isSubmittingQuiz = false;
      return;
  }

  const btn = document.getElementById('finalSubmitBtn');
  if (btn) {
      btn.disabled = true;
      btn.textContent = 'Submitting...';
  }

  const quizId = StudentState.currentQuiz?.id;
  const listBtn = quizId ? document.getElementById(`quiz-btn-${quizId}`) : null;
  if (listBtn) {
      listBtn.disabled = true;
      listBtn.textContent = 'Processing...';
  }

  UI.showLoading('quizArea', 'Saving your answers and calculating score...');
  AntiCheat.destroy();

  if (StudentState.quizTimer instanceof Countdown) {
    StudentState.quizTimer.destroy();
    StudentState.quizTimer = null;
  }
  if (StudentState.quizDebounceTimer) {
    clearTimeout(StudentState.quizDebounceTimer);
    StudentState.quizDebounceTimer = null;
  }

  let user;
  try {
    user = await SessionManager.getCurrentUser();
    const answers = StudentState.currentSubmission?.answers || {};
    const now = new Date();
    const timeSpent = StudentState.currentSubmission ? Math.round((now - new Date(StudentState.currentSubmission.started_at)) / 1000) : 0;

    // Authoritative submission via RPC
    const result = await SupabaseDB.submitQuizAttempt(StudentState.currentSubmission.id, answers, timeSpent);
    if (renderId !== window.currentRenderId) return;
    StudentState.currentSubmission = result;

  } catch (err) {
      console.error('Quiz submission failed:', err);
      // Revert status to allow retry and continued autosave
      if (StudentState.currentSubmission) StudentState.currentSubmission.status = 'in-progress';
      UI.showNotification('Quiz Submission Failed: ' + (err.message || 'Unknown error'), 'error');
      // If auto-submit failed, we might want to re-initiate anti-cheat or timer?
      // For now, just ensuring UI is unlocked.
  } finally {
      StudentState.isSubmittingQuiz = false;
      if (!StudentState.currentSubmission || StudentState.currentSubmission.status !== 'submitted') {
          if (btn) {
              btn.disabled = false;
              btn.textContent = 'Submit Quiz';
          }
          if (listBtn) {
              listBtn.disabled = false;
              listBtn.textContent = 'Retry Submission';
          }
          UI.hideLoading('quizArea');
      }
  }

  // If submission failed, stop execution here
  if (!StudentState.currentSubmission || StudentState.currentSubmission.status !== 'submitted') return;

  if (StudentState.currentQuiz) await SupabaseDB.updateCourseProgress(StudentState.currentQuiz.course_id, user.email);

  const quizArea = document.getElementById('quizArea');
  if (quizArea) {
      const percentage = StudentState.currentSubmission.score || 0;
      const isPassed = percentage >= (StudentState.currentQuiz.passing_score || 0);
      const timeSpentFinal = StudentState.currentSubmission.time_spent || 0;
      const durationMin = Math.floor(timeSpentFinal / 60);
      const durationSec = timeSpentFinal % 60;
      const avgTimePerQ = (timeSpentFinal / (StudentState.currentQuiz.questions?.length || 1)).toFixed(1);

      quizArea.innerHTML = `
        <div class="card text-center p-40">
            <div style="font-size: 4rem; margin-bottom: 20px;">${isPassed ? '🎉' : '⏱️'}</div>
            <h2 class="m-0">Quiz Submitted!</h2>
            <p class="text-muted mb-30">Your attempt has been recorded successfully.</p>

            <div class="grid-3 mb-30 p-20 border-radius-sm" style="background:var(--bg)">
                <div>
                    <div class="small text-muted">Final Score</div>
                    <div class="bold" style="font-size:2rem; color:var(--purple)">${percentage}%</div>
                </div>
                <div>
                    <div class="small text-muted">Status</div>
                    <div class="bold ${isPassed ? 'success-text' : 'danger-text'}" style="font-size:2rem">${isPassed ? 'PASSED' : 'FAILED'}</div>
                </div>
                <div>
                    <div class="small text-muted">Required</div>
                    <div class="bold" style="font-size:2rem">${StudentState.currentQuiz.passing_score || 0}%</div>
                </div>
            </div>

            <div class="grid-2 mb-30 p-15 border-radius-sm" style="background:#f8fafc; border:1px solid var(--border)">
                <div class="small"><strong>Total Time:</strong> ${durationMin}m ${durationSec}s</div>
                <div class="small"><strong>Avg Time/Question:</strong> ${avgTimePerQ}s</div>
            </div>

            <div class="flex-center gap-10">
                <button class="button w-auto px-40" onclick="renderQuizzes()">Back to Quizzes</button>
                <button class="button secondary w-auto px-40" onclick="viewQuizResults('${quizId}', '${StudentState.currentSubmission.id}')">View Detailed Results</button>
            </div>
        </div>
      `;
      quizArea.scrollIntoView({ behavior: 'smooth' });
  }

  StudentState.currentQuiz = null;
  StudentState.currentSubmission = null;
}

async function viewQuizResults(quizId, submissionId = null) {
  const renderId = ++window.currentRenderId;
  const user = await SessionManager.getCurrentUser();
  const quiz = await SupabaseDB.getQuiz(quizId);
  const { data: subs } = await SupabaseDB.getQuizSubmissions(quizId, user.email);
  if (renderId !== window.currentRenderId) return;

  let targetSub;
  if (submissionId) {
      targetSub = subs.find(s => s.id === submissionId);
  } else {
      targetSub = subs.filter(s => s.status === 'submitted').sort((a,b) => (b.score || 0) - (a.score || 0))[0];
  }

  if (!targetSub) return renderQuizzes();

  const container = document.getElementById('pageContent');
  if (!container) return;
  const isPassed = targetSub.score >= (quiz.passing_score || 0);
  const durationMin = Math.floor(targetSub.time_spent / 60);
  const durationSec = targetSub.time_spent % 60;
  const avgTimePerQ = (targetSub.time_spent / (quiz.questions?.length || 1)).toFixed(1);

  container.innerHTML = `
    <button class="button secondary w-auto mb-10" onclick="renderQuizzes()">← Back</button>
    <div class="card">
      <div class="flex-between">
          <h2 class="m-0">Results: ${escapeHtml(quiz.title)}</h2>
          <span class="badge ${isPassed ? 'badge-active' : 'badge-inactive'}" style="font-size: 1.1rem; padding: 8px 16px;">
            ${isPassed ? 'PASSED' : 'FAILED'}
          </span>
      </div>

      <div class="grid-3 mt-20 p-15 border-radius-sm" style="background:var(--bg)">
        <div class="text-center">
            <div class="small text-muted">Raw Score</div>
            <div class="bold" style="font-size:1.2rem">${Math.round((targetSub.score / 100) * (targetSub.total_points || 0))} / ${targetSub.total_points || 0}</div>
        </div>
        <div class="text-center">
            <div class="small text-muted">Final Percentage</div>
            <div class="bold" style="font-size:1.5rem; color:var(--purple)">${targetSub.score}%</div>
        </div>
        <div class="text-center">
            <div class="small text-muted">Passing Required</div>
            <div class="bold" style="font-size:1.2rem">${quiz.passing_score || 0}%</div>
        </div>
      </div>

      <div class="grid-2 mt-10 p-10 border-radius-sm" style="background:#f8fafc; border:1px solid var(--border)">
          <div class="small"><strong>Total Time Spent:</strong> ${durationMin}m ${durationSec}s</div>
          <div class="small"><strong>Avg Time per Question:</strong> ${avgTimePerQ}s</div>
      </div>

      <div class="mt-20">
        ${quiz.questions.map((q, idx) => {
          const studentAnswer = targetSub.answers[idx];
          let studentDisplay = studentAnswer || 'No Answer';
          let correctDisplay = q.correct;

          if (q.type === 'mcq') {
              studentDisplay = q.options[studentAnswer] !== undefined ? q.options[studentAnswer] : studentAnswer;
              correctDisplay = q.options[q.correct] !== undefined ? q.options[q.correct] : q.correct;
          } else if (q.type === 'tf') {
              studentDisplay = studentAnswer;
              correctDisplay = q.correct;
          }

          const isCorrect = studentAnswer?.toString().trim().toLowerCase() === q.correct.toString().trim().toLowerCase();
          const statusColor = isCorrect ? 'var(--ok)' : 'var(--danger)';

          return `
            <div class="question" style="border-left: 5px solid ${statusColor}">
              <div class="flex-between">
                <div class="bold">Q${idx + 1}: ${UI.renderRichText(q.text)}</div>
                <div class="badge ${isCorrect ? 'badge-active' : 'badge-warn'}">${isCorrect ? q.points : 0} / ${q.points} pts</div>
              </div>
              <div class="small mt-10">Your Answer: <span class="bold">${UI.renderRichText(studentDisplay)}</span></div>
              ${!isCorrect ? `<div class="small success-text bold mt-5">Correct Answer: ${UI.renderRichText(correctDisplay)}</div>` : ''}
              ${q.explanation ? `<div class="small mt-10 p-10" style="background:var(--light); border-radius:4px; font-style:italic">📖 Explanation: ${UI.renderRichText(q.explanation)}</div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

async function requestRegrade(assignmentId) {
    const renderId = window.currentRenderId;
    const reason = document.getElementById('regradeReason').value;
    if (!reason) return UI.showNotification('Please provide a reason.');

    try {
        const user = await SessionManager.getCurrentUser();
        if (renderId !== window.currentRenderId) return;
        const submission = await SupabaseDB.getSubmission(assignmentId, user.email);
        if (renderId !== window.currentRenderId) return;

        submission.regrade_request = reason;
        await SupabaseDB.saveSubmission(submission);
        if (renderId !== window.currentRenderId) return;

        UI.showNotification('Regrade request submitted!');
        viewFeedback(assignmentId);
    } catch (e) {
        UI.showNotification('Failed to submit regrade request.');
    }
}
window.requestRegrade = requestRegrade;

async function deleteSubmissionById(assignmentId, studentEmail) {
  const renderId = window.currentRenderId;
  if (confirm('Are you sure you want to delete your submission? This action cannot be undone.')) {
    try {
      const a = await SupabaseDB.getAssignment(assignmentId);
      if (renderId !== window.currentRenderId) return;
      await SupabaseDB.deleteSubmission(assignmentId, studentEmail);
      if (renderId !== window.currentRenderId) return;
      if (a) await SupabaseDB.updateCourseProgress(a.course_id, studentEmail);
      if (renderId !== window.currentRenderId) return;
      renderAssignments();
      UI.showNotification('Submission deleted successfully.');
    } catch (e) {
      console.error('Delete failed:', e);
      UI.showNotification('Error deleting submission: ' + (e.message || 'Unknown error'));
    }
  }
}
async function submitAssignment(assignmentId, studentEmail, isDraft = false) {
  const renderId = window.currentRenderId;
  if (StudentState.isSubmittingAssignment) return;
  StudentState.isSubmittingAssignment = true;

  const btn = isDraft ? document.getElementById('saveDraftBtn') : document.getElementById('submitAssignBtn');
  const otherBtn = isDraft ? document.getElementById('submitAssignBtn') : document.getElementById('saveDraftBtn');
  const questions = document.querySelectorAll(`#qwrap-${assignmentId} .question`);

  // Capture values before UI.showLoading overwrites the DOM
  const capturedAnswers = [];
  for (let idx = 0; idx < questions.length; idx++) {
      const qDiv = questions[idx];
      const activeType = qDiv.getAttribute('data-active-type');
      const essay = qDiv.querySelector('.q-essay');
      const link = qDiv.querySelector('.q-link');
      const fileInput = qDiv.querySelector('.q-file');

      capturedAnswers.push({
          activeType,
          essay: essay ? essay.value.trim() : null,
          link: link ? link.value.trim() : null,
          file: fileInput ? fileInput.files[0] : null
      });
  }

  if (btn) { btn.disabled = true; btn.textContent = isDraft ? 'Saving Draft...' : 'Uploading...'; }
  if (otherBtn) { otherBtn.disabled = true; }
  UI.showLoading('assignmentForm', isDraft ? 'Saving draft...' : 'Uploading submission...');

  try {
    const existing = await SupabaseDB.getSubmission(assignmentId, studentEmail);
    if (renderId !== window.currentRenderId) return;
    const answers = (existing && existing.answers) ? { ...existing.answers } : {};

    for (let idx = 0; idx < capturedAnswers.length; idx++) {
      const captured = capturedAnswers[idx];
      const activeType = captured.activeType;

      let value = null;
      if (activeType === 'essay') {
          value = captured.essay;
      } else if (activeType === 'link') {
          if (!isDraft && captured.link && !isValidUrl(captured.link)) {
              throw new Error(`Invalid URL for Question ${idx + 1}. Please start with http:// or https://`);
          }
          value = captured.link;
      } else if (activeType === 'file') {
          if (captured.file) {
              const file = captured.file;
              const path = `submissions/${assignmentId}/${studentEmail}/${idx}_${Date.now()}_${file.name}`;
              await SupabaseDB.uploadFile('assignments', path, file);
              if (renderId !== window.currentRenderId) return;
              value = await SupabaseDB.getPublicUrl('assignments', path);
              if (renderId !== window.currentRenderId) return;
          } else {
              // Fallback to existing value if it was already a file URL for this type
              const current = answers[idx];
              if (current && typeof current === 'object' && current.type === 'file') {
                  value = current.value;
              } else if (typeof current === 'string' && isValidUrl(current)) {
                  value = current; // Legacy support
              }
          }
      }

      if (!isDraft && (!value || value === '')) {
          throw new Error(`Question ${idx + 1} is empty. Please provide an answer.`);
      }

      answers[idx] = { type: activeType, value: value };
    }

    // "No empty submission" is already enforced above by throwing error for any empty question.

    const submission = {
      ...existing,
      assignment_id: assignmentId,
      student_email: studentEmail,
      submitted_at: isDraft ? (existing?.submitted_at || null) : new Date().toISOString(),
      updated_at: new Date().toISOString(),
      answers: answers,
      attachments: existing?.attachments || [],
      status: isDraft ? 'draft' : 'submitted',
      // Reset grading fields on re-submission to ensure teacher re-grades fresh content
      grade: isDraft ? (existing?.grade ?? null) : null,
      final_grade: isDraft ? (existing?.final_grade ?? null) : null,
      question_scores: isDraft ? (existing?.question_scores ?? {}) : {},
      question_feedback: isDraft ? (existing?.question_feedback ?? {}) : {},
      graded_at: isDraft ? (existing?.graded_at ?? null) : null,
      late_penalty_applied: isDraft ? (existing?.late_penalty_applied ?? 0) : 0,
      regrade_request: isDraft ? (existing?.regrade_request ?? null) : null
    };

    if (await SupabaseDB.saveSubmission(submission)) {
      if (renderId !== window.currentRenderId) return;
      // Update Progress
      const a = await SupabaseDB.getAssignment(assignmentId);
      if (renderId !== window.currentRenderId) return;
      if (a) await SupabaseDB.updateCourseProgress(a.course_id, studentEmail);
      if (renderId !== window.currentRenderId) return;

      UI.showNotification(isDraft ? 'Draft saved successfully!' : 'Assignment submitted successfully!', 'success');
      renderAssignments();
    } else {
        throw new Error('Save failed');
    }
  } catch (e) {
    console.error('Submission failed:', e);
    UI.showNotification(`Submission failed: ${e.message || 'Unknown error'}. ${e.details || ''}`);
  } finally {
    StudentState.isSubmittingAssignment = false;
    AntiCheat.destroy(); // Destroy after all processing is complete
    UI.hideLoading('assignmentForm');
    if (btn) {
        btn.disabled = false;
        btn.textContent = isDraft ? 'Save Draft' : 'Submit Assignment';
    }
    if (otherBtn) otherBtn.disabled = false;
  }
}

window.addEventListener('beforeunload', async (e) => {
  if (StudentState.currentQuiz && StudentState.currentSubmission) {
    e.preventDefault();
    e.returnValue = 'You have an active quiz. Are you sure you want to leave?';
  }
  if (StudentState.studyInterval) {
      // Browsers may not allow async in beforeunload, but we try a sync-like save or just let it go
      // In many cases, it's better to use beacon or just accept loss on hard close.
      // But we can try to call stopStudySession.
      stopStudySession();
  }
});

function initNav() {
  const studentNav = document.getElementById('studentNav');
  if (studentNav) {
    studentNav.querySelectorAll('button').forEach(button => {
      button.addEventListener('click', async (e) => {
        studentNav.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        button.classList.add('active');
        const page = button.dataset.page;
        if (StudentState.studyInterval) await stopStudySession();
        if(page === 'courses') renderCourses();
        else if(page === 'my-courses') renderMyCourses();
        else if(page === 'assignments') renderAssignments();
        else if(page === 'quizzes') renderQuizzes();
        else if(page === 'dashboard') renderDashboardOverview();
        else if(page === 'progress') renderProgress();
        else if(page === 'grades') renderGrades();
        else if(page === 'analytics') renderAnalytics();
        else if(page === 'calendar') renderCalendar();
        else if(page === 'materials') renderMaterials();
        else if(page === 'anticheat') renderAntiCheat();
        else if(page === 'discussions') renderDiscussions();
        else if(page === 'certificates') renderCertificates();
        else if(page === 'planner') renderPlanner();
        else if(page === 'live') renderLiveClasses();
        else if(page === 'settings') renderSettings();
        else if(page === 'help') renderHelp();
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await initDashboard('student');
  if (user) {
    initNav();
    NotificationManager.init();
    NotificationManager.initRealtimeSubscriptions(user.email, 'student', () => {
        if (!StudentState.currentQuiz) renderQuizzes();
    });

    // Deep linking support
    const urlParams = new URLSearchParams(window.location.search);
    const page = urlParams.get('page');
    if (page) {
        const navBtn = document.querySelector(`nav button[data-page="${page}"]`);
        if (navBtn) {
            navBtn.click();
        } else {
            renderDashboardOverview();
        }
    } else {
        renderDashboardOverview();
    }

    setInterval(updateMaintBanner, 30000);
    updateMaintBanner();
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        if (typeof stopStudySession === 'function') await stopStudySession();
        await SessionManager.clearCurrentUser('manual_logout');
        window.location.href = 'index.html'; 
      });
    }
  }
});

