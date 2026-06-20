const TeacherState = {
  activeCountdowns: [],
  currentGradeBookData: null,
  gradeBookRawData: null,
  currentStudents: [],
  _warnedEnd: false,
  liveClassTimer: null
};

function clearActiveCountdowns() {
    UI.clearCountdowns(TeacherState.activeCountdowns, TeacherState.liveClassTimer);
    TeacherState.liveClassTimer = null;
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

async function renderDashboard() {
  const renderId = ++window.currentRenderId;
  NotificationManager.init();
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const [coursesCount, assignmentsCount, submissionsCount, pendingCount, violationsRes] = await Promise.all([
      SupabaseDB.getCount('courses', q => q.eq('teacher_email', user.email)),
      SupabaseDB.getCount('assignments', q => q.eq('teacher_email', user.email)),
      SupabaseDB.getCount('submissions', q => q.eq('assignments.teacher_email', user.email), '*, assignments!inner(*)'),
      SupabaseDB.getCount('submissions', q => q.eq('assignments.teacher_email', user.email).or('status.eq.submitted,regrade_request.not.is.null'), '*, assignments!inner(*)'),
      SupabaseDB.getViolations(null, null, user.email)
    ]);
    if (renderId !== window.currentRenderId) return;
    const violationsCount = violationsRes.total || 0;

    content.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><h4>My Courses</h4><div class="value">${escapeHtml(coursesCount)}</div></div>
      <div class="stat-card"><h4>Assignments</h4><div class="value">${escapeHtml(assignmentsCount)}</div></div>
      <div class="stat-card"><h4>Total Submissions</h4><div class="value">${escapeHtml(submissionsCount)}</div></div>
      <div class="stat-card warn"><h4>Pending Grading</h4><div class="value">${escapeHtml(pendingCount)}</div></div>
      <div class="stat-card ${violationsCount > 0 ? 'danger' : ''}"><h4>Security Alerts</h4><div class="value">${escapeHtml(violationsCount)}</div></div>
    </div>
      <section><h3>Teacher Overview</h3><p>Welcome back! You have ${escapeHtml(pendingCount)} submissions waiting to be graded.</p></section>
    `;
  } catch (error) {
    console.error('Dashboard error:', error);
    UI.showNotification('Error loading dashboard: ' + error.message, 'error');
    content.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Dashboard</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderDashboard()">Retry</button>
    </div>`;
  }
}

async function renderCourses() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const { data: courses } = await SupabaseDB.getCourses(user.email);
    if (renderId !== window.currentRenderId) return;

    content.innerHTML = `
    <div class="card flex-between">
      <h2 class="m-0">Course Management</h2>
      <button class="button w-auto" onclick="showCourseForm()">+ Create Course</button>
    </div>
    <div class="grid">
      ${courses.map(c => `
        <div class="card">
          <h3 class="m-0">${escapeHtml(c.title)}</h3>
          <div class="small">${UI.renderRichText(c.description)}</div>
          <div class="mt-10"><span class="badge ${c.status === 'published' ? 'badge-active' : 'badge-lock'}">${escapeHtml(c.status)}</span></div>
          <div class="flex gap-10 mt-15">
            <button class="button w-auto small" onclick="editCourse('${escapeAttr(c.id)}')">Manage Lessons</button>
            <button class="button secondary w-auto small" onclick="loadAndEditCourse('${escapeAttr(c.id)}')">Edit Info</button>
            <button class="button danger w-auto small" onclick="deleteCourseById('${escapeAttr(c.id)}')">Delete</button>
          </div>
        </div>
      `).join('') || '<div class="empty">No courses created yet.</div>'}
      </div>
    `;
  } catch (error) {
    console.error('Courses error:', error);
    UI.showNotification('Error loading courses: ' + error.message, 'error');
    content.innerHTML = `<div class="card danger-border">
      <h3>Error Loading Courses</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderCourses()">Retry</button>
    </div>`;
  }
}

async function loadAndEditCourse(id) {
    const renderId = window.currentRenderId;
    try {
        const course = await SupabaseDB.getCourse(id);
        if (renderId !== window.currentRenderId) return;
        if (course) showCourseForm(course);
    } catch (e) {
        UI.showNotification('Error loading course: ' + e.message, 'error');
    }
}

function showCourseForm(course = null) {
  const content = document.getElementById('pageContent');
  if (!content) return;
  const isEdit = !!course;

  content.innerHTML = `
    <div class="card">
      <h2>${isEdit ? 'Edit Course' : 'Create Course'}</h2>
      <form id="courseForm">
        <div class="grid">
          <div>
            <label>Course Title</label>
            <input type="text" id="courseTitle" placeholder="Course Title" value="${isEdit ? escapeHtml(course.title) : ''}" required>
          </div>
          <div>
            <label>Description</label>
            <textarea id="courseDescription" placeholder="Description" rows="4">${isEdit ? escapeHtml(course.description || '') : ''}</textarea>
          </div>
          <div>
            <label>Enrollment ID (Optional)</label>
            <input type="text" id="courseEnrollmentId" placeholder="Require ID for enrollment" value="${isEdit ? escapeHtml(course.enrollment_id || '') : ''}">
          </div>
          <div>
            <label>Status</label>
            <select id="courseStatus">
              <option value="draft" ${isEdit && course.status === 'draft' ? 'selected' : ''}>Draft</option>
              <option value="published" ${isEdit && course.status === 'published' ? 'selected' : ''}>Published</option>
            </select>
          </div>
        </div>
        <div class="flex gap-10 mt-20">
          <button type="submit" class="button w-auto px-30">${isEdit ? 'Update Course' : 'Create Course'}</button>
          <button type="button" class="button secondary w-auto px-30" onclick="renderCourses()">Cancel</button>
        </div>
      </form>
    </div>
  `;
  UI.createRTE('courseDescription');
  document.getElementById('courseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Saving...';

    try {
      const user = await SessionManager.getCurrentUser();
      const courseId = isEdit ? course.id : crypto.randomUUID();

      const title = document.getElementById('courseTitle').value.trim();
      const vTitle = Validator.required(title, 'Course title');
      if (!vTitle.valid) return UI.showNotification(vTitle.message, 'warn');

      const courseData = {
        id: courseId,
        title: title,
        description: document.getElementById('courseDescription').value,
        enrollment_id: document.getElementById('courseEnrollmentId').value || null,
        status: document.getElementById('courseStatus').value,
        teacher_email: user.email,
        created_by: user.full_name,
        metadata: course?.metadata || {}
      };

      await SupabaseDB.saveCourse(courseData);
      UI.showNotification('Course saved successfully', 'success');
      renderCourses();
    } catch (err) {
      UI.showNotification('Error saving course: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}
async function editCourse(id) {
  const user = await SessionManager.getCurrentUser();
  const [{ data: courses }, topicRes, lessonRes, { data: courseAssignments }] = await Promise.all([
    SupabaseDB.getCourses(user.email, null),
    SupabaseDB.getTopics(id),
    SupabaseDB.getLessons(id),
    SupabaseDB.getAssignments(user.email, id, null)
  ]);
  const topics = topicRes.data || [];
  const lessons = lessonRes.data || [];
  const course = (courses || []).find(c => c.id === id);
  const content = document.getElementById('pageContent');
  if (!content) return;

  const topicsWithLessons = topics.map(t => ({
    ...t,
    lessons: lessons.filter(l => l.topic_id === t.id)
  })).sort((a, b) => a.order_index - b.order_index);

  const uncategorizedLessons = lessons.filter(l => !l.topic_id);

  content.innerHTML = `
    <div class="card flex-between">
      <h2 class="m-0">Course: ${escapeHtml(course.title)}</h2>
      <div class="flex gap-10">
        <button class="button secondary w-auto" onclick="renderCourses()">← Back to Courses</button>
      </div>
    </div>
    <div class="grid-2 mt-20">
      <section class="card">
        <div class="flex-between">
          <h3 class="m-0">Topics & Lessons</h3>
          <div class="flex gap-5">
            <button class="button secondary w-auto small" onclick="void showTopicForm('${id}')">+ Add Topic</button>
            <button class="button w-auto small" onclick="void showLessonForm('${id}')">+ Add Lesson</button>
          </div>
        </div>
        <div class="mt-15">
          ${topicsWithLessons.map(t => `
            <div class="mb-20">
              <div class="flex-between p-10 bg-light border-radius-sm mb-5">
                <div style="flex:1">
                  <strong class="small d-block">${escapeHtml(t.title)}</strong>
                  <div class="tiny text-muted mt-2">${UI.renderRichText(t.description)}</div>
                </div>
                <div class="flex gap-5">
                  <button class="button tiny w-auto secondary" onclick="void showTopicForm('${id}', ${escapeAttr(JSON.stringify(t))})">Edit Topic</button>
                  <button class="button tiny w-auto danger" onclick="deleteTopicById('${t.id}', '${id}')">Delete</button>
                </div>
              </div>
              <div class="pl-15">
                ${t.lessons.map(l => `
                  <div class="flex-between list-item py-5">
                    <span class="small">${escapeHtml(l.title)}</span>
                    <div class="flex gap-5">
                      <button class="button tiny w-auto" onclick="void editLesson('${l.id}', '${id}')">Edit</button>
                      <button class="button tiny w-auto danger" onclick="deleteLessonById('${l.id}', '${id}')">Delete</button>
                    </div>
                  </div>
                `).join('') || '<div class="tiny text-muted p-5">No lessons in this topic.</div>'}
              </div>
            </div>
          `).join('')}

          ${uncategorizedLessons.length > 0 ? `
            <div class="mb-20">
              <div class="p-10 bg-light border-radius-sm mb-5">
                <strong class="small danger-text italic">Uncategorized Lessons (Please assign to a topic)</strong>
              </div>
              <div class="pl-15">
                ${uncategorizedLessons.map(l => `
                  <div class="flex-between list-item py-5">
                    <span class="small">${escapeHtml(l.title)}</span>
                    <div class="flex gap-5">
                      <button class="button tiny w-auto" onclick="void editLesson('${l.id}', '${id}')">Edit</button>
                      <button class="button tiny w-auto danger" onclick="deleteLessonById('${l.id}', '${id}')">Delete</button>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${topics.length === 0 && uncategorizedLessons.length === 0 ? '<div class="empty p-10">No topics or lessons yet.</div>' : ''}
        </div>
      </section>
      <section class="card">
        <div class="flex-between">
          <h3 class="m-0">Assignments</h3>
          <button class="button w-auto small" onclick="showAssignmentForm(null, '${id}')">+ Create Assignment</button>
        </div>
        <div class="mt-15">
          ${courseAssignments.map(a => `
            <div class="flex-between list-item">
              <span>${escapeHtml(a.title)}</span>
              <div class="flex gap-5">
                <button class="button small w-auto" onclick="editAssignment('${a.id}')">Edit</button>
                <button class="button danger small w-auto" onclick="deleteAssignmentById('${a.id}', '${id}')">Delete</button>
              </div>
            </div>
          `).join('') || '<div class="empty p-10">No assignments yet.</div>'}
        </div>
      </section>
    </div>
  `;
}
async function showLessonForm(courseId, lesson = null) {
  const isEdit = !!lesson;
  const content = document.getElementById('pageContent');
  if (!content) return;

  const { data: topics } = await SupabaseDB.getTopics(courseId);

  content.innerHTML = `
    <div class="card">
      <h2 class="m-0">${isEdit ? 'Edit Lesson' : 'Add Lesson'}</h2>
      <form id="lessonForm" class="mt-20">
        <label>Lesson Title</label>
        <input type="text" id="lessonTitle" placeholder="Lesson Title" value="${isEdit ? escapeHtml(lesson.title) : ''}" required>

        <label>Topic</label>
        <select id="lessonTopicId" required>
          <option value="">-- Select Topic --</option>
          ${topics.map(t => `<option value="${t.id}" ${lesson?.topic_id === t.id ? 'selected' : ''}>${escapeHtml(t.title)}</option>`).join('')}
        </select>
        ${topics.length === 0 ? '<p class="tiny danger-text mt-5">No topics found. Please create a topic first.</p>' : ''}

        <label class="mt-10">Video URL (Optional)</label>
        <input type="url" id="lessonVideoUrl" placeholder="https://youtube.com/..." value="${isEdit ? escapeHtml(lesson.video_url || '') : ''}">
        <label>Content</label>
        <textarea id="lessonContent" placeholder="Lesson content..." rows="10">${isEdit ? escapeHtml(lesson.content) : ''}</textarea>
        <label>Order Index</label>
        <input type="number" id="lessonOrder" placeholder="Order Index" value="${isEdit ? lesson.order_index : 0}">
        <div class="flex gap-10 mt-20">
          <button type="submit" class="button w-auto px-40" ${topics.length === 0 ? 'disabled' : ''}>${isEdit ? 'Update Lesson' : 'Save Lesson'}</button>
          <button type="button" class="button secondary w-auto px-40" onclick="editCourse('${courseId}')">Cancel</button>
        </div>
      </form>
    </div>
  `;
  UI.createRTE('lessonContent', { minHeight: '300px' });
  document.getElementById('lessonForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Saving...';

    try {
      const title = document.getElementById('lessonTitle').value.trim();
      const vTitle = Validator.required(title, 'Lesson title');
      if (!vTitle.valid) {
          UI.showNotification(vTitle.message, 'warn');
          btn.disabled = false;
          btn.textContent = originalText;
          return;
      }

      const videoUrl = document.getElementById('lessonVideoUrl').value || null;
      if (videoUrl && !isValidUrl(videoUrl)) {
          UI.showNotification('Please enter a valid URL for the video.', 'error');
          btn.disabled = false;
          btn.textContent = originalText;
          return;
      }

      const topicId = document.getElementById('lessonTopicId').value;
      if (!topicId) {
          UI.showNotification('Please select a topic for this lesson.', 'error');
          btn.disabled = false;
          btn.textContent = originalText;
          return;
      }

      const data = {
          ...lesson,
          id: isEdit ? lesson.id : crypto.randomUUID(),
          course_id: courseId,
          topic_id: topicId,
          title: document.getElementById('lessonTitle').value,
          video_url: videoUrl,
          content: document.getElementById('lessonContent').value,
          order_index: parseInt(document.getElementById('lessonOrder').value) || 0
      };
      await SupabaseDB.saveLesson(data);
      UI.showNotification('Lesson saved successfully', 'success');
      editCourse(courseId);
    } catch (e) {
      UI.showNotification('Error saving lesson: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}
async function editLesson(lessonId, courseId) {
  const lessonRes = await SupabaseDB.getLessons(courseId);
  const lessons = lessonRes.data || [];
  const lesson = lessons.find(l => l.id === lessonId);
  await showLessonForm(courseId, lesson);
}
async function deleteLessonById(id, courseId) {
  if (await UI.confirm('Are you sure you want to delete this lesson?', 'Delete Lesson')) {
    try {
      await SupabaseDB.deleteLesson(id);
      UI.showNotification('Lesson deleted', 'success');
      editCourse(courseId);
    } catch (e) {
      UI.showNotification('Error deleting lesson: ' + e.message, 'error');
    }
  }
}
function showTopicForm(courseId, topic = null) {
  const isEdit = !!topic;
  const content = document.getElementById('pageContent');
  if (!content) return;
  content.innerHTML = `
    <div class="card">
      <h2 class="m-0">${isEdit ? 'Edit Topic' : 'Add Topic'}</h2>
      <form id="topicForm" class="mt-20">
        <label>Topic Title</label>
        <input type="text" id="topicTitle" placeholder="Topic Title" value="${isEdit ? escapeHtml(topic.title) : ''}" required>
        <label>Description (Optional)</label>
        <textarea id="topicDescription" placeholder="Briefly describe this topic..." rows="3">${isEdit ? escapeHtml(topic.description || '') : ''}</textarea>
        <label>Order Index</label>
        <input type="number" id="topicOrder" placeholder="Order Index" value="${isEdit ? topic.order_index : 0}">
        <div class="flex gap-10 mt-20">
          <button type="submit" class="button w-auto px-40">${isEdit ? 'Update Topic' : 'Save Topic'}</button>
          <button type="button" class="button secondary w-auto px-40" onclick="editCourse('${courseId}')">Cancel</button>
        </div>
      </form>
    </div>
  `;
  UI.createRTE('topicDescription');
  document.getElementById('topicForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Saving...';

    try {
      const user = await SessionManager.getCurrentUser();
      const title = document.getElementById('topicTitle').value.trim();
      const vTitle = Validator.required(title, 'Topic title');
      if (!vTitle.valid) {
          UI.showNotification(vTitle.message, 'warn');
          btn.disabled = false;
          btn.textContent = originalText;
          return;
      }

      const data = {
          ...topic,
          id: isEdit ? topic.id : crypto.randomUUID(),
          course_id: courseId,
          teacher_email: user.email,
          title: title,
          description: document.getElementById('topicDescription').value,
          order_index: parseInt(document.getElementById('topicOrder').value) || 0
      };
      await SupabaseDB.saveTopic(data);
      UI.showNotification('Topic saved successfully', 'success');
      editCourse(courseId);
    } catch (e) {
      UI.showNotification('Error saving topic: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

async function deleteTopicById(id, courseId) {
  if (await UI.confirm('Are you sure you want to delete this topic? All lessons inside this topic will also be deleted.', 'Delete Topic')) {
    try {
      await SupabaseDB.deleteTopic(id);
      UI.showNotification('Topic deleted', 'success');
      editCourse(courseId);
    } catch (e) {
      UI.showNotification('Error deleting topic: ' + e.message, 'error');
    }
  }
}

async function deleteCourseById(id) {
  if (await UI.confirm('Are you sure you want to delete this course and all its content?', 'Delete Course')) {
    UI.showNotification('Deleting course...', 'info');
    try {
      await SupabaseDB.deleteCourse(id);
      UI.showNotification('Course deleted successfully', 'success');
      renderCourses();
    } catch (e) {
      UI.showNotification('Error deleting course: ' + e.message, 'error');
    }
  }
}
async function renderAssignments() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const now = TimerManager.getTime();
    const [{ data: assignments }, { data: courses }] = await Promise.all([
      SupabaseDB.getAssignments(user.email, null, null),
      SupabaseDB.getCourses(user.email, null)
    ]);
    if (renderId !== window.currentRenderId) return;

  content.innerHTML = `
    <div class="card flex-between">
      <h2 class="m-0">My Assignments</h2>
      <button class="button w-auto" onclick="showAssignmentForm()">+ Create Assignment</button>
    </div>
    <div class="grid">
      ${assignments.map(a => {
        const course = courses.find(c => c.id === a.course_id);
        return `
        <div class="card">
          <h3 class="m-0">${escapeHtml(a.title)}</h3>
          <p class="small"><strong>Course:</strong> ${escapeHtml(course?.title || 'None')}</p>
          <div class="small">${UI.renderRichText(a.description)}</div>
          <div class="mt-10">
            <p class="small m-0 mb-5">Due: ${new Date(a.due_date).toLocaleString()}</p>
            ${new Date(a.due_date).getTime() > now ? `
                <div class="assign-countdown"
                     data-target="${new Date(a.due_date).getTime()}"
                     data-start="${a.start_at || (a.created_at ? new Date(a.created_at).getTime() : now)}"
                     data-status="${a.status || 'published'}"></div>
            ` : '<div class="danger-text bold tiny">Past Due</div>'}
          </div>
          <div class="flex gap-10 mt-15">
            <button class="button small w-auto" onclick="editAssignment('${escapeAttr(a.id)}')">Edit</button>
            <button class="button small w-auto danger" onclick="deleteAssignmentById('${escapeAttr(a.id)}')">Delete</button>
          </div>
        </div>
`;}).join('') || '<div class="empty">No assignments found.</div>'}
      </div>
    `;

    Countdown.createAll('.assign-countdown', {
        showProgress: true,
        compact: true,
        label: 'Expires in:',
        onEnd: () => renderAssignments()
    }).forEach(c => TeacherState.activeCountdowns.push(c));

  } catch (error) {
    console.error('Assignments error:', error);
    UI.showNotification('Error loading assignments: ' + error.message, 'error');
    content.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Assignments</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderAssignments()">Retry</button>
    </div>`;
  }
}
async function renderGrading() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    // Optimization: Use server-side filtering for submitted status and regrade requests
    const [{ data: submittedSubs, total }, { data: assignments }] = await Promise.all([
      SupabaseDB.getSubmissions(null, null, user.email, {
        pendingGradingOnly: true
      }),
      SupabaseDB.getAssignments(user.email, null, null)
    ]);
    if (renderId !== window.currentRenderId) return;

    content.innerHTML = `
      <div class="flex-between mb-20">
        <h2 class="m-0">Grading Queue</h2>
        <div class="small text-muted">${escapeHtml(total)} Submissions Pending</div>
      </div>
      <div id="gradingQueueTable"></div>
    `;

    UI.renderTable('gradingQueueTable', ['Assignment', 'Student', 'Submitted', 'Status', 'Action'], submittedSubs, (s) => {
        const assignment = assignments.find(a => a.id === s.assignment_id);
        const isRegrade = !!s.regrade_request;
        return `
            <tr>
                <td><strong>${escapeHtml(assignment?.title || 'Unknown')}</strong></td>
                <td>${escapeHtml(s.student_email)}</td>
                <td>${new Date(s.submitted_at).toLocaleString()}</td>
                <td>${isRegrade ? '<span class="badge badge-warn">REGRADE REQ</span>' : '<span class="badge badge-active">NEW SUB</span>'}</td>
                <td><button class="button small w-auto" onclick="gradeSubmission('${escapeAttr(s.assignment_id)}', '${escapeAttr(s.student_email)}')">Review</button></td>
            </tr>
        `;
    }, { emptyMessage: '<h3>All caught up!</h3><p class="small">No pending submissions to grade.</p>' });
  } catch (error) {
    console.error('Grading error:', error);
    UI.showNotification('Error loading grading queue: ' + error.message, 'error');
    content.innerHTML = `<div class="card danger-border">
      <h3>Error Loading Queue</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderGrading()">Retry</button>
    </div>`;
  }
}
async function renderStudents() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  const searchTerm = document.getElementById('studentSearch')?.value || '';

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const { data: myCourses } = await SupabaseDB.getCourses(user.email, null);
    if (renderId !== window.currentRenderId) return;
    const myCourseIds = (myCourses || []).map(c => c.id);

    const { data: enrollments } = await SupabaseDB.getEnrollmentsByCourses(myCourseIds, {
        searchTerm
    });
    if (renderId !== window.currentRenderId) return;

    const students = enrollments.map(e => {
        return {
            full_name: e.users?.full_name,
            email: e.student_email,
            course_title: e.courses?.title,
            course_id: e.course_id
        };
    }).filter(s => s.email);

    content.innerHTML = `
    <div class="card">
      <div class="flex-between mb-20">
        <h2 class="m-0">My Enrolled Students</h2>
        <div class="flex gap-10">
            <input type="text" id="studentSearch" placeholder="Search by name or email..." class="m-0" style="width:250px" value="${escapeAttr(searchTerm)}">
            <button class="button secondary small w-auto" onclick="exportStudents('csv')">CSV</button>
            <button class="button secondary small w-auto" onclick="exportStudents('pdf')">PDF</button>
        </div>
      </div>
      <div class="p-0 mt-15" style="overflow-x:auto">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Course</th><th>Action</th></tr></thead>
            <tbody>
              ${students.map(s => `
                <tr>
                  <td>${escapeHtml(s.full_name)}</td>
                  <td>${escapeHtml(s.email)}</td>
                  <td>${escapeHtml(s.course_title || 'Unknown')}</td>
                  <td class="flex gap-10">
                    <button class="button small w-auto" onclick="showCertForm('${escapeAttr(s.email)}')">Issue Certificate</button>
                    <button class="button danger small w-auto" onclick="unenrollStudent('${escapeAttr(s.course_id)}', '${escapeAttr(s.email)}')">Unenroll</button>
                  </td>
                </tr>
              `).join('') || '<tr><td colspan="4" class="empty">No students found.</td></tr>'}
            </tbody>
          </table>
      </div>
    </div>
    <div id="certFormArea" class="hidden mt-20"></div>
    `;

    const searchInput = document.getElementById('studentSearch');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(() => {
            renderStudents();
        }, 500));
        searchInput.focus();
        // Restore cursor position if possible or just end
        searchInput.setSelectionRange(searchTerm.length, searchTerm.length);
    }

    TeacherState.currentStudents = students;

  } catch (error) {
    console.error('Students error:', error);
    content.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Students</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderStudents()">Retry</button>
    </div>`;
  }
}

async function unenrollStudent(courseId, studentEmail) {
  if (!await UI.confirm('Are you sure you want to completely unenroll this student? This will delete all their progress in this course.', 'Confirm Unenrollment')) return;

  const btn = document.querySelector(`button[onclick*="unenrollStudent('${courseId}', '${studentEmail}')"]`);
  const originalText = btn ? btn.textContent : 'Unenroll';
  if (btn) { btn.disabled = true; btn.textContent = 'Unenrolling...'; }

  try {
    await SupabaseDB.deleteEnrollment(courseId, studentEmail);
    UI.showNotification('Student unenrolled successfully.', 'success');
    renderStudents();
  } catch (e) {
    UI.showNotification('Unenrollment failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

async function renderCertificates() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;

    // Fetch teacher's courses first to filter certificates
    const { data: myCourses } = await SupabaseDB.getCourses(user.email, null);
    const myCourseIds = (myCourses || []).map(c => c.id);

    // Fetch all certificates related to this teacher
    const { data: certs } = await SupabaseDB.getCertificates(null, user.email);
    if (renderId !== window.currentRenderId) return;

    content.innerHTML = `
      <div class="flex-between mb-20">
        <h2 class="m-0">Course Certificates</h2>
        <div class="small text-muted">${certs.length} Total Certificates</div>
      </div>
      <div id="certsTable"></div>
      <div id="certFormArea" class="hidden mt-20"></div>
    `;

    UI.renderTable('certsTable', ['Student', 'Course', 'Status', 'Date', 'Action'], certs, (c) => {
        const isRequested = c.status === 'requested';
        let statusBadge = 'badge-warn';
        if (c.status === 'approved') statusBadge = 'badge-active';
        else if (c.status === 'rejected') statusBadge = 'badge-inactive';

        return `
            <tr>
              <td>
                <div class="bold small">${escapeHtml(c.student_email)}</div>
              </td>
              <td>${escapeHtml(c.courses?.title || 'Unknown')}</td>
              <td><span class="badge ${statusBadge}">${c.status.toUpperCase()}</span></td>
              <td>${new Date(c.updated_at).toLocaleDateString()}</td>
              <td>
                <div class="flex gap-5">
                  ${isRequested ? `
                    <button class="button small w-auto" onclick="showCertForm('${escapeAttr(c.student_email)}', '${escapeAttr(c.course_id)}', '${escapeAttr(c.id)}')">Issue Certificate</button>
                  ` : `
                    <button class="button secondary tiny w-auto" onclick="UI.viewFile('${escapeAttr(c.certificate_url)}', 'Certificate')">View</button>
                  `}
                </div>
              </td>
            </tr>
        `;
    }, { emptyMessage: 'No certificates requested or issued yet.' });

  } catch (error) {
    console.error('Certificates error:', error);
    UI.showNotification('Error loading certificates: ' + error.message, 'error');
  }
}

async function showCertForm(studentEmail, targetCourseId = null, requestedCertId = null) {
  const renderId = window.currentRenderId;
  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;

    let courses = [];
    if (targetCourseId) {
        const course = await SupabaseDB.getCourse(targetCourseId);
        courses = [course];
    } else {
        // Filter courses: only show courses where the student is actually enrolled
        const studentEnrolledCourseIds = TeacherState.currentStudents
            .filter(s => s.email === studentEmail)
            .map(s => s.course_id);

        const { data: allCourses } = await SupabaseDB.getCourses(user.email, null);
        if (renderId !== window.currentRenderId) return;

        courses = allCourses.filter(c => studentEnrolledCourseIds.includes(c.id));
    }

    const area = document.getElementById('certFormArea');
    if (!area) return;
    area.classList.remove('hidden');
    area.scrollIntoView({ behavior: 'smooth' });
    area.innerHTML = `
    <div class="card">
      <h3 class="m-0">Issue Certificate to ${escapeHtml(studentEmail)}</h3>
      <label class="mt-15">Select Course</label>
      <select id="certCourseId">${courses.map(c => `<option value="${escapeAttr(c.id)}" ${targetCourseId === c.id ? 'selected' : ''}>${escapeHtml(c.title)}</option>`).join('')}</select>
      ${courses.length === 0 ? '<p class="tiny danger-text mt-5">Student is not enrolled in any of your courses.</p>' : ''}
      <p class="small mt-10">This will generate a official PDF certificate and award it to the student.</p>
      <div class="flex gap-10 mt-15">
        <button class="button w-auto px-30" id="issueCertBtn" onclick="issueCert('${escapeAttr(studentEmail)}', '${escapeAttr(requestedCertId || '')}')" ${courses.length === 0 ? 'disabled' : ''}>Issue & Generate PDF</button>
        <button class="button secondary w-auto px-30" onclick="document.getElementById('certFormArea').classList.add('hidden')">Cancel</button>
      </div>
    </div>
  `;
  } catch (error) {
    console.error('Show cert form error:', error);
    UI.showNotification('Error opening certificate form: ' + error.message, 'error');
  }
}

async function issueCert(studentEmail, existingId = null) {
  const btn = document.getElementById('issueCertBtn');
  btn.disabled = true; btn.textContent = 'Generating...';

  // Handle potential 'null' string passed from HTML event handlers
  const certId = (existingId === 'null' || !existingId) ? null : existingId;
  const courseId = document.getElementById('certCourseId').value;

  try {
    const user = await SessionManager.getCurrentUser();
    const student = await SupabaseDB.getUser(studentEmail);
    const course = await SupabaseDB.getCourse(courseId);

    if (!student || !course) throw new Error('Student or Course data not found');

    // Fetch existing cert to preserve verification_id if possible
    let verificationId = crypto.randomUUID().slice(0, 13).toUpperCase();
    if (certId) {
        const { data: existing } = await supabaseClient.from('certificates').select('metadata').eq('id', certId).maybeSingle();
        if (existing?.metadata?.verification_id) {
            verificationId = existing.metadata.verification_id;
        }
    } else {
        // Even if no ID is passed, check if a cert already exists for this student/course to avoid duplicates
        const { data: existing } = await supabaseClient.from('certificates')
            .select('id, metadata')
            .match({ student_email: studentEmail, course_id: courseId, type: 'single' })
            .maybeSingle();
        if (existing?.metadata?.verification_id) {
            verificationId = existing.metadata.verification_id;
        }
    }

    const issueDate = new Date().toISOString();
    const verificationUrl = `${window.location.origin}/index.html?page=verify&id=${verificationId}`;

    const doc = await CertificateGenerator.generatePDF(student.full_name, course.title, issueDate, verificationId, {
        teacherName: user.full_name,
        verificationUrl: verificationUrl,
        isApproved: false
    });

    if (!doc) throw new Error('PDF Generation failed');

    // Upload to Supabase Storage
    const pdfBlob = doc.output('blob');
    const path = `certificates/${studentEmail}/${courseId}_${TimerManager.getTime()}.pdf`;

    // Teacher issuance always creates a new certificate or updates one,
    // but we check if we should cleanup the old file if existingId is provided
    if (existingId) {
        try {
            const { data: oldCert } = await supabaseClient.from('certificates').select('certificate_url').eq('id', existingId).maybeSingle();
            if (oldCert?.certificate_url) {
                await SupabaseDB.deleteFileByUrl(oldCert.certificate_url);
            }
        } catch(e) {}
    }

    await SupabaseDB.uploadFile('certificates', path, pdfBlob);
    const certUrl = await SupabaseDB.getPublicUrl('certificates', path);

    const { data: currentCert } = certId ? await supabaseClient.from('certificates').select('metadata').eq('id', certId).maybeSingle() : { data: null };

    await SupabaseDB.issueCertificate({
      id: certId || crypto.randomUUID(),
      student_email: studentEmail,
      course_id: courseId,
      certificate_url: certUrl,
      issued_at: issueDate,
      status: 'pending_approval',
      metadata: { ...(currentCert?.metadata || {}), verification_id: verificationId }
    });

    UI.showNotification('Certificate issued and sent to admin for approval.', 'success');

    if (document.querySelector('[data-page="certificates"].active')) {
        renderCertificates();
    } else {
        renderStudents();
    }

    const area = document.getElementById('certFormArea');
    if (area) area.classList.add('hidden');
  } catch (e) {
    console.error('Cert Issue error:', e);
    UI.showNotification('Error issuing certificate: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Issue & Generate PDF';
  }
}
function updateAssignmentTotalPoints() {
  const total = Array.from(document.querySelectorAll('#questionsContainer .q-points'))
      .reduce((sum, input) => sum + (parseFloat(input.value) || 0), 0);
  const pointsInput = document.getElementById('assignmentPoints');
  if (pointsInput) pointsInput.value = total;
}

function addQuestionField(q = null) {
  const container = document.getElementById('questionsContainer');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'question mb-20 card';
    const qId = 'q-text-' + TimerManager.getTime() + Math.random().toString(36).substring(2, 9);
  div.innerHTML = `
    <div class="flex-between mb-15">
      <h4 class="m-0">Assignment Question</h4>
      <button type="button" class="button danger small w-auto" onclick="this.closest('.question').remove(); updateAssignmentTotalPoints();">Remove Question</button>
    </div>
    <div class="grid">
      <div class="mb-10">
        <label class="bold">Question Text:</label>
        <textarea id="${qId}" class="q-text" placeholder="Enter question description here..." required style="display:none">${q ? escapeHtml(q.text) : ''}</textarea>
      </div>
      <div class="grid-2">
        <div>
          <label class="bold small">Submission Types (select at least one):</label>
          <div class="flex gap-15 mt-5 flex-wrap">
            <label class="flex-center-y gap-5 tiny pointer"><input type="checkbox" class="q-type-checkbox" value="essay" ${ (q?.types?.includes('essay') || q?.type === 'essay') ? 'checked' : '' }> Essay</label>
            <label class="flex-center-y gap-5 tiny pointer"><input type="checkbox" class="q-type-checkbox" value="file" ${ (q?.types?.includes('file') || q?.type === 'file') ? 'checked' : '' } onchange="toggleTeacherAssignmentType(this)"> File</label>
            <label class="flex-center-y gap-5 tiny pointer"><input type="checkbox" class="q-type-checkbox" value="link" ${ (q?.types?.includes('link') || q?.type === 'link') ? 'checked' : '' }> Link</label>
          </div>
        </div>
        <div><label class="bold small">Question Points:</label><input type="number" class="q-points" value="${q ? q.points : 10}" min="0"></div>
      </div>
      <div class="q-type-ext mt-10" style="${ (q?.types?.includes('file') || q?.type === 'file') ? '' : 'display:none' }">
        <label class="small">Allowed Extensions (comma-separated):</label>
        <input type="text" class="q-ext" placeholder=".pdf, .docx, .csv, .jpg" value="${q?.extensions || ''}">
      </div>
    </div>
  `;
  container.appendChild(div);
  UI.createRTE(qId, { minHeight: '60px' });

  // Auto-update total points when individual question points change
  div.querySelector('.q-points').addEventListener('input', updateAssignmentTotalPoints);
  div.querySelector('.q-points').addEventListener('change', updateAssignmentTotalPoints);

  updateAssignmentTotalPoints();
}

async function showAssignmentForm(assignment = null, courseId = null) {
  const renderId = window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  const isEdit = !!assignment;
  const finalCourseId = isEdit ? assignment.course_id : courseId;

  const user = await SessionManager.getCurrentUser();
  if (renderId !== window.currentRenderId) return;
  const { data: courses } = await SupabaseDB.getCourses(user.email, null);
  if (renderId !== window.currentRenderId) return;

  content.innerHTML = `
    <div class="card">
      <h2>${isEdit ? 'Edit Assignment' : 'Create Assignment'}</h2>
      <form id="assignmentForm">
        <label>Assignment Title</label>
        <input type="text" id="assignmentTitle" placeholder="Assignment Title" value="${isEdit ? escapeHtml(assignment.title) : ''}" required>

        <label>Course</label>
        <select id="assignmentCourseId" required>
          <option value="">Select Course</option>
          ${courses.map(c => `<option value="${c.id}" ${((isEdit ? assignment.course_id : courseId) === c.id) ? 'selected' : ''}>${escapeHtml(c.title)}</option>`).join('')}
        </select>

        <label>Description</label>
        <textarea id="assignmentDescription" placeholder="Description" rows="4">${isEdit ? escapeHtml(assignment.description) : ''}</textarea>

        <div class="grid-2">
          <div>
            <label>Release Date</label>
            <input type="datetime-local" id="assignmentStartAt" value="${isEdit && assignment.start_at ? new Date(assignment.start_at).toISOString().slice(0, 16) : ''}">
          </div>
          <div>
            <label>Due Date</label>
            <input type="datetime-local" id="assignmentDueDate" value="${isEdit && assignment.due_date ? new Date(assignment.due_date).toISOString().slice(0, 16) : ''}" required>
          </div>
        </div>

        <div class="grid-3 mt-10">
          <div><label class="small">Max Points:</label><input type="number" id="assignmentPoints" value="${isEdit ? assignment.points_possible : 0}" readonly style="background:#f0f0f0"></div>
          <div><label class="small">Late Penalty/Day (%):</label><input type="number" id="assignmentLatePenalty" value="${isEdit ? assignment.late_penalty_per_day : 0}"></div>
          <div>
            <label class="small">Allow Late?</label>
            <select id="assignmentAllowLate">
              <option value="true" ${isEdit && assignment.allow_late_submissions ? 'selected' : ''}>Yes</option>
              <option value="false" ${isEdit && !assignment.allow_late_submissions ? 'selected' : ''}>No</option>
            </select>
          </div>
        </div>
        <div class="mt-10">
          <label>Global Allowed Extensions (for file questions):</label>
          <input type="text" id="allowedExtensions" placeholder=".pdf, .docx, .zip, .jpg" value="${isEdit ? (assignment.allowed_extensions || []).join(', ') : '.pdf, .docx, .zip, .jpg'}">
        </div>
        <label>Status</label>
        <select id="assignmentStatus">
          <option value="draft" ${isEdit && assignment.status === 'draft' ? 'selected' : ''}>Draft</option>
          <option value="published" ${isEdit && assignment.status === 'published' ? 'selected' : ''}>Published</option>
        </select>

        <div class="mt-20">
          <button type="button" class="button secondary w-auto small" onclick="openAntiCheatModal('assignment')">🛡️ Configure Anti-Cheat</button>
          <div id="ac-preview" class="small mt-10 text-muted"></div>
          <input type="hidden" id="antiCheatConfigData" value='${JSON.stringify(assignment?.anti_cheat_config || {})}'>
        </div>
        <div class="mt-20">
          <h3 class="m-0">Supporting Materials (Attachments)</h3>
          <p class="small text-muted mt-5">Upload files or add links that students can use for this assignment.</p>
          <div id="attachmentsContainer" class="mt-10">
            ${isEdit && assignment.attachments ? assignment.attachments.map((att, idx) => `
                <div class="flex-between list-item mb-5" data-idx="${idx}">
                    <span class="small">${escapeHtml(att.name || att.url)}</span>
                    <button type="button" class="button danger tiny w-auto" onclick="this.parentElement.remove()">Remove</button>
                    <input type="hidden" class="att-data" value='${JSON.stringify(att)}'>
                </div>
            `).join('') : ''}
          </div>
          <div id="assignAttachmentUploader" class="mt-10"></div>
          <div class="flex gap-10 mt-10">
              <input type="text" id="attLinkLabel" placeholder="Link Label" class="small m-0" style="width:150px">
              <input type="url" id="attLinkUrl" placeholder="https://..." class="small m-0">
              <button type="button" class="button secondary small w-auto" onclick="addAssignmentLink()">Add Link</button>
          </div>
        </div>

        <div class="mt-20">
          <h3 class="m-0">Questions</h3>
          <div id="questionsContainer" class="mt-15"></div>
          <button type="button" class="button w-auto secondary small" onclick="addQuestionField()">+ Add Question</button>
        </div>
        <div class="flex gap-10 mt-30">
          <button type="submit" class="button w-auto px-40">${isEdit ? 'Update Assignment' : 'Create Assignment'}</button>
          <button type="button" class="button secondary w-auto px-40" onclick="${finalCourseId ? `editCourse('${finalCourseId}')` : 'renderAssignments()'}">Cancel</button>
        </div>
      </form>
    </div>
  `;
  UI.createRTE('assignmentDescription');
  if (isEdit && assignment.questions) { assignment.questions.forEach(q => addQuestionField(q)); }
  updateACPreview();

  UI.createFileUploader('assignAttachmentUploader', {
      bucket: 'assignments',
      pathPrefix: 'templates',
      onUploadSuccess: (url, name) => {
          const container = document.getElementById('attachmentsContainer');
          const div = document.createElement('div');
          div.className = 'flex-between list-item mb-5';
          div.innerHTML = `
            <span class="small">${escapeHtml(name)}</span>
            <button type="button" class="button danger tiny w-auto" onclick="this.parentElement.remove()">Remove</button>
            <input type="hidden" class="att-data" value='${JSON.stringify({ name, url, type: 'file' })}'>
          `;
          container.appendChild(div);
      }
  });

  const addAssignmentLink = () => {
      const label = document.getElementById('attLinkLabel').value.trim();
      const url = document.getElementById('attLinkUrl').value.trim();
      if (!url) return UI.showNotification('URL required', 'warn');
      if (!isValidUrl(url)) return UI.showNotification('Please enter a valid URL (starting with http:// or https://)', 'error');

      const container = document.getElementById('attachmentsContainer');
      const div = document.createElement('div');
      div.className = 'flex-between list-item mb-5';
      div.innerHTML = `
        <span class="small">${escapeHtml(label || url)}</span>
        <button type="button" class="button danger tiny w-auto" onclick="this.parentElement.remove()">Remove</button>
        <input type="hidden" class="att-data" value='${JSON.stringify({ name: label || url, url, type: 'link' })}'>
      `;
      container.appendChild(div);
      document.getElementById('attLinkLabel').value = '';
      document.getElementById('attLinkUrl').value = '';
  };
  document.getElementById('assignmentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Saving...';

    try {
      const user = await SessionManager.getCurrentUser();
      const questions = [];
      let questionError = null;
      document.querySelectorAll('#questionsContainer .question').forEach((item, idx) => {
        const selectedTypes = Array.from(item.querySelectorAll('.q-type-checkbox:checked')).map(cb => cb.value);
        if (selectedTypes.length === 0) {
            questionError = `Question ${idx + 1} must have at least one submission type selected.`;
        }

        const q = {
          text: item.querySelector('.q-text').value,
          types: selectedTypes,
          points: parseInt(item.querySelector('.q-points').value) || 0
        };
        const extInput = item.querySelector('.q-ext');
        if (extInput) q.extensions = extInput.value;
        questions.push(q);
      });

      if (questionError) {
          UI.showNotification(questionError, 'warn');
          btn.disabled = false;
          btn.textContent = originalText;
          return;
      }
      const allowedExt = document.getElementById('allowedExtensions').value.split(',').map(e => e.trim().toLowerCase()).filter(e => e);
      const selCourseId = document.getElementById('assignmentCourseId').value;
      const acConfig = JSON.parse(document.getElementById('antiCheatConfigData').value || '{}');

      const attachments = [];
      document.querySelectorAll('#attachmentsContainer .att-data').forEach(input => {
          try { attachments.push(JSON.parse(input.value)); } catch(e) {}
      });

      const pointsPossible = parseInt(document.getElementById('assignmentPoints').value) || 100;
      const totalQuestionPoints = questions.reduce((sum, q) => sum + (q.points || 0), 0);

      if (questions.length > 0 && pointsPossible !== totalQuestionPoints) {
          UI.showNotification(`Warning: Total points possible (${pointsPossible}) does not match the sum of question points (${totalQuestionPoints}). Please adjust your questions.`, 'warn');
          // We allow saving but warn the teacher. Or we could block it.
          // Requirement 2 says: "add validation to ensure the sum of question points equals points_possible before saving"
          // Let's enforce it for better integrity.
          btn.disabled = false;
          btn.textContent = originalText;
          return;
      }

      const assignmentData = {
        ...assignment,
        id: isEdit ? assignment.id : crypto.randomUUID(),
        course_id: selCourseId,
        title: document.getElementById('assignmentTitle').value,
        description: document.getElementById('assignmentDescription').value,
        start_at: document.getElementById('assignmentStartAt').value ? new Date(document.getElementById('assignmentStartAt').value).toISOString() : null,
        due_date: new Date(document.getElementById('assignmentDueDate').value).toISOString(),
        points_possible: pointsPossible,
        late_penalty_per_day: parseInt(document.getElementById('assignmentLatePenalty').value) || 0,
        allow_late_submissions: document.getElementById('assignmentAllowLate').value === 'true',
        status: document.getElementById('assignmentStatus').value,
        anti_cheat_config: acConfig,
        teacher_email: user.email,
        questions: questions,
        allowed_extensions: allowedExt,
        attachments: attachments
      };
      const result = await SupabaseDB.saveAssignment(assignmentData);
      if (result) {
        UI.showNotification('Assignment saved successfully', 'success');
        if (selCourseId && !assignment) editCourse(selCourseId);
        else renderAssignments();
      }
    } catch (err) {
      UI.showNotification('Error saving assignment: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}
async function editAssignment(id) {
  const renderId = window.currentRenderId;
  const user = await SessionManager.getCurrentUser();
  if (renderId !== window.currentRenderId) return;
  const { data: assignments } = await SupabaseDB.getAssignments(user.email, null, null);
  if (renderId !== window.currentRenderId) return;
  const assignment = assignments.find(a => a.id === id);
  if (assignment) showAssignmentForm(assignment);
}
async function deleteAssignmentById(id, courseId = null) {
  if (await UI.confirm('Are you sure you want to delete this assignment?', 'Delete Assignment')) {
    try {
      await SupabaseDB.deleteAssignment(id);
      UI.showNotification('Assignment deleted', 'success');
      if (courseId) editCourse(courseId); else renderAssignments();
    } catch (e) {
      UI.showNotification('Error deleting assignment: ' + e.message, 'error');
    }
  }
}
async function gradeSubmission(assignmentId, studentEmail) {
  const renderId = window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;

  try {
    const [assignment, submission] = await Promise.all([
        SupabaseDB.getAssignment(assignmentId),
        SupabaseDB.getSubmission(assignmentId, studentEmail)
    ]);
    if (renderId !== window.currentRenderId) return;

    if (!submission) throw new Error('Submission not found.');

    // Late penalty calculation
    const dueDate = new Date(assignment.due_date);
    const subDate = new Date(submission.submitted_at);
    let lateDays = 0;
    let latePenalty = 0;
    if (subDate > dueDate) {
        // Calculate days difference, ensuring we don't count partial days as 0 if they cross a 24h boundary
        lateDays = Math.max(0, Math.floor((subDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)));
        // Cap penalty at 100%
        latePenalty = Math.min(100, Math.max(0, lateDays * (assignment.late_penalty_per_day || 0)));
    }

    const submissionAnswers = submission.answers || {};

    content.innerHTML = `
    <div class="card">
      <h2 class="m-0">Grade Submission</h2>
      <div class="flex-between mt-10">
          <p class="small"><strong>Student:</strong> ${escapeHtml(studentEmail)}</p>
          <p class="small"><strong>Max Points:</strong> ${assignment.points_possible}</p>
      </div>

      ${lateDays > 0 ? `
        <div class="card danger-border p-10 mt-10">
            <div class="bold danger-text">LATE SUBMISSION (${lateDays} days)</div>
            <div class="small">Penalty configured: ${assignment.late_penalty_per_day}% per day. Total Penalty: ${latePenalty}%</div>
        </div>
      ` : ''}

      ${submission.regrade_request ? `
        <div class="card warn-border p-10 mt-10" style="background:#fffcf0">
            <div class="bold warning-text">REGRADE REQUESTED</div>
            <div class="small mt-5"><strong>Student Note:</strong> ${escapeHtml(submission.regrade_request)}</div>
        </div>
      ` : ''}

      <form id="gradingForm">
        <div class="mt-20">
          <h4 class="m-0">Submitted Answers & Individual Scoring:</h4>
          <div class="mt-15">
            ${(assignment.questions || []).map((q, idx) => {
              const answerObj = submissionAnswers[idx];
              const isStructured = typeof answerObj === 'object' && answerObj !== null && answerObj.type;
              const type = isStructured ? answerObj.type : (typeof answerObj === 'string' && isValidUrl(answerObj) ? 'file' : 'essay');
              const value = isStructured ? answerObj.value : answerObj;

              const score = submission?.question_scores?.[idx] ?? (submission?.status === 'graded' ? 0 : null);

              let displayAnswer = '<div class="small p-10 mt-5 text-muted italic">No answer provided.</div>';
              if (value) {
                  if (type === 'essay') {
                      displayAnswer = `<div class="small p-10 mt-5" style="background: #f7fafc; border-radius: 4px;">${UI.renderRichText(value)}</div>`;
                  } else {
                      displayAnswer = `<div class="mt-5 flex gap-10">
                        <span class="badge badge-purple tiny">${type.toUpperCase()}</span>
                        <button type="button" class="button secondary small w-auto" onclick="UI.viewFile('${escapeAttr(value)}', 'Student Submission - Q${idx+1}')">View Submitted ${type === 'link' ? 'Link' : 'File'}</button>
                      </div>`;
                  }
              }

              return `<div class="list-item mb-20 card border-light">
                <div class="bold mb-5">Question ${idx + 1}: ${UI.renderRichText(q.text)}</div>
                <div class="mt-5">${displayAnswer}</div>
                <div class="mt-10 flex-center-y gap-10 p-10 bg-light border-radius-sm">
                    <label class="small m-0">Points Earned (max ${q.points}):</label>
                    <input type="number" class="q-score-input small w-auto m-0" style="width:80px" data-q-idx="${idx}" data-max="${q.points}" value="${score !== null ? score : ''}" min="0" max="${q.points}" placeholder="0">
                </div>
                <div class="mt-10">
                    <label class="small">Teacher Comment for Question ${idx + 1}:</label>
                    <textarea class="q-feedback-input small w-100 mt-5" data-q-idx="${idx}" rows="2" placeholder="Specific feedback for this answer...">${escapeHtml(submission.question_feedback?.[idx] || '')}</textarea>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>
        <div class="mt-20 grid-2">
          <div>
            <label>Raw Score (0-${assignment.points_possible}):</label>
            <input type="number" id="grade" min="0" max="${assignment.points_possible}" value="${submission.grade ?? ''}" required readonly style="background:#f0f0f0">
          </div>
          <div>
            <label>Final Adjusted Grade (%):</label>
            <input type="number" id="finalGrade" min="0" max="100" value="${submission.final_grade ?? ''}" readonly style="background:#f0f0f0">
            <p class="tiny mt-5">Auto-calculated based on penalty.</p>
          </div>
        </div>
        <div class="mt-10">
          <label>Feedback:</label>
          <textarea id="feedback" rows="4" placeholder="Enter feedback for student...">${escapeHtml(submission.feedback || '')}</textarea>
        </div>
        <div class="flex gap-10 mt-20">
          <button type="submit" class="button w-auto px-40">Submit Grade</button>
          <button type="button" class="button secondary w-auto px-40" onclick="renderGrading()">Cancel</button>
        </div>
      </form>
    </div>
  `;
  UI.createRTE('feedback');
  const rawInput = document.getElementById('grade');
  const finalInput = document.getElementById('finalGrade');

  const updateRawFromQuestions = () => {
      const total = Array.from(document.querySelectorAll('.q-score-input'))
          .reduce((sum, input) => sum + (parseInt(input.value) || 0), 0);
      rawInput.value = total;
      updateFinal();
  };

  const updateFinal = () => {
      const raw = parseInt(rawInput.value) || 0;
      const percent = assignment.points_possible > 0 ? (raw / assignment.points_possible) * 100 : 0;
      const final = Math.max(0, percent - latePenalty);
      finalInput.value = Math.round(final);
  };

  document.querySelectorAll('.q-score-input').forEach(input => {
      input.addEventListener('input', updateRawFromQuestions);
      input.addEventListener('change', updateRawFromQuestions);
      input.addEventListener('keyup', updateRawFromQuestions);
  });
  rawInput.addEventListener('input', updateFinal);

  // Force an initial update
  updateRawFromQuestions();

  document.getElementById('gradingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      const questionScores = {};
      document.querySelectorAll('.q-score-input').forEach(input => {
          questionScores[input.dataset.qIdx] = parseInt(input.value) || 0;
      });

      const questionFeedback = {};
      document.querySelectorAll('.q-feedback-input').forEach(input => {
          questionFeedback[input.dataset.qIdx] = input.value;
      });

      const updatedSubmission = {
        ...submission,
        grade: parseInt(rawInput.value) || 0,
        final_grade: parseInt(finalInput.value) || 0,
        question_scores: questionScores,
        question_feedback: questionFeedback,
        late_penalty_applied: latePenalty,
        feedback: document.getElementById('feedback').value,
        status: 'graded',
        graded_at: new Date().toISOString(),
        regrade_request: null // Clear regrade request once graded
      };
      if (await SupabaseDB.saveSubmission(updatedSubmission)) {
        UI.showNotification('Submission graded successfully', 'success');
        renderGrading();
      }
    } catch (e) {
      UI.showNotification('Error saving grade: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit Grade';
    }
  });
  } catch (error) {
    console.error('Grade error:', error);
    content.innerHTML = `<div class="card" style="border-left: 4px solid var(--danger)">
      <h3>Error Loading Submission</h3>
      <div class="small" style="color:var(--danger)">${escapeHtml(error.message)}</div>
      <button class="button" onclick="renderGrading()" style="margin-top:10px; width:auto">Back to Queue</button>
    </div>`;
  }
}
async function renderDiscussions() {
  const renderId = ++window.currentRenderId;
  const container = document.getElementById('pageContent');
  if (!container) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const { data: courses } = await SupabaseDB.getCourses(user.email, null);
    if (renderId !== window.currentRenderId) return;

    UI.renderCourseList('pageContent', courses || [], {
        title: 'Discussions',
        subtitle: 'Manage discussions for your courses.',
        buttonText: 'View Discussions',
        onButtonClick: (id) => viewCourseDiscussions(id),
        emptyMessage: 'No courses found.'
    });
  } catch (error) {
    console.error('Discussions error:', error);
    UI.showNotification('Error loading discussions: ' + error.message, 'error');
    container.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Discussions</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderDiscussions()">Retry</button>
    </div>`;
  }
}

async function viewCourseDiscussions(courseId) {
  const renderId = ++window.currentRenderId;
  const container = document.getElementById('pageContent');
  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const { data: disc } = await SupabaseDB.getDiscussions(courseId);
    if (renderId !== window.currentRenderId) return;
    if (!container) return;

    container.innerHTML = `<button class="button secondary w-auto mb-10" onclick="renderDiscussions()">← Back</button><div id="discussionArea"></div>`;

    UI.renderDiscussion('discussionArea', disc, user.email, {
        onPost: async (content, parentId) => {
            if (await DiscussionManager.post(courseId, content, parentId)) viewCourseDiscussions(courseId);
        },
        onEdit: (id) => DiscussionManager.edit(id, async (id, content) => {
            const { data: disc } = await SupabaseDB.getDiscussions(courseId);
            const existing = disc.find(d => d.id === id);
            await SupabaseDB.saveDiscussion({ ...existing, content });
            viewCourseDiscussions(courseId);
            return true;
        }),
        onDelete: (id) => DiscussionManager.delete(id, () => viewCourseDiscussions(courseId))
    });
  } catch (e) {
    console.error('Discussions error:', e);
    UI.showNotification('Error loading discussions: ' + e.message, 'error');
    if (container) {
        container.innerHTML = `<div class="card danger-border">
            <h3>Error Loading Discussions</h3>
            <div class="small danger-text">${escapeHtml(e.message)}</div>
            <button class="button w-auto mt-10" onclick="viewCourseDiscussions('${escapeAttr(courseId)}')">Retry</button>
        </div>`;
    }
  }
}

async function renderHelp() {
  const renderId = ++window.currentRenderId;
  clearActiveCountdowns();
  UI.renderHelp('pageContent', 'teacher');
}

async function renderAntiCheat() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const { data: summary } = await SupabaseDB.getViolationSummary(user.email);
    if (renderId !== window.currentRenderId) return;

    UI.renderAntiCheatSummary('pageContent', summary, {
        title: 'Security Monitoring',
        onViewDetails: (id, title) => viewAssessmentViolations(id, title),
        onRefresh: () => renderAntiCheat()
    });
  } catch (error) {
    console.error('AntiCheat error:', error);
    UI.showNotification('Error loading security summary: ' + error.message, 'error');
    content.innerHTML = `<div class="card danger-border">
      <h3>Error Loading Summary</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderAntiCheat()">Retry</button>
    </div>`;
  }
}

async function viewAssessmentViolations(assessmentId, title) {
    const renderId = window.currentRenderId;
    const area = document.getElementById('violationDetailArea');
    if (!area) return;
    area.innerHTML = `<div class="loading-spinner"></div>`;
    area.scrollIntoView({ behavior: 'smooth' });

    try {
        const { data: violations } = await SupabaseDB.getViolations(assessmentId, null, null);
        if (renderId !== window.currentRenderId) return;

        // Group by student
        const studentMap = {};
        violations.forEach(v => {
            if (!studentMap[v.user_email]) {
                studentMap[v.user_email] = {
                    email: v.user_email,
                    violations: [],
                    score: 0,
                    critical: 0
                };
            }
            studentMap[v.user_email].violations.push(v);
            studentMap[v.user_email].score += (v.score || 0);
            if (v.severity === 'CRITICAL') studentMap[v.user_email].critical++;
        });

        const students = Object.values(studentMap).sort((a,b) => b.score - a.score);

        area.innerHTML = `
            <div class="card">
                <div class="flex-between mb-20">
                    <h3 class="m-0">Assessment: ${escapeHtml(title)}</h3>
                    <button class="button secondary tiny w-auto" onclick="document.getElementById('violationDetailArea').innerHTML=''">Close Details</button>
                </div>

                <div class="p-0" style="overflow-x:auto">
                    <table>
                        <thead>
                            <tr>
                                <th>Student Email</th>
                                <th>Violations</th>
                                <th>Total Score</th>
                                <th>Severity</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${students.map(s => {
                                const severity = s.critical > 0 ? 'Critical' : (s.score >= 10 ? 'High' : 'Low');
                                return `
                                <tr>
                                    <td><strong class="small">${escapeHtml(s.email)}</strong></td>
                                    <td>${s.violations.length}</td>
                                    <td><span class="bold">${s.score}</span></td>
                                    <td>
                                        <span class="badge ${severity === 'Critical' ? 'badge-inactive' : (severity === 'High' ? 'badge-warn' : 'badge-active')}">
                                            ${severity}
                                        </span>
                                    </td>
                                    <td>
                                        <div class="flex gap-5">
                                            <button class="button tiny w-auto" onclick="viewStudentIntegrityReport('${assessmentId}', '${escapeAttr(s.email)}')">View Report</button>
                                            <button class="button danger tiny w-auto" onclick="clearStudentViolations('${assessmentId}', '${escapeAttr(s.email)}', '${escapeAttr(title)}')">Clear History</button>
                                        </div>
                                    </td>
                                </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
            <div id="integrityReportModalArea"></div>
        `;

    } catch (e) {
        console.error('Violation detail error:', e);
        UI.showNotification('Error loading violation details: ' + e.message, 'error');
        area.innerHTML = `<div class="card danger-border">
            <h3>Error Loading Details</h3>
            <div class="small danger-text">${escapeHtml(e.message)}</div>
            <button class="button w-auto mt-10" onclick="viewAssessmentViolations('${escapeAttr(assessmentId)}', '${escapeAttr(title)}')">Retry</button>
        </div>`;
    }
}

async function viewStudentIntegrityReport(assessmentId, studentEmail) {
    const renderId = window.currentRenderId;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.display = 'flex';
    backdrop.innerHTML = `
        <div class="modal" style="max-width: 900px">
            <div class="flex-between mb-20">
                <h3 class="m-0">Integrity Report: ${escapeHtml(studentEmail)}</h3>
                <button class="button secondary tiny w-auto" onclick="this.closest('.modal-backdrop').remove()">✕</button>
            </div>
            <div id="reportContentArea"></div>
        </div>
    `;
    document.body.appendChild(backdrop);

    try {
        const { data: violations } = await SupabaseDB.getViolations(assessmentId, studentEmail, null);
        if (renderId !== window.currentRenderId) return;
        UI.renderIntegrityReport('reportContentArea', violations, studentEmail);
    } catch (e) {
        console.error('Integrity report error:', e);
        UI.showNotification('Error loading integrity report: ' + e.message, 'error');
        document.getElementById('reportContentArea').innerHTML = `<div class="empty danger-text">Failed to load report: ${escapeHtml(e.message)}</div>`;
    }
}

async function clearStudentViolations(assessmentId, studentEmail, title) {
    if (await UI.confirm(`Are you sure you want to clear all violation history for ${studentEmail} on this assessment? This action is irreversible.`, 'Clear Integrity Record')) {
        try {
            await SupabaseDB.deleteViolations(assessmentId, studentEmail);
            UI.showNotification('Integrity record cleared.', 'success');
            viewAssessmentViolations(assessmentId, title);
        } catch (e) {
            UI.showNotification('Failed to clear record: ' + e.message, 'error');
        }
    }
}

function openAntiCheatModal(type) {
    const input = document.getElementById('antiCheatConfigData');
    const currentConfig = JSON.parse(input.value || '{}');

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.display = 'flex';

    const flags = [
        { key: 'BLOCK_COPY', label: 'Block Copy', desc: 'Prevents students from copying text from the assessment.', category: 'Interaction' },
        { key: 'BLOCK_PASTE', label: 'Block Paste', desc: 'Prevents students from pasting text into the assessment.', category: 'Interaction' },
        { key: 'BLOCK_CUT', label: 'Block Cut', desc: 'Prevents students from cutting text.', category: 'Interaction' },
        { key: 'BLOCK_CONTEXT_MENU', label: 'Block Right-Click', desc: 'Disables the right-click context menu.', category: 'Interaction' },
        { key: 'BLOCK_KEYBOARD_SHORTCUTS', label: 'Block Shortcuts', desc: 'Blocks common shortcuts like Ctrl+C, Ctrl+V, Ctrl+U, F12.', category: 'Interaction' },
        { key: 'BLOCK_DRAG', label: 'Block Drag & Drop', desc: 'Prevents dragging items into or out of the assessment.', category: 'Interaction' },

        { key: 'BLOCK_TAB_SWITCH', label: 'Block Tab Switching', desc: 'Logs a violation if the student switches tabs or windows.', category: 'Environment' },
        { key: 'BLOCK_DEVTOOLS', label: 'Block DevTools', desc: 'Attempts to detect and block browser developer tools.', category: 'Environment' },
        { key: 'FULLSCREEN_REQUIRED', label: 'Require Fullscreen', desc: 'Forces the assessment to stay in fullscreen mode.', category: 'Environment' },
        { key: 'MULTI_TAB_LOCK', label: 'Multi-Tab Lock', desc: 'Prevents the assessment from being opened in multiple tabs.', category: 'Environment' },

        { key: 'BLOCK_LONG_PRESS', label: 'Block Long Press', desc: 'Prevents long-press actions on touch devices.', category: 'Input' },
        { key: 'BLOCK_TEXT_SELECTION', label: 'Block Text Selection', desc: 'Disables the ability to highlight/select text.', category: 'Input' }
    ];

    const categories = ['Interaction', 'Environment', 'Input'];

    backdrop.innerHTML = `
        <div class="modal" style="max-width: 800px">
            <div class="flex-between mb-20">
                <div class="flex-center-y gap-10">
                    <span style="font-size: 24px">🛡️</span>
                    <h3 class="m-0">Anti-Cheat Configuration</h3>
                </div>
                <button class="button secondary tiny w-auto" onclick="this.closest('.modal-backdrop').remove()">✕</button>
            </div>

            <p class="small mb-20">Enhance the integrity of your ${type} by enabling advanced security measures. All violations are logged with detailed session data.</p>

            <div class="ac-modal-content" style="max-height: 60vh; overflow-y: auto; padding-right: 10px;">
                ${categories.map(cat => `
                    <div class="mb-30">
                        <h4 class="mb-15" style="border-bottom: 2px solid var(--purple-light); padding-bottom: 8px; color: var(--purple); display: flex; align-items: center; gap: 8px">
                            ${cat === 'Interaction' ? '🖱️' : cat === 'Environment' ? '🌐' : '⌨️'} ${cat} Control
                        </h4>
                        <div class="grid-2">
                            ${flags.filter(f => f.category === cat).map(f => {
                                const isActive = currentConfig[f.key] === true;
                                return `
                                <div class="ac-feature-card ${isActive ? 'active' : ''}" onclick="const cb=this.querySelector('input'); cb.checked=!cb.checked; this.classList.toggle('active', cb.checked)">
                                    <label class="ac-switch" onclick="event.stopPropagation()">
                                        <input type="checkbox" class="ac-modal-flag" data-flag="${f.key}" ${isActive ? 'checked' : ''} onchange="this.closest('.ac-feature-card').classList.toggle('active', this.checked)">
                                        <span class="ac-slider"></span>
                                    </label>
                                    <div style="flex: 1">
                                        <div class="bold small">${f.label}</div>
                                        <div class="tiny text-muted mt-4" style="line-height: 1.3">${f.desc}</div>
                                    </div>
                                </div>
                            `}).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>

            <div class="flex-between mt-30 pt-20" style="border-top: 1px solid var(--border)">
                <div class="tiny text-muted">Select flags to apply to this assessment.</div>
                <div class="flex gap-10">
                    <button class="button w-auto px-40" id="saveACBtn">Apply Settings</button>
                    <button class="button secondary w-auto px-40" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(backdrop);

    document.getElementById('saveACBtn').onclick = () => {
        const newConfig = {};
        backdrop.querySelectorAll('.ac-modal-flag').forEach(cb => {
            newConfig[cb.dataset.flag] = cb.checked;
        });
        input.value = JSON.stringify(newConfig);
        updateACPreview();
        backdrop.remove();
        UI.showNotification('Anti-cheat configuration updated locally. Save the assessment to persist changes.', 'info');
    };
}

function updateACPreview() {
    const input = document.getElementById('antiCheatConfigData');
    const preview = document.getElementById('ac-preview');
    if (!input || !preview) return;

    try {
        const config = JSON.parse(input.value || '{}');
        const active = Object.entries(config).filter(([k, v]) => v === true).map(([k, v]) => k.replace('BLOCK_', '').replace(/_/g, ' '));

        if (active.length === 0) {
            preview.textContent = 'No anti-cheat measures active.';
        } else {
            preview.innerHTML = `<strong>Active:</strong> ${active.join(', ')}`;
        }
    } catch (e) {
        preview.textContent = '';
    }
}

async function renderSettings() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  try {
    if (renderId !== window.currentRenderId) return;
    SettingsManager.render('Enable real-time desktop notifications for student submissions and system alerts.');
  } catch (error) {
    console.error('Settings error:', error);
    UI.showNotification('Error loading settings: ' + error.message, 'error');
    if (content) {
        content.innerHTML = `<div class="card danger-border">
          <h3>Error Loading Settings</h3>
          <div class="small danger-text">${escapeHtml(error.message)}</div>
          <button class="button w-auto mt-10" onclick="renderSettings()">Retry</button>
        </div>`;
    }
  }
}

async function renderLiveClasses() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const now = TimerManager.getTime();
    const [{ data: liveClasses }, { data: courses }] = await Promise.all([
      SupabaseDB.getLiveClasses(null, user.email, null),
      SupabaseDB.getCourses(user.email, null)
    ]);
    if (renderId !== window.currentRenderId) return;

    const activeClass = liveClasses.find(liveClass => liveClass.status === 'live');

    content.innerHTML = `
      <div class="card flex-between">
        <h2 class="m-0">Live Classes</h2>
        <div class="flex gap-10">
            ${activeClass ? `<button id="globalStopBtn" class="button danger w-auto" onclick="stopLiveClass('${activeClass.id}')">Stop Active Session</button>` : ''}
            <button class="button w-auto" onclick="showLiveClassForm()">+ Schedule Class</button>
        </div>
      </div>

      <div id="mod-controls" class="card hidden mt-20">
        <h3>Moderation Controls</h3>
        <div class="flex gap-10">
          <button class="button w-auto small" onclick="teacherModAction('muteAll')">Mute All</button>
          <button class="button w-auto small" onclick="teacherModAction('toggleLobby')">Toggle Lobby</button>
          <button class="button w-auto small" onclick="teacherModAction('stopVideoAll')">Restrict Video</button>
        </div>
      </div>

      <div class="grid mt-20">
        ${liveClasses.map(liveClass => {
          const course = courses.find(c => c.id === liveClass.course_id);
          const isLive = liveClass.status === 'live';
          const startAt = new Date(liveClass.start_at).getTime();
          const endAt = new Date(liveClass.end_at).getTime();
          const now = TimerManager.getTime();
          const isUpcoming = startAt > now;

          return `
            <div class="card">
              <div class="flex-between" style="align-items:start">
                <div>
                  <h3 class="m-0">${escapeHtml(liveClass.title)}</h3>
                  <p class="small"><strong>Course:</strong> ${escapeHtml(course?.title || 'Unknown')}</p>
                  <p class="small"><strong>Time:</strong> ${new Date(liveClass.start_at).toLocaleString()} - ${new Date(liveClass.end_at).toLocaleTimeString()}</p>
                </div>
                <span class="badge ${isLive ? 'badge-active' : ''}">${liveClass.status.toUpperCase()}</span>
              </div>
              <div class="mt-10 mb-10 p-10 border-radius-sm" style="background:var(--bg)">
                  ${isUpcoming ? `
                    <div class="live-sch-countdown" data-target="${startAt}" data-start="${liveClass.created_at ? new Date(liveClass.created_at).getTime() : now}" data-label="Starts In:" data-status="${liveClass.status === 'cancelled' ? 'draft' : 'published'}"></div>
                  ` : isLive ? `
                    <div class="live-sch-countdown" data-target="${endAt}" data-reference="${startAt}" data-label="Ends In:" data-status="${liveClass.status === 'cancelled' ? 'draft' : 'published'}"></div>
                  ` : `
                    <div class="tiny text-muted">Session Finished</div>
                    ${liveClass.recording_url ? `<div class="mt-5"><a href="${escapeAttr(liveClass.recording_url)}" target="_blank" class="button secondary tiny w-auto">View Recording</a></div>` : ''}
                  `}
              </div>
              <div class="flex gap-10 mt-15">
                <button class="button w-auto small" onclick="handleStartLiveClass('${liveClass.id}', '${liveClass.room_name}', '${escapeAttr(liveClass.meeting_url || '')}')">
                  ${isLive ? 'Join Class' : 'Start Class'}
                </button>
                <button class="button secondary w-auto small" onclick="loadAndEditLiveClass('${liveClass.id}')">Edit</button>
                <button class="button secondary w-auto small" onclick="viewAttendance('${liveClass.id}')">Attendance</button>
                <button class="button danger w-auto small" onclick="deleteLiveClass('${liveClass.id}')">Cancel</button>
              </div>
            </div>
          `;
        }).join('') || '<div class="empty">No live classes scheduled.</div>'}
      </div>
      <div id="liveFormArea" class="hidden mt-20"></div>
      <div id="jitsi-container" class="hidden mt-20" style="height:600px; border:1px solid var(--border); border-radius:8px; overflow:hidden"></div>
    `;

    Countdown.createAll('.live-sch-countdown', {
        showProgress: true,
        onEnd: () => renderLiveClasses()
    }).forEach(c => TeacherState.activeCountdowns.push(c));

  } catch (error) {
    console.error('Live Classes error:', error);
    UI.showNotification('Error loading live classes: ' + error.message, 'error');
    content.innerHTML = `<div class="card danger-border">
      <h3>Error Loading Live Classes</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderLiveClasses()">Retry</button>
    </div>`;
  }
}

async function loadAndEditLiveClass(id) {
  const renderId = window.currentRenderId;
  try {
    const liveClass = await SupabaseDB.getLiveClass(id);
    if (renderId !== window.currentRenderId) return;
    if (liveClass) showLiveClassForm(liveClass);
  } catch (e) {
    UI.showNotification('Error loading live class: ' + e.message, 'error');
  }
}

async function showLiveClassForm(liveClass = null) {
  const renderId = window.currentRenderId;
  const isEdit = !!liveClass;
  const area = document.getElementById('liveFormArea');
  if (!area) return;
  area.classList.remove('hidden');
  area.scrollIntoView({ behavior: 'smooth' });

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const [{ data: courses }, liveRes] = await Promise.all([
        SupabaseDB.getCourses(user.email, null),
        SupabaseDB.getLiveClasses(null, user.email, null)
    ]);
    if (renderId !== window.currentRenderId) return;
    const allLiveClasses = liveRes.data || [];

    area.innerHTML = `
      <div class="card">
        <h3 class="m-0">${isEdit ? 'Edit Live Class' : 'Schedule Live Class'}</h3>
        <form id="liveClassForm" class="mt-20">
          <label>Title</label>
          <input type="text" id="liveClassTitle" placeholder="e.g. Week 1 Live Session" value="${isEdit ? escapeHtml(liveClass.title) : ''}" required>
          <label>Course</label>
          <select id="liveClassCourseId">
            ${courses.map(c => `<option value="${c.id}" ${isEdit && liveClass.course_id === c.id ? 'selected' : ''}>${escapeHtml(c.title)}</option>`).join('')}
          </select>
          <div class="grid-2 mt-10">
            <div><label class="small">Start At</label><input type="datetime-local" id="liveClassStart" value="${isEdit ? new Date(liveClass.start_at).toISOString().slice(0, 16) : ''}" required></div>
            <div><label class="small">End At</label><input type="datetime-local" id="liveClassEnd" value="${isEdit ? new Date(liveClass.end_at).toISOString().slice(0, 16) : ''}" required></div>
          </div>
          <div class="grid-2 mt-10">
            <div>
              <label class="small">Recurring Pattern</label>
              <select id="liveClassRecurring">
                  <option value="none" ${isEdit && liveClass.recurring_config?.pattern === 'none' ? 'selected' : ''}>None</option>
                  <option value="daily" ${isEdit && liveClass.recurring_config?.pattern === 'daily' ? 'selected' : ''}>Daily</option>
                  <option value="weekly" ${isEdit && liveClass.recurring_config?.pattern === 'weekly' ? 'selected' : ''}>Weekly</option>
                  <option value="monthly" ${isEdit && liveClass.recurring_config?.pattern === 'monthly' ? 'selected' : ''}>Monthly</option>
              </select>
            </div>
            <div>
              <label class="small">Custom Meeting URL (optional)</label>
              <input type="url" id="liveClassMeetingUrl" placeholder="https://..." value="${isEdit ? escapeHtml(liveClass.meeting_url || '') : ''}">
              <div id="urlHintArea"></div>
            </div>
          </div>
          <div class="mt-10">
            <label class="small">Recording URL (Post-session)</label>
            <input type="url" id="liveClassRecordingUrl" placeholder="https://..." value="${isEdit ? escapeHtml(liveClass.recording_url || '') : ''}">
          </div>
          <div class="flex gap-10 mt-15">
            <button type="submit" class="button w-auto px-40">${isEdit ? 'Update Class' : 'Schedule Class'}</button>
            <button type="button" class="button secondary w-auto px-40" onclick="document.getElementById('liveFormArea').classList.add('hidden')">Cancel</button>
          </div>
        </form>
      </div>
    `;
    const courseSelect = document.getElementById('liveClassCourseId');
    const urlInput = document.getElementById('liveClassMeetingUrl');
    const recurringSelect = document.getElementById('liveClassRecurring');

    const updateUrlHint = () => {
        const courseId = courseSelect.value;
        const pattern = recurringSelect.value;
        if (courseId && !urlInput.value) {
            const course = courses.find(c => c.id === courseId);
            const savedUrl = course?.metadata?.last_live_url;
            if (savedUrl) {
                document.getElementById('urlHintArea').innerHTML = `<p class="tiny success-text mt-5" style="cursor:pointer" onclick="document.getElementById('liveClassMeetingUrl').value='${escapeAttr(savedUrl)}'">💡 Use saved URL for this course</p>`;
            } else {
                const prev = allLiveClasses.find(x => x.course_id === courseId && x.meeting_url);
                if (prev) {
                    document.getElementById('urlHintArea').innerHTML = `<p class="tiny success-text mt-5" style="cursor:pointer" onclick="document.getElementById('liveClassMeetingUrl').value='${escapeAttr(prev.meeting_url)}'">💡 Use previous URL for this course</p>`;
                } else {
                    document.getElementById('urlHintArea').innerHTML = '';
                }
            }
        } else {
            document.getElementById('urlHintArea').innerHTML = '';
        }
    };

    courseSelect.addEventListener('change', updateUrlHint);
    recurringSelect.addEventListener('change', updateUrlHint);
    updateUrlHint();

    document.getElementById('liveClassForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const user = await SessionManager.getCurrentUser();
      const selCourseId = document.getElementById('liveClassCourseId').value;
      const selPattern = document.getElementById('liveClassRecurring').value;
      const selUrl = document.getElementById('liveClassMeetingUrl').value;
      const selRecUrl = document.getElementById('liveClassRecordingUrl').value;

      if (selUrl && !isValidUrl(selUrl)) return UI.showNotification('Please enter a valid Meeting URL', 'error');
      if (selRecUrl && !isValidUrl(selRecUrl)) return UI.showNotification('Please enter a valid Recording URL', 'error');

      const roomName = isEdit ? liveClass.room_name : 'SmartLMS_' + Math.random().toString(36).substring(2, 12);
      const data = {
        ...liveClass,
        id: isEdit ? liveClass.id : crypto.randomUUID(),
        title: document.getElementById('liveClassTitle').value,
        course_id: selCourseId,
        teacher_email: user.email,
        start_at: new Date(document.getElementById('liveClassStart').value).toISOString(),
        end_at: new Date(document.getElementById('liveClassEnd').value).toISOString(),
        room_name: roomName,
        meeting_url: selUrl,
        recording_url: document.getElementById('liveClassRecordingUrl').value || null,
        status: isEdit ? liveClass.status : 'scheduled',
        recurring_config: {
            pattern: selPattern
        }
      };

      // Save URL to course metadata if recurring
      if (selPattern !== 'none' && selUrl) {
          const course = courses.find(c => c.id === selCourseId);
          if (course) {
              course.metadata = { ...course.metadata, last_live_url: selUrl };
              await SupabaseDB.saveCourse(course);
          }
      }

      await SupabaseDB.saveLiveClass(data);
      UI.showNotification(isEdit ? 'Class updated' : 'Class scheduled', 'success');
      renderLiveClasses();
    });
  } catch (e) {
      console.error(e);
  }
}

let jitsiAPI = null;

function startLiveClassTimer(id, endAt) {
    TeacherState._warnedEnd = false;
    const endTime = new Date(endAt).getTime();

    TeacherState.liveClassTimer = Countdown.create(null, {
        targetDate: endTime,
        referenceDate: TeacherState.liveClassTimer?.referenceDate || TimerManager.getTime(),
        headless: true,
        onEnd: async () => {
            if (await UI.confirm('Scheduled class time has reached. Do you want to extend by 15 minutes? Press Cancel to end class.', 'Class Time Reached')) {
                extendLiveClass(id, 15);
            } else {
                stopLiveClass(id);
            }
        },
        onTick: (time) => {
            if (time.total <= 5 * 60 * 1000 && !TeacherState._warnedEnd && time.total > 0) {
                TeacherState._warnedEnd = true;
                UI.showNotification('Class ends in 5 minutes', 'warn');
            }
        }
    });
}

async function handleStartLiveClass(id, roomName, meetingUrl) {
    // Hide any existing stop buttons initially to reset state
    const oldStopBtn = document.getElementById('stopClassBtn');
    if (oldStopBtn) oldStopBtn.classList.add('hidden');
    const globalStop = document.getElementById('globalStopBtn');
    if (globalStop) globalStop.classList.add('hidden');

    if (meetingUrl && meetingUrl.trim() !== '') {
        const choice = await UI.showMeetingChoice(meetingUrl);
        if (!choice) return;

        try {
            const freshLc = await SupabaseDB.getLiveClass(id);
            if (freshLc && freshLc.status !== 'live') {
                freshLc.status = 'live';
                await SupabaseDB.saveLiveClass(freshLc);
            }

            if (choice === 'tab') {
                window.open(meetingUrl, '_blank');
                renderLiveClasses();
            } else {
                // Embed in app
                const container = document.getElementById('jitsi-container');
                if (container) {
                    container.classList.remove('hidden');
                    container.scrollIntoView({ behavior: 'smooth' });
                    container.innerHTML = `<iframe src="${escapeAttr(meetingUrl)}" style="width:100%; height:600px; border:none" allow="camera; microphone; display-capture; autoplay; clipboard-write"></iframe>`;

                    let stopBtn = document.getElementById('stopClassBtn');
                    if (!stopBtn) {
                      stopBtn = document.createElement('button');
                      stopBtn.id = 'stopClassBtn';
                      stopBtn.className = 'button danger w-auto mt-10';
                      stopBtn.textContent = 'Stop Class & End Meeting';
                      stopBtn.onclick = () => stopLiveClass(id);
                      container.after(stopBtn);
                    } else {
                        stopBtn.classList.remove('hidden');
                        stopBtn.style.display = 'inline-flex';
                        stopBtn.onclick = () => stopLiveClass(id);
                    }
                } else {
                    // Fallback to new tab if container missing
                    window.open(meetingUrl, '_blank');
                    renderLiveClasses();
                }
            }
        } catch (e) {
            UI.showNotification('Error starting class: ' + e.message, 'error');
        }
    } else {
        startTeacherLiveClass(id, roomName);
    }
}

async function startTeacherLiveClass(id, roomName) {
  const user = await SessionManager.getCurrentUser();
  const container = document.getElementById('jitsi-container');
  container.classList.remove('hidden');
  container.scrollIntoView({ behavior: 'smooth' });

  // Update status to live
  const freshLc = await SupabaseDB.getLiveClass(id);
  if (freshLc && freshLc.status !== 'live') {
    freshLc.status = 'live';
    await SupabaseDB.saveLiveClass(freshLc);
  }

  const domain = "meet.jit.si";
  const options = {
    roomName: roomName,
    height: 600,
    parentNode: container,
    userInfo: {
      displayName: user.full_name,
      email: user.email
    },
    interfaceConfigOverwrite: {
      TOOLBAR_BUTTONS: [
        'microphone', 'camera', 'closedcaptions', 'desktop', 'fullscreen',
        'fodeviceselection', 'hangup', 'profile', 'chat', 'recording',
        'livestreaming', 'etherpad', 'sharedvideo', 'settings', 'raisehand',
        'videoquality', 'filmstrip', 'invite', 'feedback', 'stats', 'shortcuts',
        'tileview', 'videobackgroundblur', 'download', 'help', 'mute-everyone',
        'security'
      ],
    },
    configOverwrite: {
      startWithAudioMuted: false,
      startWithVideoMuted: false
    }
  };

  if (jitsiAPI) jitsiAPI.dispose();
  jitsiAPI = new JitsiMeetExternalAPI(domain, options);

  // Show Moderation Controls (if they exist in layout)
  const modControls = document.getElementById('mod-controls');
  if (modControls) modControls.classList.remove('hidden');

  // Add "Stop Class" button dynamically if not present
  let stopBtn = document.getElementById('stopClassBtn');
  if (!stopBtn) {
    stopBtn = document.createElement('button');
    stopBtn.id = 'stopClassBtn';
    stopBtn.className = 'button danger w-auto mt-10';
    stopBtn.textContent = 'Stop Class & End Meeting';
    stopBtn.onclick = () => stopLiveClass(id);
    // Ensure it's inserted after the container and made visible
    container.after(stopBtn);
  } else {
      stopBtn.classList.remove('hidden');
      stopBtn.style.display = 'inline-flex';
      stopBtn.onclick = () => stopLiveClass(id);
  }

  jitsiAPI.addEventListener('readyToClose', async () => {
    container.classList.add('hidden');
    if (modControls) modControls.classList.add('hidden');
    if (stopBtn) stopBtn.classList.add('hidden');
    if (TeacherState.liveClassTimer instanceof Countdown) {
        TeacherState.liveClassTimer.destroy();
        TeacherState.liveClassTimer = null;
    } else if (TeacherState.liveClassTimer) {
        clearInterval(TeacherState.liveClassTimer);
        TeacherState.liveClassTimer = null;
    }

    // Only set status back to scheduled if the teacher didn't stop the class manually
    try {
        const exitLc = await SupabaseDB.getLiveClass(id);
        if (exitLc && exitLc.status === 'live') {
            exitLc.status = 'scheduled';
            await SupabaseDB.saveLiveClass(exitLc);
            UI.showNotification('Teacher left session', 'info');
        }
    } catch (e) { console.error(e); }

    if (jitsiAPI) jitsiAPI.dispose();
    jitsiAPI = null;
    renderLiveClasses();
  });

  // End of class timer
  if (freshLc && freshLc.end_at) {
      startLiveClassTimer(id, freshLc.end_at);
  }
}

async function stopLiveClass(id) {
    if (await UI.confirm('Are you sure you want to stop the class? This will disconnect all participants.', 'Stop Class')) {
        if (TeacherState.liveClassTimer instanceof Countdown) {
            TeacherState.liveClassTimer.destroy();
            TeacherState.liveClassTimer = null;
        } else if (TeacherState.liveClassTimer) {
            clearInterval(TeacherState.liveClassTimer);
            TeacherState.liveClassTimer = null;
        }

        try {
            const liveClass = await SupabaseDB.getLiveClass(id);
            if (liveClass) {
                liveClass.status = 'completed';
                liveClass.actual_end_at = new Date().toISOString();
                await SupabaseDB.saveLiveClass(liveClass);
            }

            // Send signal to students if possible before disposing
            if (jitsiAPI) {
                jitsiAPI.executeCommand('sendChatMessage', 'Teacher has ended the class.', '', true);
                setTimeout(() => {
                    if (jitsiAPI) jitsiAPI.dispose();
                    jitsiAPI = null;
                    document.getElementById('jitsi-container').classList.add('hidden');
                    const stopBtn = document.getElementById('stopClassBtn');
                    if (stopBtn) stopBtn.classList.add('hidden');
                    UI.showNotification('Class ended successfully', 'success');
                    renderLiveClasses();
                }, 1000);
            } else {
                renderLiveClasses();
            }
        } catch (e) {
            UI.showNotification('Error stopping class: ' + e.message, 'error');
        }
    }
}

async function extendLiveClass(id, minutes) {
    try {
        const liveClass = await SupabaseDB.getLiveClass(id);
        if (liveClass) {
            const currentEnd = new Date(liveClass.end_at);
            liveClass.end_at = new Date(currentEnd.getTime() + minutes * 60000).toISOString();
            await SupabaseDB.saveLiveClass(liveClass);
            UI.showNotification(`Class extended by ${minutes} minutes`, 'success');
            renderLiveClasses();
            startLiveClassTimer(id, liveClass.end_at);
        }
    } catch (e) {
        UI.showNotification('Error extending class', 'error');
    }
}

function teacherModAction(action) {
    if (!jitsiAPI) return;
    switch(action) {
        case 'muteAll':
            jitsiAPI.executeCommand('muteEveryone');
            UI.showNotification('Muted everyone');
            break;
        case 'toggleLobby':
            jitsiAPI.executeCommand('toggleLobby', true);
            UI.showNotification('Lobby toggled');
            break;
        case 'stopVideoAll':
            // Jitsi API doesn't have a direct "stop all video" but we can suggest
            UI.showNotification('Please use Jitsi security settings for advanced moderation');
            break;
    }
}

async function deleteLiveClass(id) {
  if (await UI.confirm('Are you sure you want to cancel and delete this class?', 'Cancel Class')) {
    try {
      await SupabaseDB.deleteLiveClass(id);
      UI.showNotification('Live class deleted', 'success');
      renderLiveClasses();
    } catch (e) {
      UI.showNotification('Error deleting live class: ' + e.message, 'error');
    }
  }
}

async function viewAttendance(classId) {
  const renderId = window.currentRenderId;
  try {
    const { data: att } = await SupabaseDB.getAttendance(classId, null);
    if (renderId !== window.currentRenderId) return;

    const content = `
      <div class="modal-backdrop" onclick="this.remove()">
        <div class="modal-content" onclick="event.stopPropagation()">
          <div class="flex-between mb-20">
            <h3 class="m-0">Attendance Report</h3>
            <button class="icon-button" onclick="this.closest('.modal-backdrop').remove()">&times;</button>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Join Time</th>
                  <th>Duration</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${att.length > 0 ? att.map(a => `
                  <tr>
                    <td>${escapeHtml(a.student_email)}</td>
                    <td>${new Date(a.join_time).toLocaleString()}</td>
                    <td>${Math.floor(a.duration / 60)} mins</td>
                    <td><span class="status-badge ${a.is_present ? 'success' : 'danger'}">${a.is_present ? 'Present' : 'Absent'}</span></td>
                  </tr>
                `).join('') : '<tr><td colspan="4" class="text-center">No records found</td></tr>'}
              </tbody>
            </table>
          </div>
          <div class="mt-20 flex-end">
            <button class="button w-auto" onclick="this.closest('.modal-backdrop').remove()">Close</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', content);
  } catch (e) {
    UI.showNotification('Failed to load attendance: ' + e.message, 'error');
  }
}

async function renderQuizzes() {
  const renderId = ++window.currentRenderId;
  const container = document.getElementById('pageContent');
  if (!container) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const now = TimerManager.getTime();
    const [{ data: quizzes }, { data: courses }] = await Promise.all([
      SupabaseDB.getQuizzes(null, user.email, null),
      SupabaseDB.getCourses(user.email, null)
    ]);
    if (renderId !== window.currentRenderId) return;
    container.innerHTML = `
    <div class="card flex-between">
      <h2 class="m-0">Quizzes</h2>
      <button class="button w-auto" onclick="showQuizForm()">+ Create Quiz</button>
    </div>
    <div class="grid">
      ${quizzes.map(q => {
        const course = courses.find(c => c.id === q.course_id);
        return `
        <div class="card">
          <h3 class="m-0">${escapeHtml(q.title)}</h3>
          <p class="small"><strong>Course:</strong> ${escapeHtml(course?.title || 'None')}</p>
          <div class="small mb-5">${UI.renderRichText(q.description)}</div>
          <p class="small">Status: ${q.status}</p>
          <p class="small">Questions: ${q.questions?.length || 0}</p>
          ${q.start_at || q.end_at ? `
            <div class="mt-10 mb-10 p-10 border-radius-sm" style="background:var(--bg)">
                ${q.start_at && new Date(q.start_at).getTime() > now ? `
                    <div class="quiz-sch-countdown" data-target="${new Date(q.start_at).getTime()}" data-start="${q.created_at ? new Date(q.created_at).getTime() : now}" data-label="Starts In:" data-status="${q.status || 'published'}"></div>
                ` : q.end_at && new Date(q.end_at).getTime() > now ? `
                    <div class="quiz-sch-countdown" data-target="${new Date(q.end_at).getTime()}" data-reference="${q.start_at || (q.created_at ? new Date(q.created_at).getTime() : now)}" data-label="Ends In:" data-status="${q.status || 'published'}"></div>
                ` : q.end_at ? '<div class="tiny danger-text bold">Expired</div>' : ''}
            </div>
          ` : ''}
          <div class="flex gap-10 mt-15">
            <button class="button small w-auto" onclick="editQuiz('${q.id}')">Edit</button>
            <button class="button small w-auto success" style="background:var(--ok)" onclick="viewQuizResults('${q.id}')">Results</button>
            <button class="button small w-auto danger" onclick="deleteQuizById('${q.id}')">Delete</button>
          </div>
        </div>
`;}).join('') || '<div class="empty">No quizzes created yet.</div>'}
      </div>
    `;

    Countdown.createAll('.quiz-sch-countdown', {
        showProgress: true,
        onEnd: () => renderQuizzes()
    }).forEach(c => TeacherState.activeCountdowns.push(c));

  } catch (error) {
    console.error('Quizzes error:', error);
    UI.showNotification('Error loading quizzes: ' + error.message, 'error');
    container.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Quizzes</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderQuizzes()">Retry</button>
    </div>`;
  }
}

function addQuizQuestionField(q = null) {
  const container = document.getElementById('quizQuestionsContainer');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'question mb-20 card';
  const qId = 'quiz-q-text-' + TimerManager.getTime() + Math.random().toString(36).substring(2, 9);
  div.innerHTML = `
    <div class="flex-between mb-15">
      <h4 class="m-0">Quiz Question</h4>
      <button type="button" class="button danger small w-auto" onclick="this.closest('.question').remove(); updateQuizTotalPoints();">Remove Question</button>
    </div>
    <div class="mb-10">
      <label class="bold">Question Text:</label>
      <textarea id="${qId}" class="q-text" placeholder="Enter quiz question here..." required style="display:none">${q ? escapeHtml(q.text) : ''}</textarea>
    </div>
    <div class="grid-2 mt-10">
      <div>
        <label class="small">Question Type:</label>
        <select class="q-type" onchange="toggleQuizOptions(this)">
          <option value="mcq" ${q?.type === 'mcq' ? 'selected' : ''}>Multiple Choice</option>
          <option value="tf" ${q?.type === 'tf' ? 'selected' : ''}>True/False</option>
          <option value="short" ${q?.type === 'short' ? 'selected' : ''}>Short Answer</option>
        </select>
      </div>
      <div>
        <label class="small">Points</label>
        <input type="number" class="q-points" placeholder="Points" value="${q ? q.points : 5}">
      </div>
    </div>
    <div class="q-options mt-10">
      ${renderQuizOptions(q)}
    </div>
    <div class="mt-10">
      <label class="small">Hint (optional)</label>
      <input type="text" class="q-hint" placeholder="Hint..." value="${q?.hint ? escapeHtml(q.hint) : ''}">
      <label class="small">Explanation (optional)</label>
      <textarea class="q-explanation" placeholder="Explanation for correct answer..." rows="2">${q?.explanation ? escapeHtml(q.explanation) : ''}</textarea>
    </div>
  `;
  container.appendChild(div);
  UI.createRTE(qId, { minHeight: '60px' });
  div.querySelector('.q-points').addEventListener('input', updateQuizTotalPoints);
  div.querySelector('.q-points').addEventListener('change', updateQuizTotalPoints);
  updateQuizTotalPoints();
}

function updateQuizTotalPoints() {
  const total = Array.from(document.querySelectorAll('#quizQuestionsContainer .q-points'))
      .reduce((sum, input) => sum + (parseFloat(input.value) || 0), 0);
  const pointsInput = document.getElementById('quizTotalPoints');
  if (pointsInput) pointsInput.value = total;
}

const renderQuizOptions = (q) => {
  if (q?.type === 'tf') return `<select class="q-correct"><option value="True" ${q.correct === 'True' ? 'selected' : ''}>True</option><option value="False" ${q.correct === 'False' ? 'selected' : ''}>False</option></select>`;
  if (q?.type === 'short') return `<input type="text" class="q-correct" placeholder="Correct Answer (Exact Match)" value="${q.correct || ''}">`;
  const id = TimerManager.getTime() + Math.random();
  return `<div class="mcq-options">${(q?.options || ['','','','']).map((opt, i) => `<div>Option ${i+1}: <input type="text" class="opt-val" value="${escapeHtml(opt)}"> <input type="radio" name="correct-${id}" ${q?.correct === i.toString() ? 'checked' : ''} value="${i}"> Correct</div>`).join('')}</div>`;
};

const toggleQuizOptions = (select) => {
  const qItem = select.closest('.question');
  const container = qItem.querySelector('.q-options');
  if (container) container.innerHTML = renderQuizOptions({ type: select.value });
};

const shuffleQuizQuestions = () => {
  const container = document.getElementById('quizQuestionsContainer');
  const items = Array.from(container.children);
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    container.appendChild(items[j]);
  }
};

async function handleQuizSave(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Saving...';

  try {
    const user = await SessionManager.getCurrentUser();
    const quizId = document.getElementById('quizId').value;
    const isEdit = !!quizId;

    // Form Validation
    const title = document.getElementById('quizTitle').value.trim();
    const vTitle = Validator.required(title, 'Quiz title');
    if (!vTitle.valid) throw new Error(vTitle.message);

    const selCourseId = document.getElementById('quizCourseId').value;
    if (!selCourseId) throw new Error('Course selection is required.');

    const timeLimit = parseInt(document.getElementById('quizLimit').value) || 0;
    const attemptsAllowed = parseInt(document.getElementById('quizAttempts').value) || 1;
    const passingScore = parseInt(document.getElementById('quizPassingScore').value) || 60;
    const startAtVal = document.getElementById('quizStartAt').value;
    const endAtVal = document.getElementById('quizEndAt').value;

    if (timeLimit < 0) throw new Error('Time limit cannot be negative.');
    if (attemptsAllowed < 1) throw new Error('At least 1 attempt is required.');
    if (passingScore < 0 || passingScore > 100) throw new Error('Passing score must be between 0 and 100.');
    if (startAtVal && endAtVal && new Date(startAtVal) >= new Date(endAtVal)) throw new Error('Available Until date must be after Available From date.');

    const questions = [];
    document.querySelectorAll('#quizQuestionsContainer .question').forEach((item, idx) => {
      const type = item.querySelector('.q-type').value;
      const text = item.querySelector('.q-text').value.trim();
      const points = parseInt(item.querySelector('.q-points').value) || 0;

      const vQText = Validator.required(text, `Question ${idx + 1} text`);
      if (!vQText.valid) throw new Error(vQText.message);
      if (points < 0) throw new Error(`Question ${idx + 1} points cannot be negative.`);

      const qData = {
          text,
          type,
          points,
          hint: item.querySelector('.q-hint').value,
          explanation: item.querySelector('.q-explanation').value
      };

      if (type === 'mcq') {
        qData.options = Array.from(item.querySelectorAll('.opt-val')).map(i => i.value.trim());
        if (qData.options.some(o => !o)) throw new Error(`Question ${idx + 1} has empty options.`);
        const checked = item.querySelector('input[type="radio"]:checked');
        if (!checked) throw new Error(`Question ${idx + 1} (MCQ) must have a correct answer selected.`);
        qData.correct = checked.value;
      } else if (type === 'tf') {
        qData.correct = item.querySelector('.q-correct').value;
      } else {
        qData.correct = item.querySelector('.q-correct').value.trim();
        if (!qData.correct) throw new Error(`Question ${idx + 1} (Short Answer) requires a correct answer.`);
      }
      questions.push(qData);
    });

    if (questions.length === 0) throw new Error('Quiz must have at least one question.');

    const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);
    if (totalPoints <= 0) throw new Error('Total quiz points must be greater than zero.');

    const acConfig = JSON.parse(document.getElementById('antiCheatConfigData').value || '{}');

    await SupabaseDB.saveQuiz({
      id: isEdit ? quizId : crypto.randomUUID(),
      course_id: selCourseId,
      teacher_email: user.email,
      title: title,
      description: document.getElementById('quizDesc').value,
      time_limit: timeLimit,
      attempts_allowed: attemptsAllowed,
      passing_score: passingScore,
      start_at: startAtVal ? new Date(startAtVal).toISOString() : null,
      end_at: endAtVal ? new Date(endAtVal).toISOString() : null,
      shuffle_questions: document.getElementById('quizShuffle').value === 'true',
      status: document.getElementById('quizStatus').value,
      anti_cheat_config: acConfig,
      questions
    });
    UI.showNotification('Quiz saved successfully', 'success');
    renderQuizzes();
  } catch (err) {
    UI.showNotification('Error saving quiz: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function showQuizForm(quiz = null) {
  const renderId = window.currentRenderId;
  const isEdit = !!quiz;
  const container = document.getElementById('pageContent');
  if (!container) return;

  const user = await SessionManager.getCurrentUser();
  if (renderId !== window.currentRenderId) return;
  const { data: courses } = await SupabaseDB.getCourses(user.email, null);
  if (renderId !== window.currentRenderId) return;

  container.innerHTML = `
    <div class="card">
      <h2 class="m-0">${isEdit ? 'Edit Quiz' : 'Create Quiz'}</h2>
      <form id="quizForm" class="mt-20">
        <input type="hidden" id="quizId" value="${isEdit ? quiz.id : ''}">
        <label>Quiz Title</label>
        <input type="text" id="quizTitle" placeholder="Quiz Title" value="${isEdit ? escapeHtml(quiz.title) : ''}" required>
        <label>Description</label>
        <textarea id="quizDesc" placeholder="Description">${isEdit ? escapeHtml(quiz.description) : ''}</textarea>
        <div class="grid-2">
          <div><label class="small">Time Limit (min):</label><input type="number" id="quizLimit" value="${isEdit ? quiz.time_limit : 0}"></div>
          <div><label class="small">Attempts Allowed:</label><input type="number" id="quizAttempts" value="${isEdit ? quiz.attempts_allowed : 1}" min="1"></div>
        </div>
        <div class="grid-2 mt-10">
          <div><label class="small">Available From:</label><input type="datetime-local" id="quizStartAt" value="${isEdit && quiz.start_at ? new Date(quiz.start_at).toISOString().slice(0, 16) : ''}"></div>
          <div><label class="small">Available Until:</label><input type="datetime-local" id="quizEndAt" value="${isEdit && quiz.end_at ? new Date(quiz.end_at).toISOString().slice(0, 16) : ''}"></div>
        </div>
        <div class="grid-3 mt-10">
          <div><label class="small">Total Points:</label><input type="number" id="quizTotalPoints" value="0" readonly style="background:#f0f0f0"></div>
          <div><label class="small">Passing Score (%):</label><input type="number" id="quizPassingScore" value="${isEdit ? quiz.passing_score : 60}" min="0" max="100"></div>
          <div>
            <label class="small">Shuffle Questions?</label>
            <select id="quizShuffle">
              <option value="false" ${isEdit && !quiz.shuffle_questions ? 'selected' : ''}>No</option>
              <option value="true" ${isEdit && quiz.shuffle_questions ? 'selected' : ''}>Yes</option>
            </select>
          </div>
        </div>
        <div class="mt-10">
          <label>Course</label>
          <select id="quizCourseId" required>
            <option value="">Select Course</option>
            ${courses.map(c => `<option value="${c.id}" ${((isEdit ? quiz.course_id : null) === c.id) ? 'selected' : ''}>${escapeHtml(c.title)}</option>`).join('')}
          </select>
        </div>
        <label>Status</label>
        <select id="quizStatus">
          <option value="draft" ${isEdit && quiz.status === 'draft' ? 'selected' : ''}>Draft</option>
          <option value="published" ${isEdit && quiz.status === 'published' ? 'selected' : ''}>Published</option>
        </select>

        <div class="mt-20">
          <button type="button" class="button secondary w-auto small" onclick="openAntiCheatModal('quiz')">🛡️ Configure Anti-Cheat</button>
          <div id="ac-preview" class="small mt-10 text-muted"></div>
          <input type="hidden" id="antiCheatConfigData" value='${JSON.stringify(quiz?.anti_cheat_config || {})}'>
        </div>
        <div class="mt-20">
          <div class="flex-between">
            <h3 class="m-0">Questions</h3>
            <button type="button" class="button secondary w-auto small" onclick="shuffleQuizQuestions()">Shuffle Order</button>
          </div>
          <div id="quizQuestionsContainer" class="mt-15"></div>
          <button type="button" class="button secondary w-auto small" onclick="addQuizQuestionField()">+ Add Question</button>
        </div>
        <div class="flex gap-10 mt-30">
          <button type="submit" class="button w-auto px-40">${isEdit ? 'Update Quiz' : 'Save Quiz'}</button>
          <button type="button" class="button secondary w-auto px-40" onclick="renderQuizzes()">Cancel</button>
        </div>
      </form>
    </div>
  `;
  UI.createRTE('quizDesc');
  updateACPreview();
  if (isEdit && quiz.questions) { quiz.questions.forEach(q => addQuizQuestionField(q)); }
  document.getElementById('quizForm').addEventListener('submit', handleQuizSave);
}

async function editQuiz(id) {
  const renderId = window.currentRenderId;
  const user = await SessionManager.getCurrentUser();
  if (renderId !== window.currentRenderId) return;
  const { data: quizzes } = await SupabaseDB.getQuizzes(null, user.email, null);
  if (renderId !== window.currentRenderId) return;
  const quiz = (quizzes || []).find(q => q.id === id);
  showQuizForm(quiz);
}

async function deleteQuizById(id) {
  if (await UI.confirm('Are you sure you want to delete this quiz?', 'Delete Quiz')) {
    try {
      await SupabaseDB.deleteQuiz(id);
      UI.showNotification('Quiz deleted successfully', 'success');
      renderQuizzes();
    } catch (e) {
      UI.showNotification('Error deleting quiz: ' + e.message, 'error');
    }
  }
}

async function viewQuizResults(quizId) {
  const renderId = window.currentRenderId;
  // Authoritative reconciliation before viewing results
  try { await SupabaseDB.reconcileQuizAttempts(quizId); } catch(e) { console.warn('Reconciliation failed:', e); }
  if (renderId !== window.currentRenderId) return;

  try {
    const [{ data: subs }, quiz] = await Promise.all([
      SupabaseDB.getQuizSubmissions(quizId),
      SupabaseDB.getQuiz(quizId)
    ]);
    if (renderId !== window.currentRenderId) return;
    const container = document.getElementById('pageContent');
    if (!container) return;

    container.innerHTML = `
      <button class="button secondary w-auto mb-10" onclick="renderQuizzes()">← Back</button>
      <div class="card">
        <h2 class="m-0">Results for: ${escapeHtml(quiz.title)}</h2>
        <div class="p-0 mt-15" style="overflow-x:auto">
            <table>
              <thead><tr><th>Student</th><th>Score</th><th>Points</th><th>Submitted</th><th>Action</th></tr></thead>
              <tbody>
                ${subs.filter(s => s.status === 'submitted' || s.status === 'in-progress').map(s => `
                  <tr>
                    <td>${escapeHtml(s.student_email)}</td>
                    <td>${s.status === 'submitted' ? (s.score !== null ? s.score + '%' : '<span class="warning-text bold">Pending</span>') : '<span class="badge badge-warn">In Progress</span>'}</td>
                    <td>${s.total_points || 0}</td>
                    <td>${s.submitted_at ? new Date(s.submitted_at).toLocaleString() : '---'}</td>
                    <td><button class="button small w-auto" ${s.status === 'in-progress' ? 'disabled' : ''} onclick="gradeQuizSubmission('${s.id}', '${quizId}')">Grade/View</button></td>
                  </tr>
                `).join('') || '<tr><td colspan="5" class="empty">No submissions yet.</td></tr>'}
              </tbody>
            </table>
        </div>
      </div>
    `;
  } catch (e) {
    console.error('Quiz results error:', e);
    UI.showNotification('Error loading quiz results: ' + e.message, 'error');
    if (container) {
        container.innerHTML = `<div class="card danger-border">
          <h3>Error Loading Results</h3>
          <div class="small danger-text">${escapeHtml(e.message)}</div>
          <button class="button w-auto mt-10" onclick="viewQuizResults('${escapeAttr(quizId)}')">Retry</button>
        </div>`;
    }
  }
}

async function gradeQuizSubmission(submissionId, quizId) {
  const renderId = window.currentRenderId;
  try {
    const [quiz, submission] = await Promise.all([
      SupabaseDB.getQuiz(quizId),
      SupabaseDB.getQuizSubmissionById(submissionId)
    ]);
    if (renderId !== window.currentRenderId) return;
    const container = document.getElementById('pageContent');
  if (!container) return;

  const durationMin = Math.floor((submission.time_spent || 0) / 60);
  const durationSec = (submission.time_spent || 0) % 60;
  const avgTimePerQ = ((submission.time_spent || 0) / (quiz.questions?.length || 1)).toFixed(1);
  const isPassed = submission.score >= (quiz.passing_score || 0);

  container.innerHTML = `
    <button class="button secondary w-auto mb-10" onclick="viewQuizResults('${quizId}')">← Back to Results</button>
    <div class="card">
      <div class="flex-between">
          <h3 class="m-0">Grading: ${escapeHtml(quiz.title)}</h3>
          <span class="badge ${isPassed ? 'badge-active' : 'badge-inactive'}" style="font-size: 1.1rem; padding: 8px 16px;">
            ${isPassed ? 'PASSED' : 'FAILED'}
          </span>
      </div>
      <p class="small mt-5"><strong>Student:</strong> ${escapeHtml(submission.student_email)}</p>

      <div class="grid-3 mt-20 p-15 border-radius-sm" style="background:var(--bg)">
        <div class="text-center">
            <div class="small text-muted">Raw Score</div>
            <div class="bold" style="font-size:1.2rem">${Math.round(((submission.score || 0) / 100) * (submission.total_points || 0))} / ${submission.total_points || 0}</div>
        </div>
        <div class="text-center">
            <div class="small text-muted">Final Percentage</div>
            <div class="bold" style="font-size:1.5rem; color:var(--purple)">${submission.score || 0}%</div>
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

      <form id="quizGradingForm" class="mt-20">
        <div>
          ${quiz.questions.map((q, idx) => {
            const studentAnswer = submission.answers[idx] || 'No Answer';
            const isAutoGraded = q.type !== 'short';
            const isCorrect = isAutoGraded && studentAnswer.toString().toLowerCase() === q.correct.toString().toLowerCase();
            const statusColor = isAutoGraded ? (isCorrect ? 'var(--ok)' : 'var(--danger)') : 'var(--warn)';

            let studentDisplay = studentAnswer;
            let correctDisplay = q.correct;
            if (q.type === 'mcq') {
              studentDisplay = q.options[studentAnswer] !== undefined ? q.options[studentAnswer] : studentAnswer;
              correctDisplay = q.options[q.correct] !== undefined ? q.options[q.correct] : q.correct;
            }

            const manualScore = submission.analytics?.manual_scores?.[idx];
            const currentPoints = manualScore !== undefined ? manualScore : (isCorrect ? q.points : 0);

            return `
              <div class="question" style="border-left: 5px solid ${statusColor}">
                <div class="flex-between">
                  <div class="bold">Q${idx + 1}: ${UI.renderRichText(q.text)}</div>
                  <div class="badge ${isCorrect ? 'badge-active' : 'badge-warn'}">${currentPoints} / ${q.points} pts ${!isAutoGraded ? '(Manual)' : ''}</div>
                </div>
                <div class="mt-5">
                  <span class="small">Type: ${q.type.toUpperCase()}</span>
                </div>
                <div class="small p-10 mt-10" style="background:white; border:1px solid var(--border); border-radius:4px">
                  <strong class="text-muted">Student Answer:</strong> <span class="bold ${isCorrect ? 'success-text' : 'danger-text'}">${UI.renderRichText(studentDisplay)}</span>
                </div>
                ${!isCorrect ? `<div class="small success-text bold mt-5">Correct Answer: ${UI.renderRichText(correctDisplay)}</div>` : ''}

                ${!isAutoGraded ? `
                  <div class="mt-10 flex-center-y gap-10">
                    <label class="small m-0">Points Awarded (0-${q.points}):</label>
                    <input type="number" class="q-manual-points w-auto m-0 p-5" data-q-idx="${idx}" min="0" max="${q.points}" value="${currentPoints}" style="width:80px">
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
        <div class="mt-20 pt-20" style="border-top:1px solid var(--border)">
          <div class="bold mb-10">Final Score</div>
          <input type="number" id="finalQuizScore" min="0" max="100" value="${submission.score || 0}" class="w-auto" style="width:100px; background:#f0f0f0" readonly>
          <p class="small mt-5">Note: Calculated from question scores.</p>
          <button type="submit" class="button w-auto px-40 mt-15">Save Grade</button>
        </div>
      </form>
    </div>
  `;
  } catch (e) {
    console.error('Quiz grading error:', e);
    UI.showNotification('Error loading quiz submission: ' + e.message, 'error');
    if (container) {
        container.innerHTML = `<div class="card danger-border">
          <h3>Error Loading Submission</h3>
          <div class="small danger-text">${escapeHtml(e.message)}</div>
          <button class="button w-auto mt-10" onclick="gradeQuizSubmission('${escapeAttr(submissionId)}', '${escapeAttr(quizId)}')">Retry</button>
        </div>`;
    }
    return;
  }

  const finalScoreInput = document.getElementById('finalQuizScore');

  const updateQuizFinalScore = () => {
    const manualScores = Array.from(document.querySelectorAll('.q-manual-points')).map(input => ({
      idx: parseInt(input.dataset.qIdx),
      points: parseInt(input.value) || 0
    }));

    let earnedPoints = 0;
    let totalPossible = 0;
    quiz.questions.forEach((q, idx) => {
      totalPossible += q.points;
      const manual = manualScores.find(m => m.idx === idx);
      if (manual) {
        earnedPoints += manual.points;
      } else {
        const studentAnswer = submission.answers[idx] || '';
        if (studentAnswer.toString().toLowerCase() === q.correct.toString().toLowerCase()) {
          earnedPoints += q.points;
        }
      }
    });

    const percentage = totalPossible > 0 ? Math.round((earnedPoints / totalPossible) * 100) : 0;
    finalScoreInput.value = percentage;
  };

  document.querySelectorAll('.q-manual-points').forEach(input => {
    input.addEventListener('input', updateQuizFinalScore);
    input.addEventListener('change', updateQuizFinalScore);
    input.addEventListener('keyup', updateQuizFinalScore);
  });

  updateQuizFinalScore();

  document.getElementById('quizGradingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      const manualScoresMap = {};
      Array.from(document.querySelectorAll('.q-manual-points')).forEach(input => {
        const idx = parseInt(input.dataset.qIdx);
        const pts = parseInt(input.value) || 0;
        manualScoresMap[idx] = pts;
      });

      // Re-calculate final score immediately before save to ensure integrity
      let earnedPoints = 0;
      let totalPossible = 0;
      quiz.questions.forEach((q, idx) => {
        totalPossible += q.points;
        const manual = manualScoresMap[idx];
        if (manual !== undefined) {
          earnedPoints += manual;
        } else {
          const studentAnswer = submission.answers[idx] || '';
          if (studentAnswer.toString().toLowerCase() === q.correct.toString().toLowerCase()) {
            earnedPoints += q.points;
          }
        }
      });

      const finalScore = totalPossible > 0 ? Math.round((earnedPoints / totalPossible) * 100) : 0;

      const updatedSubmission = {
        ...submission,
        score: finalScore,
        total_points: totalPossible,
        status: 'submitted',
        analytics: {
            ...submission.analytics,
            manual_scores: manualScoresMap
        }
      };

      await SupabaseDB.saveQuizSubmission(updatedSubmission);
      UI.showNotification('Quiz graded successfully!', 'success');
      viewQuizResults(quizId);
    } catch (err) {
      UI.showNotification('Error saving grade: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Grade';
    }
  });
}

async function renderGradeBook() {
    const renderId = ++window.currentRenderId;
    const content = document.getElementById('pageContent');
    if (!content) return;
    clearActiveCountdowns();

    try {
        const user = await SessionManager.getCurrentUser();
        if (renderId !== window.currentRenderId) return;
        const [{ data: courses }, { data: assignments }, { data: quizzes }, { data: submissions }, { data: quizSubs }] = await Promise.all([
            SupabaseDB.getCourses(user.email, null),
            SupabaseDB.getAssignments(user.email, null, null),
            SupabaseDB.getQuizzes(null, user.email, null),
            SupabaseDB.getSubmissions(null, null, user.email),
            SupabaseDB.getQuizSubmissions(null, null, user.email)
        ]);
        if (renderId !== window.currentRenderId) return;

        content.innerHTML = `
            <div class="card flex-between">
                <h2 class="m-0">Grade Book</h2>
                <div class="flex gap-10">
                    <select id="gbCourseSelect" onchange="filterGradeBook()" style="width:auto; margin:0">
                        <option value="">All Courses</option>
                        ${courses.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('')}
                    </select>
                    <button class="button secondary small w-auto" onclick="exportGradeBook('csv')">CSV</button>
                    <button class="button secondary small w-auto" onclick="exportGradeBook('pdf')">PDF</button>
                </div>
            </div>
            <div id="gradeBookArea" class="mt-20"></div>
        `;

        TeacherState.gradeBookRawData = { courses, assignments, quizzes, submissions, quizSubs };
        filterGradeBook();
    } catch (error) {
        console.error('Grade Book error:', error);
        UI.showNotification('Error loading grade book: ' + error.message, 'error');
        content.innerHTML = `<div class="card danger-border">
            <h3>Error Loading Grade Book</h3>
            <div class="small danger-text">${escapeHtml(error.message)}</div>
            <button class="button w-auto mt-10" onclick="renderGradeBook()">Retry</button>
        </div>`;
    }
}

async function exportGradeBook(type) {
    const data = TeacherState.currentGradeBookData;
    if (!data) return UI.showNotification('No data to export', 'warn');

    const { filteredCourses, enrollments, assignments, quizzes, submissions, quizSubs } = data;

    let allHeaders = ['Course', 'Student', 'Type', 'Title', 'Grade', 'Raw Score', 'Max Points'];
    let allRows = [];

    for (const course of filteredCourses) {
        const courseAssigns = assignments.filter(a => a.course_id === course.id && a.status === 'published');
        const courseQuizzes = quizzes.filter(q => q.course_id === course.id && q.status === 'published');
        const courseStudents = enrollments.filter(e => e.course_id === course.id).map(e => e.student_email);

        for (const email of courseStudents) {
            // Assignments
            courseAssigns.forEach(a => {
                const sub = submissions.find(s => s.assignment_id === a.id && s.student_email === email);
                if (sub && sub.status === 'graded') {
                    allRows.push([
                        course.title,
                        email,
                        'Assignment',
                        a.title,
                        `${sub.final_grade}%`,
                        sub.grade,
                        a.points_possible
                    ]);
                } else {
                    allRows.push([course.title, email, 'Assignment', a.title, '-', '-', a.points_possible]);
                }
            });

            // Quizzes
            courseQuizzes.forEach(q => {
                const sub = quizSubs.filter(s => s.quiz_id === q.id && s.student_email === email && s.status === 'submitted')
                                   .sort((a,b) => (b.score || 0) - (a.score || 0))[0];
                if (sub) {
                    const rawScore = Math.round((sub.score / 100) * sub.total_points);
                    allRows.push([
                        course.title,
                        email,
                        'Quiz',
                        q.title,
                        `${sub.score}%`,
                        rawScore,
                        sub.total_points
                    ]);
                } else {
                    allRows.push([course.title, email, 'Quiz', q.title, '-', '-', '-']);
                }
            });
        }
    }

    if (allRows.length === 0) return UI.showNotification('No grades to export', 'warn');

    if (type === 'csv') {
        Exporter.csv('gradebook_export.csv', allHeaders, allRows);
    } else {
        await Exporter.pdf('gradebook_export.pdf', 'Detailed Grade Book Report', allHeaders, allRows);
    }
}

function initNav() {
  const teacherNav = document.getElementById('teacherNav');
  if (teacherNav) {
    teacherNav.querySelectorAll('button').forEach(button => {
      button.addEventListener('click', (e) => {
        teacherNav.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        button.classList.add('active');
        const page = button.dataset.page;
        if(page === 'dashboard') renderDashboard();
        else if(page === 'courses') renderCourses();
        else if(page === 'materials') renderMaterials();
        else if(page === 'assignments') renderAssignments();
        else if(page === 'grading') renderGrading();
        else if(page === 'gradebook') renderGradeBook();
        else if(page === 'students') renderStudents();
        else if(page === 'discussions') renderDiscussions();
        else if(page === 'certificates') renderCertificates();
        else if(page === 'quizzes') renderQuizzes();
        else if(page === 'live') renderLiveClasses();
        else if(page === 'calendar') renderCalendar();
        else if(page === 'anticheat') renderAntiCheat();
        else if(page === 'settings') renderSettings();
        else if(page === 'help') renderHelp();
      });
    });
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
    const { data: courses } = await SupabaseDB.getCourses(user.email, null);
    if (renderId !== window.currentRenderId) return;

    const courseIds = (courses || []).map(c => c.id);
    let materials = [];
    if (courseIds.length > 0) {
        const materialsRes = await SupabaseDB.getMaterials(null, courseIds);
        if (renderId !== window.currentRenderId) return;
        materials = materialsRes.data || [];
    }

    content.innerHTML = `
      <div class="card flex-between">
        <h2 class="m-0">Course Materials</h2>
        <button class="button w-auto" onclick="showMaterialForm()">+ Add Material</button>
      </div>
      <div class="grid">
        ${courses.map(c => {
          const courseMaterials = materials.filter(m => m.course_id === c.id);
          return `
            <div class="card">
              <h3 class="m-0">${escapeHtml(c.title)}</h3>
              <div class="grid mt-10" style="gap:8px">
                ${courseMaterials.map(m => `
                  <div class="flex-between list-item">
                    <span class="small">${escapeHtml(m.title)}</span>
                    <div class="flex gap-5">
                      <button class="button secondary tiny" onclick="UI.viewFile('${escapeAttr(m.file_url)}', '${escapeAttr(m.title)}')">View</button>
                      <button class="button danger tiny" onclick="deleteMaterial('${escapeAttr(m.id)}')">Delete</button>
                    </div>
                  </div>
                `).join('') || '<p class="small">No materials yet.</p>'}
              </div>
            </div>
          `;
        }).join('') || '<div class="empty">No courses found.</div>'}
      </div>

      <div id="materialFormArea" class="hidden mt-20"></div>
    `;
  } catch (error) {
    console.error('Materials error:', error);
    content.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Materials</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderMaterials()">Retry</button>
    </div>`;
  }
}

async function showMaterialForm() {
  const renderId = window.currentRenderId;
  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    const { data: courses } = await SupabaseDB.getCourses(user.email, null);
    if (renderId !== window.currentRenderId) return;
    const area = document.getElementById('materialFormArea');
    if (!area) return;
    area.classList.remove('hidden');
    area.innerHTML = `
    <div class="card">
      <h3 class="m-0">Add Course Material</h3>
      <div class="mt-20">
        <label>Course</label>
        <select id="matCourseId">${courses.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('')}</select>
        <label>Material Title</label>
        <input type="text" id="matTitle" placeholder="e.g. Syllabus, Week 1 Slides">
        <label>Description (Optional)</label>
        <textarea id="matDesc" placeholder="Briefly describe this material..." rows="2"></textarea>
        <div id="materialUploaderContainer" class="mt-10"></div>
        <input type="hidden" id="matFileUrl">
        <div class="flex gap-10 mt-20">
          <button class="button w-auto px-30" id="saveMatBtn" onclick="saveMaterial()" disabled>Save Material</button>
          <button class="button secondary w-auto px-30" onclick="document.getElementById('materialFormArea').classList.add('hidden')">Cancel</button>
        </div>
      </div>
    </div>
  `;

  UI.createRTE('matDesc');
    UI.createFileUploader('materialUploaderContainer', {
      bucket: 'materials',
      pathPrefix: 'course-content',
      onUploadSuccess: (url) => {
        document.getElementById('matFileUrl').value = url;
        document.getElementById('saveMatBtn').disabled = false;
      }
    });
  } catch (error) {
    console.error('Show material form error:', error);
    UI.showNotification('Error opening material form: ' + error.message, 'error');
  }
}

async function saveMaterial() {
  const user = await SessionManager.getCurrentUser();
  const courseId = document.getElementById('matCourseId').value;
  const title = document.getElementById('matTitle').value;
  const description = document.getElementById('matDesc').value;
  const url = document.getElementById('matFileUrl').value;
  if (!title || !url) {
      UI.showNotification('Title and file required', 'warn');
      return;
  }

  const btn = document.getElementById('saveMatBtn');
  if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving...';
  }

  try {
    await SupabaseDB.saveMaterial({
      id: crypto.randomUUID(),
      course_id: courseId,
      teacher_email: user.email,
      title: title,
      description: description,
      file_url: url
    });
    UI.showNotification('Material saved successfully', 'success');
    renderMaterials();
  } catch (e) {
    UI.showNotification('Save failed: ' + e.message, 'error');
  } finally {
      if (btn) {
          btn.disabled = false;
          btn.textContent = 'Save Material';
      }
  }
}

async function deleteMaterial(id) {
  if (await UI.confirm('Are you sure you want to delete this material?', 'Delete Material')) {
    try {
      await SupabaseDB.deleteMaterial(id);
      UI.showNotification('Material deleted', 'success');
      renderMaterials();
    } catch (e) {
      UI.showNotification('Delete failed: ' + e.message, 'error');
    }
  }
}

// Consolidate global window assignments
async function exportStudents(type) {
    const headers = ['Name', 'Email', 'Course'];
    const rows = TeacherState.currentStudents.map(s => [s.full_name || 'N/A', s.email, s.course_title || 'Unknown']);

    if (type === 'csv') {
        Exporter.csv('students_list.csv', headers, rows);
    } else {
        await Exporter.pdf('students_list.pdf', 'Enrolled Students List', headers, rows);
    }
}

async function filterGradeBook() {
    const { courses, assignments, quizzes, submissions, quizSubs } = TeacherState.gradeBookRawData;
    const courseId = document.getElementById('gbCourseSelect').value;
    const area = document.getElementById('gradeBookArea');
    const renderId = window.currentRenderId;

    try {
        let filteredCourses = courseId ? courses.filter(c => c.id === courseId) : courses;
        let courseIds = filteredCourses.map(c => c.id);

        const { data: enrollments } = await SupabaseDB.getEnrollmentsByCourses(courseIds);
        if (renderId !== window.currentRenderId) return;

        TeacherState.currentGradeBookData = { filteredCourses, enrollments, assignments, quizzes, submissions, quizSubs };

        let html = '';

        for (const course of filteredCourses) {
            const courseAssigns = assignments.filter(a => a.course_id === course.id && a.status === 'published');
            const courseQuizzes = quizzes.filter(q => q.course_id === course.id && q.status === 'published');
            const courseStudents = enrollments.filter(e => e.course_id === course.id).map(e => e.student_email);

            if (courseStudents.length === 0) {
                html += `<div class="card mb-20"><h3>${escapeHtml(course.title)}</h3><p class="empty small">No students enrolled.</p></div>`;
                continue;
            }

            html += `
                <div class="card mb-20" style="padding:0; overflow:hidden">
                    <div class="p-15" style="background:var(--bg)">
                        <h3 class="m-0">${escapeHtml(course.title)}</h3>
                        <p class="tiny text-muted m-0">${courseStudents.length} Students | ${courseAssigns.length} Assignments | ${courseQuizzes.length} Quizzes</p>
                    </div>
                    <div style="overflow-x:auto">
                        <table class="m-0">
                            <thead>
                                <tr>
                                    <th style="min-width:200px">Student</th>
                                    ${courseAssigns.map(a => `<th class="text-center" style="min-width:120px" title="${escapeAttr(a.title)}">📝 ${escapeHtml(a.title.substring(0,10))}...</th>`).join('')}
                                    ${courseQuizzes.map(q => `<th class="text-center" style="min-width:120px" title="${escapeAttr(q.title)}">❓ ${escapeHtml(q.title.substring(0,10))}...</th>`).join('')}
                                    <th class="text-center" style="min-width:100px; background:#f8fafc">Final Avg</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${courseStudents.map(email => {
                                    let earnedPoints = 0;
                                    let itemsCount = 0;

                                    const assignmentCells = courseAssigns.map(a => {
                                        const sub = submissions.find(s => s.assignment_id === a.id && s.student_email === email);
                                        if (sub && sub.status === 'graded') {
                                            earnedPoints += sub.final_grade;
                                            itemsCount++;
                                            return `
                                                <td class="text-center">
                                                    <span class="badge ${sub.final_grade >= 70 ? 'badge-active' : 'badge-warn'}">${sub.final_grade}%</span>
                                                    <div class="tiny text-muted mt-5">${sub.grade} / ${a.points_possible}</div>
                                                </td>`;
                                        }
                                        return `<td class="text-center"><span class="tiny text-muted">-</span></td>`;
                                    }).join('');

                                    const quizCells = courseQuizzes.map(q => {
                                        const sub = quizSubs.filter(s => s.quiz_id === q.id && s.student_email === email && s.status === 'submitted')
                                                            .sort((a,b) => (b.score || 0) - (a.score || 0))[0];
                                        if (sub) {
                                            earnedPoints += sub.score;
                                            itemsCount++;
                                            const rawScore = Math.round((sub.score / 100) * sub.total_points);
                                            return `
                                                <td class="text-center">
                                                    <span class="badge ${sub.score >= 70 ? 'badge-active' : 'badge-warn'}">${sub.score}%</span>
                                                    <div class="tiny text-muted mt-5">${rawScore} / ${sub.total_points}</div>
                                                </td>`;
                                        }
                                        return `<td class="text-center"><span class="tiny text-muted">-</span></td>`;
                                    }).join('');

                                    const avg = itemsCount > 0 ? Math.round(earnedPoints / itemsCount) : 0;

                                    return `
                                        <tr>
                                            <td><div class="bold small">${escapeHtml(email)}</div></td>
                                            ${assignmentCells}
                                            ${quizCells}
                                            <td class="text-center" style="background:#f8fafc"><strong class="${avg >= 70 ? 'success-text' : 'danger-text'}">${itemsCount > 0 ? avg + '%' : '-'}</strong></td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }
        area.innerHTML = html || '<div class="empty">No data available.</div>';
    } catch (error) {
        console.error('Filter Grade Book error:', error);
        UI.showNotification('Error filtering grade book: ' + error.message, 'error');
    }
}

window.toggleTeacherAssignmentType = (checkbox) => {
    const container = checkbox.closest('.question').querySelector('.q-type-ext');
    if (container) {
        container.style.display = checkbox.checked ? 'block' : 'none';
    }
};
window.addAssignmentLink = () => {
    const label = document.getElementById('attLinkLabel').value.trim();
    const url = document.getElementById('attLinkUrl').value.trim();
    if (!url) return UI.showNotification('URL required', 'warn');
    if (!isValidUrl(url)) return UI.showNotification('Please enter a valid URL (starting with http:// or https://)', 'error');

    const container = document.getElementById('attachmentsContainer');
    const div = document.createElement('div');
    div.className = 'flex-between list-item mb-5';
    div.innerHTML = `
      <span class="small">${escapeHtml(label || url)}</span>
      <button type="button" class="button danger tiny w-auto" onclick="this.parentElement.remove()">Remove</button>
      <input type="hidden" class="att-data" value='${JSON.stringify({ name: label || url, url, type: 'link' })}'>
    `;
    container.appendChild(div);
    document.getElementById('attLinkLabel').value = '';
    document.getElementById('attLinkUrl').value = '';
};
window.showCourseForm = showCourseForm;
window.editCourse = editCourse;
window.deleteCourseById = deleteCourseById;
window.showLessonForm = showLessonForm;
window.editLesson = editLesson;
window.deleteLessonById = deleteLessonById;
window.showAssignmentForm = showAssignmentForm;
window.editAssignment = editAssignment;
window.deleteAssignmentById = deleteAssignmentById;
window.gradeSubmission = gradeSubmission;
window.viewCourseDiscussions = viewCourseDiscussions;
window.showQuizForm = showQuizForm;
window.editQuiz = editQuiz;
window.deleteQuizById = deleteQuizById;
window.viewQuizResults = viewQuizResults;
window.gradeQuizSubmission = gradeQuizSubmission;
window.renderDashboard = renderDashboard;
window.renderCourses = renderCourses;
window.renderAssignments = renderAssignments;
window.renderMaterials = renderMaterials;
window.renderGrading = renderGrading;
window.renderStudents = renderStudents;
window.renderDiscussions = renderDiscussions;
window.renderCertificates = renderCertificates;
window.renderQuizzes = renderQuizzes;
window.renderLiveClasses = renderLiveClasses;
window.renderGradeBook = renderGradeBook;
window.renderCalendar = renderCalendar;
window.renderHelp = renderHelp;
window.renderAntiCheat = renderAntiCheat;
window.renderSettings = renderSettings;
window.showCertForm = showCertForm;
window.issueCert = issueCert;
window.unenrollStudent = unenrollStudent;
window.loadAndEditCourse = loadAndEditCourse;
window.loadAndEditLiveClass = loadAndEditLiveClass;
window.handleStartLiveClass = handleStartLiveClass;
window.stopLiveClass = stopLiveClass;
window.extendLiveClass = extendLiveClass;
window.teacherModAction = teacherModAction;
window.showLiveClassForm = showLiveClassForm;
window.startTeacherLiveClass = startTeacherLiveClass;
window.deleteLiveClass = deleteLiveClass;
window.viewAttendance = viewAttendance;
window.saveMaterial = saveMaterial;
window.deleteMaterial = deleteMaterial;
window.showMaterialForm = showMaterialForm;
window.openAntiCheatModal = openAntiCheatModal;
window.updateACPreview = updateACPreview;
window.clearStudentViolations = clearStudentViolations;
window.viewAssessmentViolations = viewAssessmentViolations;
window.viewStudentIntegrityReport = viewStudentIntegrityReport;
window.exportStudents = exportStudents;
window.filterGradeBook = filterGradeBook;
window.addQuizQuestionField = addQuizQuestionField;
window.updateQuizTotalPoints = updateQuizTotalPoints;
window.renderQuizOptions = renderQuizOptions;
window.toggleQuizOptions = toggleQuizOptions;
window.shuffleQuizQuestions = shuffleQuizQuestions;
window.addQuestionField = addQuestionField;
window.updateAssignmentTotalPoints = updateAssignmentTotalPoints;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await initDashboard('teacher');
  if (user) {
    initNav();
    NotificationManager.init();
    NotificationManager.initRealtimeSubscriptions(user.email, 'teacher', () => {
        const activeEl = document.activeElement;
        const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
        if (!isTyping) {
          if (document.querySelector('[data-page="quizzes"].active')) renderQuizzes();
          if (document.querySelector('[data-page="grading"].active')) renderGrading();
          if (document.querySelector('[data-page="gradebook"].active')) renderGradeBook();
        }
    });

    // Deep linking support
    const urlParams = new URLSearchParams(window.location.search);
    const page = urlParams.get('page');
    if (page) {
        const navBtn = document.querySelector(`nav button[data-page="${page}"]`);
        if (navBtn) {
            navBtn.click();
        } else {
            renderDashboard();
        }
    } else {
        renderDashboard();
    }

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
