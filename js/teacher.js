const TeacherState = {
  activeCountdowns: [],
  currentGradeBookData: null,
  gradeBookRawData: null,
  myCourseIds: null,
  myCourses: null,
  studentsPage: 1,
  _warnedEnd: false,
  liveClassTimer: null,
  analyticsCache: new Map(),
  _liveProctoringInterval: null,
  _liveViolationsChannel: null
};

function clearActiveCountdowns() {
    UI.clearCountdowns(TeacherState.activeCountdowns, TeacherState.liveClassTimer);
    TeacherState.liveClassTimer = null;
}



async function renderDashboard() {
  const renderId = ++window.currentRenderId;
  NotificationManager.init();
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  UI.showLoading('pageContent', 'Initializing analytics engine...');

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
      ${courses.map(c => {
        const enrolledCount = c.enrollments?.[0]?.count || 0;
        const limit = c.enrollment_limit;
        const limitDisplay = limit ? `${enrolledCount} / ${limit} Enrolled` : `${enrolledCount} Enrolled`;
        const isFull = limit && enrolledCount >= limit;

        return `
        <div class="card">
          <h3 class="m-0">${escapeHtml(c.title)}</h3>
          <div class="small">${UI.renderRichText(c.description)}</div>
          <div class="mt-10 flex-between flex-wrap gap-5">
            <div class="flex gap-5 flex-wrap">
                <span class="badge ${c.status === 'published' ? 'badge-active' : 'badge-lock'}">${escapeHtml(c.status)}</span>
                ${c.semester ? `<span class="badge badge-purple">${escapeHtml(c.semester)}</span>` : ''}
            </div>
            <span class="tiny bold ${isFull ? 'danger-text' : 'text-muted'}">${escapeHtml(limitDisplay)}</span>
          </div>
          <div class="flex gap-10 mt-15">
            <button class="button w-auto small" onclick="editCourse('${escapeAttr(c.id)}')">Manage Lessons</button>
            <button class="button secondary w-auto small" onclick="loadAndEditCourse('${escapeAttr(c.id)}')">Edit Info</button>
            <button class="button danger w-auto small" onclick="deleteCourseById('${escapeAttr(c.id)}')">Delete</button>
          </div>
        </div>
      `;}).join('') || '<div class="empty">No courses created yet.</div>'}
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
            <textarea id="courseDescription" placeholder="Description" rows="4">${isEdit ? escapeHtml(UI.htmlToPlainText(course.description || '')) : ''}</textarea>
          </div>
          <div>
            <label>Enrollment ID (Optional)</label>
            <input type="text" id="courseEnrollmentId" placeholder="Require ID for enrollment" value="${isEdit ? escapeHtml(course.enrollment_id || '') : ''}">
          </div>
          <div>
            <label>Enrollment Limit (0 for unlimited)</label>
            <input type="number" id="courseEnrollmentLimit" placeholder="Max students" min="0" value="${isEdit ? (course.enrollment_limit || 0) : 0}">
          </div>
          <div>
            <label>Semester</label>
            <input type="text" id="courseSemester" placeholder="e.g. Fall 2024" value="${isEdit ? escapeHtml(course.semester || '') : ''}">
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
        semester: document.getElementById('courseSemester').value.trim() || null,
        enrollment_id: document.getElementById('courseEnrollmentId').value || null,
        enrollment_limit: parseInt(document.getElementById('courseEnrollmentLimit').value) || null,
        status: document.getElementById('courseStatus').value,
        teacher_email: user.email,
        created_by: user.full_name,
        metadata: course?.metadata || {}
      };

      await SupabaseDB.saveCourse(courseData);
      TeacherState.myCourseIds = null;
      TeacherState.myCourses = null;
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
  const renderId = ++window.currentRenderId;
  const user = await SessionManager.getCurrentUser();
  if (renderId !== window.currentRenderId) return;

  const [{ data: courses }, topicRes, lessonRes, { data: courseAssignments }] = await Promise.all([
    SupabaseDB.getCourses(user.email, null),
    SupabaseDB.getTopics(id),
    SupabaseDB.getLessons(id),
    SupabaseDB.getAssignments(user.email, id, null)
  ]);
  if (renderId !== window.currentRenderId) return;

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
      <div>
        <h2 class="m-0">Course: ${escapeHtml(course.title)}</h2>
        <p class="tiny text-muted mt-5">ID: ${course.id}</p>
      </div>
      <div class="flex gap-10">
        <button class="button secondary w-auto" style="background: #ecfdf5; color: #065f46; border-color: #a7f3d0" onclick="indexCourseForAI('${id}')">✨ Index Course for AI Tutor</button>
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
  const renderId = ++window.currentRenderId;
  const isEdit = !!lesson;
  const content = document.getElementById('pageContent');
  if (!content) return;

  const { data: topics } = await SupabaseDB.getTopics(courseId);
  if (renderId !== window.currentRenderId) return;

  content.innerHTML = `
    <div class="card">
      <h2 class="m-0">${isEdit ? 'Edit Lesson' : 'Add Lesson'}</h2>
      <div class="grid-2 mt-20">
        <div>
          <form id="lessonForm">
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
            <textarea id="lessonContent" placeholder="Lesson content..." rows="10">${isEdit ? escapeHtml(UI.htmlToPlainText(lesson.content)) : ''}</textarea>

            <label>Order Index</label>
            <input type="number" id="lessonOrder" placeholder="Order Index" value="${isEdit ? lesson.order_index : 0}">

            <div class="flex gap-10 mt-20">
              <button type="submit" class="button w-auto px-40" ${topics.length === 0 ? 'disabled' : ''}>${isEdit ? 'Update Lesson' : 'Save Lesson'}</button>
              <button type="button" class="button secondary w-auto px-40" onclick="editCourse('${courseId}')">Cancel</button>
            </div>
          </form>
        </div>

        <div class="bg-light p-15 border-radius-md" style="max-height: 700px; overflow-y: auto;">
          <h3 class="m-0 mb-10 small">Import Content from Knowledge Base</h3>
          <p class="tiny text-muted mb-15">Select content from Course, Topics, or Materials (PDFs) to load and edit before saving as a lesson.</p>

          <label>Select Source Content</label>
          <select id="kbSourceSelect" class="w-100 mb-10" disabled>
            <option value="">-- Loading knowledge items... --</option>
          </select>

          <div id="kbLoadMoreContainer" style="display: none;" class="mb-15">
            <button type="button" id="kbLoadMoreBtn" class="button secondary tiny w-100">Load More Content</button>
          </div>

          <div id="kbPreviewSection" style="display: none;">
            <label class="mt-10">Edit Selected Content</label>
            <textarea id="kbContentEdit" class="w-100" rows="8" placeholder="Edit content before importing..."></textarea>

            <div class="flex gap-10 mt-10">
              <button type="button" id="kbApplyBtn" class="button tiny w-auto">Overwrite Lesson Content</button>
              <button type="button" id="kbAppendBtn" class="button secondary tiny w-auto">Append to Lesson</button>
            </div>
          </div>

          <div id="kbEmptyMessage" class="tiny text-muted mt-10" style="display: none;">
            No knowledge base items found for this course. Ensure you have topics or uploaded PDF materials indexed under "Materials".
          </div>
        </div>
      </div>
    </div>
  `;

  // REGISTER THE SUBMIT LISTENER IMMEDIATELY - Preventing the Page-Reload Race Condition
  const formElement = document.getElementById('lessonForm');
  if (formElement) {
    formElement.addEventListener('submit', async (e) => {
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
      } catch (err) {
        UI.showNotification('Error saving lesson: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  }

  // Bind side-panel action elements
  const kbSelect = document.getElementById('kbSourceSelect');
  const kbPreviewSec = document.getElementById('kbPreviewSection');
  const kbContentEdit = document.getElementById('kbContentEdit');
  const kbEmptyMsg = document.getElementById('kbEmptyMessage');
  const kbApplyBtn = document.getElementById('kbApplyBtn');
  const kbAppendBtn = document.getElementById('kbAppendBtn');
  const kbLoadMoreContainer = document.getElementById('kbLoadMoreContainer');
  const kbLoadMoreBtn = document.getElementById('kbLoadMoreBtn');

  let kbEmbeddings = [];
  let kbPage = 1;
  const kbPageSize = 50;
  let kbTotal = 0;

  async function loadKnowledgePage(page) {
    if (kbLoadMoreBtn) {
      kbLoadMoreBtn.disabled = true;
      kbLoadMoreBtn.textContent = 'Loading more...';
    }
    try {
      const res = await SupabaseDB.getKnowledgeEmbeddings(courseId, { page, pageSize: kbPageSize });
      if (renderId !== window.currentRenderId) return;

      const newItems = res.data || [];
      kbTotal = res.total || 0;
      kbEmbeddings = kbEmbeddings.concat(newItems);

      updateDropdownUI();
    } catch (e) {
      console.warn('Failed to load knowledge embeddings page:', e);
      UI.showNotification('Failed to load more knowledge base content.', 'error');
    } finally {
      if (kbLoadMoreBtn) {
        kbLoadMoreBtn.disabled = false;
        kbLoadMoreBtn.textContent = 'Load More Content';
      }
    }
  }

  function updateDropdownUI() {
    if (kbEmbeddings.length === 0) {
      if (kbSelect) {
        kbSelect.innerHTML = '<option value="">-- No items available --</option>';
        kbSelect.disabled = true;
      }
      if (kbEmptyMsg) kbEmptyMsg.style.display = 'block';
      if (kbLoadMoreContainer) kbLoadMoreContainer.style.display = 'none';
    } else {
      if (kbSelect) {
        const selectedValue = kbSelect.value;
        kbSelect.innerHTML = `
          <option value="">-- Select a knowledge item --</option>
          ${kbEmbeddings.map((item, index) => {
            const type = item.source_type ? item.source_type.toUpperCase() : 'UNKNOWN';
            const title = item.metadata?.title || 'Untitled';
            const snippet = item.content ? (item.content.trim().slice(0, 50) + (item.content.trim().length > 50 ? '...' : '')) : '';
            return `<option value="${index}" ${selectedValue === String(index) ? 'selected' : ''}>[${type}] ${escapeHtml(title)} - ${escapeHtml(snippet)}</option>`;
          }).join('')}
        `;
        kbSelect.disabled = false;
      }
      if (kbEmptyMsg) kbEmptyMsg.style.display = 'none';

      // Check if we need a load-more button
      if (kbLoadMoreContainer && kbLoadMoreBtn) {
        if (kbEmbeddings.length < kbTotal) {
          kbLoadMoreContainer.style.display = 'block';
        } else {
          kbLoadMoreContainer.style.display = 'none';
        }
      }
    }
  }

  // Setup listeners
  if (kbSelect) {
    kbSelect.addEventListener('change', (e) => {
      const idx = e.target.value;
      if (idx === "") {
        if (kbPreviewSec) kbPreviewSec.style.display = 'none';
      } else {
        const selectedItem = kbEmbeddings[parseInt(idx)];
        if (selectedItem) {
          if (kbContentEdit) kbContentEdit.value = selectedItem.content || '';
          if (kbPreviewSec) kbPreviewSec.style.display = 'block';
        }
      }
    });
  }

  if (kbApplyBtn) {
    kbApplyBtn.addEventListener('click', () => {
      const editedContent = kbContentEdit ? kbContentEdit.value : '';
      const lessonContentTextarea = document.getElementById('lessonContent');
      if (lessonContentTextarea) {
        lessonContentTextarea.value = editedContent;
        UI.showNotification('Lesson content overwritten with knowledge item.', 'success');
      }
    });
  }

  if (kbAppendBtn) {
    kbAppendBtn.addEventListener('click', () => {
      const editedContent = kbContentEdit ? kbContentEdit.value : '';
      const lessonContentTextarea = document.getElementById('lessonContent');
      if (lessonContentTextarea) {
        if (lessonContentTextarea.value.trim()) {
          lessonContentTextarea.value += '\n\n' + editedContent;
        } else {
          lessonContentTextarea.value = editedContent;
        }
        UI.showNotification('Knowledge item appended to lesson content.', 'success');
      }
    });
  }

  if (kbLoadMoreBtn) {
    kbLoadMoreBtn.addEventListener('click', () => {
      kbPage++;
      loadKnowledgePage(kbPage);
    });
  }

  // Load page 1 initially
  await loadKnowledgePage(kbPage);
}
async function editLesson(lessonId, courseId) {
  const renderId = ++window.currentRenderId;
  const lessonRes = await SupabaseDB.getLessons(courseId);
  if (renderId !== window.currentRenderId) return;
  const lessons = lessonRes.data || [];
  const lesson = lessons.find(l => l.id === lessonId);
  if (lesson) await showLessonForm(courseId, lesson);
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
        <textarea id="topicDescription" placeholder="Briefly describe this topic..." rows="3">${isEdit ? escapeHtml(UI.htmlToPlainText(topic.description || '')) : ''}</textarea>
        <label>Order Index</label>
        <input type="number" id="topicOrder" placeholder="Order Index" value="${isEdit ? topic.order_index : 0}">
        <div class="flex gap-10 mt-20">
          <button type="submit" class="button w-auto px-40">${isEdit ? 'Update Topic' : 'Save Topic'}</button>
          <button type="button" class="button secondary w-auto px-40" onclick="editCourse('${courseId}')">Cancel</button>
        </div>
      </form>
    </div>
  `;
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
      TeacherState.myCourseIds = null;
      TeacherState.myCourses = null;
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
async function renderGrading(page = 1) {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  const searchTerm = document.getElementById('gradingSearch')?.value || '';
  const assignmentFilter = document.getElementById('gradingAssignmentFilter')?.value || '';
  const pageSize = 10;

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;

    // Fetch assignments and submissions in parallel for performance
    const [assignmentsRes, submissionsRes] = await Promise.all([
      SupabaseDB.getAssignments(user.email, null, null, { all: true }),
      SupabaseDB.getSubmissions(
        assignmentFilter || null,
        null,
        user.email,
        {
          pendingGradingOnly: true,
          searchTerm,
          page,
          pageSize
        }
      )
    ]);
    if (renderId !== window.currentRenderId) return;
    const { data: assignments } = assignmentsRes;
    const { data: submittedSubs, total } = submissionsRes;

    content.innerHTML = `
      <div class="card mb-20">
        <div class="flex-between flex-wrap gap-15">
            <h2 class="m-0">Grading Queue</h2>
            <div class="small text-muted">${escapeHtml(total)} Submissions Pending</div>
        </div>
        <div class="grid-2 mt-20 gap-10">
            <div>
                <label class="small bold">Filter by Assignment</label>
                <select id="gradingAssignmentFilter" class="m-0">
                    <option value="">All Assignments</option>
                    ${assignments.map(a => `<option value="${a.id}" ${assignmentFilter === a.id ? 'selected' : ''}>${escapeHtml(a.title)}</option>`).join('')}
                </select>
            </div>
            <div>
                <label class="small bold">Search Student</label>
                <input type="text" id="gradingSearch" placeholder="Name or email..." class="m-0" value="${escapeAttr(searchTerm)}">
            </div>
        </div>
      </div>
      <div id="gradingQueueTable"></div>
      <div id="gradingPagination"></div>
    `;

    UI.renderTable('gradingQueueTable', ['Assignment', 'Student', 'Submitted', 'Status', 'Action'], submittedSubs, (s) => {
        const assignment = assignments.find(a => a.id === s.assignment_id);
        const studentName = s.users?.full_name || 'Unknown Student';
        const isRegrade = !!s.regrade_request;
        return `
            <tr>
                <td>
                    <div class="bold small">${escapeHtml(assignment?.title || 'Unknown')}</div>
                    <div class="tiny text-muted">ID: ${escapeHtml(s.assignment_id.substring(0,8))}...</div>
                </td>
                <td>
                    <div class="bold small">${escapeHtml(studentName)}</div>
                    <div class="tiny text-muted">${escapeHtml(s.student_email)}</div>
                </td>
                <td>${new Date(s.submitted_at).toLocaleString()}</td>
                <td>${isRegrade ? '<span class="badge badge-warn">REGRADE REQ</span>' : '<span class="badge badge-active">NEW SUB</span>'}</td>
                <td><button class="button small w-auto" onclick="gradeSubmission('${escapeAttr(s.assignment_id)}', '${escapeAttr(s.student_email)}')">Review</button></td>
            </tr>
        `;
    }, { emptyMessage: '<h3>All caught up!</h3><p class="small">No pending submissions to grade matching your filters.</p>' });

    UI.renderPagination('gradingPagination', total, page, pageSize, (p) => renderGrading(p));

    // Event Listeners for Filters
    const searchInput = document.getElementById('gradingSearch');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(() => {
            renderGrading(1);
        }, 500));
        if (searchTerm) {
            searchInput.focus();
            searchInput.setSelectionRange(searchTerm.length, searchTerm.length);
        }
    }

    const filterSelect = document.getElementById('gradingAssignmentFilter');
    if (filterSelect) {
        filterSelect.addEventListener('change', () => renderGrading(1));
    }

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
async function renderStudents(page = 1) {
  TeacherState.studentsPage = page;
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  const searchTerm = document.getElementById('studentSearch')?.value || '';
  const courseFilter = document.getElementById('courseFilter')?.value || '';
  const pageSize = 20;

  try {
    if (!TeacherState.myCourses) {
        const user = await SessionManager.getCurrentUser();
        if (renderId !== window.currentRenderId) return;
        const { data: myCourses } = await SupabaseDB.getCourses(user.email, null);
        if (renderId !== window.currentRenderId) return;
        TeacherState.myCourses = myCourses || [];
        TeacherState.myCourseIds = TeacherState.myCourses.map(c => c.id);
    }

    const targetCourseIds = courseFilter ? [courseFilter] : TeacherState.myCourseIds;

    const { data: enrollments, total } = await SupabaseDB.getEnrollmentsByCourses(targetCourseIds, {
        searchTerm,
        page,
        pageSize
    });
    if (renderId !== window.currentRenderId) return;

    const students = enrollments.map(e => {
        return {
            full_name: e.users?.full_name || 'N/A',
            email: e.student_email,
            course_title: e.courses?.title || 'Unknown',
            course_id: e.course_id
        };
    }).filter(s => s.email);

    const isSearchFocused = document.activeElement && document.activeElement.id === 'studentSearch';
    const isFilterFocused = document.activeElement && document.activeElement.id === 'courseFilter';

    content.innerHTML = `
    <div class="card">
      <div class="flex-between mb-20 flex-wrap gap-15">
        <h2 class="m-0">My Enrolled Students</h2>
        <div class="flex gap-10 flex-wrap">
            <div class="small text-muted flex-center-y">${total} Total</div>
            <select id="courseFilter" class="m-0" style="width:200px">
                <option value="">All Courses</option>
                ${TeacherState.myCourses.map(c => `<option value="${c.id}" ${courseFilter === c.id ? 'selected' : ''}>${escapeHtml(c.title)}</option>`).join('')}
            </select>
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
      <div id="studentsPagination" class="mt-20"></div>
    </div>
    <div id="certFormArea" class="hidden mt-20"></div>
    `;

    UI.renderPagination('studentsPagination', total, page, pageSize, (p) => renderStudents(p));

    const searchInput = document.getElementById('studentSearch');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(() => {
            renderStudents(1);
        }, 500));

        if (isSearchFocused) {
            searchInput.focus();
            // Restore cursor position if possible or just end
            searchInput.setSelectionRange(searchTerm.length, searchTerm.length);
        }
    }

    const filterSelect = document.getElementById('courseFilter');
    if (filterSelect) {
        filterSelect.addEventListener('change', () => renderStudents(1));
        if (isFilterFocused) filterSelect.focus();
    }


  } catch (error) {
    console.error('Students error:', error);
    UI.showNotification('Failed to load students: ' + error.message, 'error');
    content.innerHTML = `<div class="stat-card danger">
      <h3>Error Loading Students</h3>
      <div class="small danger-text">${escapeHtml(error.message)}</div>
      <button class="button w-auto mt-10" onclick="renderStudents(${page})">Retry</button>
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
    renderStudents(TeacherState.studentsPage);
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
  const renderId = ++window.currentRenderId;
  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;

    let courses = [];
    if (targetCourseId) {
        const course = await SupabaseDB.getCourse(targetCourseId);
        courses = [course];
    } else {
        // Filter courses: only show courses where the student is actually enrolled AND the teacher teaches
        const [{ data: enrollments }, { data: allCourses }] = await Promise.all([
            SupabaseDB.getEnrollments(studentEmail),
            SupabaseDB.getCourses(user.email, null)
        ]);
        if (renderId !== window.currentRenderId) return;

        const studentEnrolledCourseIds = (enrollments || []).map(e => e.course_id);

        // Cache teacher course IDs for other views
        TeacherState.myCourses = allCourses || [];
        TeacherState.myCourseIds = TeacherState.myCourses.map(c => c.id);

        courses = (allCourses || []).filter(c => studentEnrolledCourseIds.includes(c.id));
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
        <textarea id="${qId}" class="q-text" placeholder="Enter question description here..." required>${q ? escapeHtml(UI.htmlToPlainText(q.text)) : ''}</textarea>
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

  // Auto-update total points when individual question points change
  div.querySelector('.q-points').addEventListener('input', updateAssignmentTotalPoints);
  div.querySelector('.q-points').addEventListener('change', updateAssignmentTotalPoints);

  updateAssignmentTotalPoints();
}

async function showAssignmentForm(assignment = null, courseId = null) {
  const renderId = ++window.currentRenderId;
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
        <textarea id="assignmentDescription" placeholder="Description" rows="4">${isEdit ? escapeHtml(UI.htmlToPlainText(assignment.description)) : ''}</textarea>

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
          <div class="flex-between">
            <h3 class="m-0">Questions</h3>
            <button type="button" class="button w-auto secondary small" style="background: #fdf2f8; border-color: #fbcfe8; color: #be185d" onclick="openAIAssignmentGenerator(document.getElementById('assignmentCourseId')?.value)">✨ Generate with AI</button>
          </div>
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
  const renderId = ++window.currentRenderId;
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
  const renderId = ++window.currentRenderId;
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
                    <textarea class="q-feedback-input small w-100 mt-5" data-q-idx="${idx}" rows="2" placeholder="Specific feedback for this answer...">${escapeHtml(UI.htmlToPlainText(submission.question_feedback?.[idx] || ''))}</textarea>
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
          <textarea id="feedback" rows="4" placeholder="Enter feedback for student...">${escapeHtml(UI.htmlToPlainText(submission.feedback || ''))}</textarea>
        </div>
        <div class="flex-between mt-20 flex-wrap gap-10">
          <div class="flex gap-10">
            <button type="submit" class="button w-auto px-40" id="submitGradeBtn">Submit Grade</button>
            <button type="button" class="button secondary w-auto px-40" id="saveDraftBtn">Save Draft</button>
            <button type="button" class="button secondary w-auto px-40" onclick="renderGrading()">Cancel</button>
          </div>
          <button type="button" id="aiGradingBtn" class="button w-auto secondary" style="background: #f5f3ff; border-color: #ddd6fe; color: #6d28d9" onclick="openAIGradingAssistant('${escapeAttr(assignmentId)}', '${escapeAttr(studentEmail)}')">🤖 AI Grading Insight</button>
        </div>
      </form>
    </div>
  `;
  const rawInput = document.getElementById('grade');
  const finalInput = document.getElementById('finalGrade');

  const updateRawFromQuestions = () => {
      const total = Array.from(document.querySelectorAll('.q-score-input'))
          .reduce((sum, input) => {
              const max = parseInt(input.dataset.max) || 0;
              let val = parseInt(input.value) || 0;
              // Clamp for UI calculation
              val = Math.max(0, Math.min(val, max));
              return sum + val;
          }, 0);
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

  const saveGrading = async (isDraft = false) => {
    if (window.currentRenderId !== renderId) return;

    const submitBtn = document.getElementById('submitGradeBtn');
    const draftBtn = document.getElementById('saveDraftBtn');
    const activeBtn = isDraft ? draftBtn : submitBtn;
    const otherBtn = isDraft ? submitBtn : draftBtn;

    if (activeBtn) {
        activeBtn.disabled = true;
        activeBtn.textContent = 'Saving...';
    }
    if (otherBtn) otherBtn.disabled = true;

    try {
      const questionScores = {};
      document.querySelectorAll('.q-score-input').forEach(input => {
          const max = parseInt(input.dataset.max) || 0;
          let val = parseInt(input.value) || 0;
          // Clamp score to [0, max]
          val = Math.max(0, Math.min(val, max));
          questionScores[input.dataset.qIdx] = val;
      });

      const questionFeedback = {};
      document.querySelectorAll('.q-feedback-input').forEach(input => {
          questionFeedback[input.dataset.qIdx] = input.value;
      });

      const feedbackEl = document.getElementById('feedback');

      const updatedSubmission = {
        ...submission,
        grade: parseInt(rawInput.value) || 0,
        final_grade: parseInt(finalInput.value) || 0,
        question_scores: questionScores,
        question_feedback: questionFeedback,
        late_penalty_applied: latePenalty,
        feedback: feedbackEl.value,
        status: isDraft ? (submission.status || 'submitted') : 'graded',
        graded_at: isDraft ? (submission.graded_at || null) : new Date().toISOString(),
        regrade_request: isDraft ? (submission.regrade_request || null) : null
      };

      if (await SupabaseDB.saveSubmission(updatedSubmission)) {
        if (window.currentRenderId !== renderId) return;
        UI.showNotification(isDraft ? 'Draft saved successfully' : 'Submission graded successfully', 'success');
        renderGrading();
      }
    } catch (e) {
      UI.showNotification('Error saving grade: ' + e.message, 'error');
    } finally {
      if (activeBtn) {
          activeBtn.disabled = false;
          activeBtn.textContent = isDraft ? 'Save Draft' : 'Submit Grade';
      }
      if (otherBtn) otherBtn.disabled = false;
    }
  };

  document.getElementById('gradingForm').addEventListener('submit', (e) => {
    e.preventDefault();
    saveGrading(false);
  });

  const draftBtn = document.getElementById('saveDraftBtn');
  if (draftBtn) {
      draftBtn.addEventListener('click', () => saveGrading(true));
  }
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
  DiscussionManager.render('pageContent', courseId);
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

  // Cleanup existing live monitoring on teacher side
  if (TeacherState._liveProctoringInterval) {
    clearInterval(TeacherState._liveProctoringInterval);
    TeacherState._liveProctoringInterval = null;
  }
  if (TeacherState._liveViolationsChannel) {
    window.supabaseClient?.removeChannel(TeacherState._liveViolationsChannel);
    TeacherState._liveViolationsChannel = null;
  }

  content.innerHTML = `
    <div class="flex-between mb-20">
        <div>
            <h2 class="m-0">Security Monitoring</h2>
            <p class="small text-muted mt-5">Oversee academic integrity and manage proctoring parameters.</p>
        </div>
        <div class="flex gap-10">
            <button class="button secondary small w-auto" id="teacher-view-records-btn">📜 View Historical Records</button>
            <button class="button small w-auto" id="teacher-view-live-btn" style="background:#5b2ea6">📺 Live Proctoring Center</button>
        </div>
    </div>
    <div id="anticheat-tab-content"></div>
  `;

  const showHistorical = async () => {
    // Clear any active intervals/channels when switching to historical
    if (TeacherState._liveProctoringInterval) {
      clearInterval(TeacherState._liveProctoringInterval);
      TeacherState._liveProctoringInterval = null;
    }
    if (TeacherState._liveViolationsChannel) {
      window.supabaseClient?.removeChannel(TeacherState._liveViolationsChannel);
      TeacherState._liveViolationsChannel = null;
    }

    document.getElementById('teacher-view-records-btn').classList.remove('secondary');
    document.getElementById('teacher-view-records-btn').style.background = 'var(--purple)';
    document.getElementById('teacher-view-records-btn').style.color = 'white';
    document.getElementById('teacher-view-live-btn').classList.add('secondary');
    document.getElementById('teacher-view-live-btn').style.background = '';
    document.getElementById('teacher-view-live-btn').style.color = '';

    UI.showLoading('anticheat-tab-content', 'Loading security summary...');
    try {
        const user = await SessionManager.getCurrentUser();
        const { data: summary } = await SupabaseDB.getViolationSummary(user.email);
        if (renderId !== window.currentRenderId) return;

        UI.renderAntiCheatSummary('anticheat-tab-content', summary, {
            title: 'Historical Security Records',
            subtitle: 'Overview of historical assessments with detected integrity violations.',
            onViewDetails: (id, title) => viewAssessmentViolations(id, title),
            onRefresh: () => showHistorical()
        });
    } catch (error) {
        console.error('AntiCheat error:', error);
        UI.showNotification('Error loading security summary: ' + error.message, 'error');
        document.getElementById('anticheat-tab-content').innerHTML = `
          <div class="card danger-border">
            <h3>Error Loading Summary</h3>
            <div class="small danger-text">${escapeHtml(error.message)}</div>
            <button class="button w-auto mt-10" onclick="renderAntiCheat()">Retry</button>
          </div>
        `;
    }
  };

  const showLive = async () => {
    document.getElementById('teacher-view-live-btn').classList.remove('secondary');
    document.getElementById('teacher-view-live-btn').style.background = '#5b2ea6';
    document.getElementById('teacher-view-live-btn').style.color = 'white';
    document.getElementById('teacher-view-records-btn').classList.add('secondary');
    document.getElementById('teacher-view-records-btn').style.background = '';
    document.getElementById('teacher-view-records-btn').style.color = '';

    await renderTeacherLiveProctoring(renderId);
  };

  document.getElementById('teacher-view-records-btn').onclick = showHistorical;
  document.getElementById('teacher-view-live-btn').onclick = showLive;

  // Default to historical view (keeping the functional default intact)
  await showHistorical();
}

async function renderTeacherLiveProctoring(renderId) {
    const area = document.getElementById('anticheat-tab-content');
    if (!area) return;

    UI.showLoading('anticheat-tab-content', 'Initializing Real-time Proctoring Center...');

    try {
        const user = await SessionManager.getCurrentUser();
        const [sessions, examsToday] = await Promise.all([
            SupabaseDB.getLiveProctoringSessions({ teacherEmail: user.email }),
            SupabaseDB.getExamsTodayCount(user.email)
        ]);
        if (renderId !== window.currentRenderId) return;

        const activeCount = sessions.length;
        const totalViolations = sessions.reduce((acc, s) => acc + parseInt(s.violation_count || 0), 0);
        const accuracy = 96.3;

        area.innerHTML = `
            <div class="flex-between mb-20">
                <h3 class="m-0">Live Proctoring Dashboard</h3>
                <div class="flex gap-10">
                    <button class="button secondary small w-auto" onclick="showTeacherLiveFeedModal('${escapeAttr(user.email)}')" style="background:var(--ok); color:white">📺 Open Live Feed</button>
                    <button class="button secondary small w-auto" onclick="renderTeacherLiveProctoring(${renderId})">Refresh</button>
                    <button class="button small w-auto" style="background:#5b2ea6" onclick="exportProctoringReport('${escapeAttr(user.email)}')">Export Report</button>
                </div>
            </div>

            <div class="card p-0 mb-20 overflow-hidden" style="border:none; background:#5b2ea6; color:white">
                <div class="p-15 flex-between">
                    <div class="flex-center-y gap-10">
                        <div class="pulse-indicator" style="width:10px; height:10px; background:#48bb78; border-radius:50%"></div>
                        <strong style="font-size:1.1rem">My Scoped Courses Live AI Proctoring</strong>
                        <span class="tiny" style="opacity:0.8; margin-left:10px">Monitoring Active for Enrolled Students</span>
                    </div>
                </div>
            </div>

            <div class="stats-grid mb-20">
                <div class="stat-card">
                    <h4>Active Enrolled Sessions</h4>
                    <div class="value">${activeCount}</div>
                </div>
                <div class="stat-card">
                    <h4>Violations Detected</h4>
                    <div class="value">${totalViolations}</div>
                </div>
                <div class="stat-card">
                    <h4>My Exams Today</h4>
                    <div class="value">${examsToday}</div>
                </div>
                <div class="stat-card">
                    <h4>Detection Accuracy</h4>
                    <div class="value">${accuracy}%</div>
                </div>
            </div>

            <div class="card mb-20" style="background:#fff5f5; border:1px solid #feb2b2">
                <h4 class="m-0 mb-15" style="color:#c53030">Recent Enrolled Violations</h4>
                <div id="liveViolationsFeed" class="flex-column gap-10">
                    <div class="empty tiny" style="color:#a0aec0">Waiting for live data...</div>
                </div>
            </div>

            <div class="card">
                <div class="flex-between mb-15">
                    <h3 class="m-0">Active Proctored Sessions</h3>
                    <span class="tiny text-muted">Real-time monitoring of ongoing exams for my courses</span>
                </div>
                <div id="activeSessionsTable"></div>
            </div>
        `;

        renderTeacherSessionsTable(sessions);

        // Start real-time updates
        TeacherState._liveProctoringInterval = setInterval(async () => {
            const updatedSessions = await SupabaseDB.getLiveProctoringSessions({ teacherEmail: user.email });
            const updatedExams = await SupabaseDB.getExamsTodayCount(user.email);
            // Update counts in UI without full re-render
            const valEls = area.querySelectorAll('.stat-card .value');
            if (valEls[0]) valEls[0].textContent = updatedSessions.length;
            if (valEls[1]) valEls[1].textContent = updatedSessions.reduce((acc, s) => acc + parseInt(s.violation_count || 0), 0);
            if (valEls[2]) valEls[2].textContent = updatedExams;

            renderTeacherSessionsTable(updatedSessions);
        }, 10000);

        TeacherState._liveViolationsChannel = SupabaseDB.subscribeToLiveViolations((v) => {
            if (v.severity !== 'INFO' && v.teacher_email === user.email) {
                addTeacherLiveViolationToFeed(v);
            }
        });

    } catch (e) {
        console.error('Live Proctoring Error:', e);
        area.innerHTML = `<div class="stat-card danger"><h3>System Error</h3><p class="small">${escapeHtml(e.message)}</p></div>`;
    }
}

function renderTeacherSessionsTable(sessions) {
    UI.renderTable('activeSessionsTable', ['Student', 'Exam', 'Duration', 'Status', 'Violations', 'Actions'], sessions, (s) => {
        const elapsed = Math.round((new Date() - new Date(s.started_at)) / 60000);
        let statusClass = 'badge-active';
        if (s.status === 'Flagged') statusClass = 'badge-inactive';
        else if (s.status === 'Warning') statusClass = 'badge-warn';
        else if (s.status === 'Idle') statusClass = 'secondary';

        const onlineIndicator = s.is_online ?
            '<span class="pulse-indicator" style="width:8px; height:8px; background:#48bb78; border-radius:50%; display:inline-block; margin-right:5px" title="Online"></span>' :
            '<span style="width:8px; height:8px; background:#cbd5e0; border-radius:50%; display:inline-block; margin-right:5px" title="Offline"></span>';

        return `
            <tr data-attempt-id="${s.attempt_id}">
                <td>
                    <div class="flex-center-y">
                        ${onlineIndicator}
                        <div class="bold small">${escapeHtml(s.full_name)}</div>
                    </div>
                    <div class="tiny text-muted ml-15">${escapeHtml(s.user_email)}</div>
                </td>
                <td>
                    <div class="small">${escapeHtml(s.assessment_title)}</div>
                    <span class="badge tiny">${s.assessment_type.toUpperCase()}</span>
                </td>
                <td><div class="small">${elapsed} min</div></td>
                <td><span class="badge ${statusClass} tiny">${s.status.toUpperCase()}</span></td>
                <td><span class="badge ${s.violation_count > 0 ? 'badge-warn' : 'secondary'} tiny">${s.violation_count} Violations</span></td>
                <td>
                    <div class="flex gap-5">
                        <button class="button small tiny w-auto" style="background:#5b2ea6" onclick="monitorLiveSession('${s.attempt_id}', '${escapeAttr(s.user_email)}')">Monitor</button>
                        <button class="button secondary tiny w-auto" onclick="sendMessageToStudent('${escapeAttr(s.user_email)}', '${s.attempt_id}')">Message</button>
                        <button class="button danger tiny w-auto" onclick="terminateSession('${s.attempt_id}', '${escapeAttr(s.user_email)}')">Terminate</button>
                    </div>
                </td>
            </tr>
        `;
    }, { emptyMessage: 'No active proctored sessions at the moment.' });
}

function addTeacherLiveViolationToFeed(v) {
    const feed = document.getElementById('liveViolationsFeed');
    if (!feed) return;

    const empty = feed.querySelector('.empty');
    if (empty) empty.remove();

    const entry = document.createElement('div');
    entry.className = 'flex-between p-10 bg-white border-radius-sm animate-fade-in';
    entry.style.borderLeft = '4px solid #c53030';
    entry.innerHTML = `
        <div>
            <div class="bold small" style="color:#c53030">${escapeHtml(v.type.replace(/_/g, ' '))}</div>
            <div class="tiny text-muted">Student: ${escapeHtml(v.user_email)} - ${new Date(v.timestamp).toLocaleTimeString()}</div>
        </div>
        <button class="button secondary tiny w-auto" onclick="monitorLiveSession('${v.attempt_id}', '${escapeAttr(v.user_email)}')">View</button>
    `;

    feed.prepend(entry);
    if (feed.children.length > 5) feed.lastElementChild.remove();
}

async function monitorLiveSession(attemptId, email) {
    const backdrop = UI.showModal('Live Session Monitor: ' + email, `
        <div class="flex-between mb-15 p-10 bg-light border-radius-sm">
            <div class="flex-center-y gap-10">
                <div class="pulse-indicator" id="surveillance-pulse" style="width:10px; height:10px; background:#48bb78; border-radius:50%; display:none"></div>
                <span class="small bold">Live Surveillance</span>
                <span id="monitor-status-indicator" class="tiny text-muted">| Monitoring Active</span>
            </div>
            <label class="switch-container flex-center-y gap-10">
                <input type="checkbox" id="surveillance-toggle" style="width:auto; margin:0">
                <span class="tiny text-muted">Auto-play audio & update feed</span>
            </label>
        </div>
        <div id="liveMonitorContent" style="min-height:400px">
            <div class="flex-center p-40"><div class="loading-spinner"></div></div>
        </div>
    `, { maxWidth: '1000px' });

    let surveillanceActive = false;
    const toggle = document.getElementById('surveillance-toggle');
    const pulse = document.getElementById('surveillance-pulse');
    const audioQueue = [];
    let isPlayingAudio = false;
    let activeAudio = null;

    const playNextAudio = async () => {
        if (!surveillanceActive || audioQueue.length === 0 || isPlayingAudio) return;
        isPlayingAudio = true;
        const path = audioQueue.shift();
        try {
            const url = await SupabaseDB.createSignedUrl('proctoring', path);
            if (!surveillanceActive) {
                isPlayingAudio = false;
                return;
            }
            activeAudio = new Audio(url);
            activeAudio.onended = () => {
                activeAudio = null;
                isPlayingAudio = false;
                playNextAudio();
            };
            await activeAudio.play();
        } catch (e) {
            console.warn('Audio playback failed:', e);
            activeAudio = null;
            isPlayingAudio = false;
            playNextAudio();
        }
    };

    const stopAudioPlayback = () => {
        audioQueue.length = 0;
        if (activeAudio) {
            try {
                activeAudio.pause();
                activeAudio.src = '';
            } catch (e) {
                console.warn('Failed to stop audio:', e);
            }
            activeAudio = null;
        }
        isPlayingAudio = false;
    };

    toggle.onchange = (e) => {
        surveillanceActive = e.target.checked;
        pulse.style.display = surveillanceActive ? 'block' : 'none';
        if (surveillanceActive) {
            UI.showNotification('Live surveillance mode active', 'success');
            playNextAudio();
        } else {
            stopAudioPlayback();
        }
    };

    try {
        const fetchAndUpdate = async (isIncremental = false) => {
            const { data: violations } = await SupabaseDB.getViolations(null, email, null, { attemptId, all: true });

            const activeTab = document.querySelector('#proctoringMediaEvidence .tabs button.active')?.textContent.split(' (')[0];

            UI.renderIntegrityReport('liveMonitorContent', violations, email);

            if (activeTab) {
                const tabs = document.querySelectorAll('#proctoringMediaEvidence .tabs button');
                tabs.forEach(btn => {
                    if (btn.textContent.startsWith(activeTab)) {
                        const tabIdMap = { 'Webcam Snapshots': 'snaps', 'Screen Recordings': 'screen', 'Audio Recordings': 'audio' };
                        const tabId = tabIdMap[activeTab];
                        if (tabId) UI._switchProctorTab(btn, tabId);
                    }
                });
            }

            if (isIncremental && surveillanceActive) {
                const loadBtn = document.querySelector('#proctor-snaps button');
                if (loadBtn) UI._loadProctorThumbnails(loadBtn);
            }
        };

        // Initial fetch
        await fetchAndUpdate(false);

        // Subscribe to live updates for THIS assessment attempt
        const channel = window.supabaseClient.channel('monitor-' + attemptId)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'violations',
                filter: `attempt_id=eq.${attemptId}`
            }, async (payload) => {
                const newViolation = payload.new;

                if (surveillanceActive) {
                    if (newViolation.type === 'AUDIO_RECORDED' && newViolation.metadata?.path) {
                        audioQueue.push(newViolation.metadata.path);
                        if (!isPlayingAudio) playNextAudio();
                    }
                    await fetchAndUpdate(true);
                } else {
                    UI.showNotification('New activity detected in session', 'info');
                    await fetchAndUpdate(true);
                }
            })
            .subscribe();

        const cleanup = () => {
            surveillanceActive = false;
            stopAudioPlayback();
            window.supabaseClient?.removeChannel(channel);
        };

        // MutationObserver to bulletproof modal destruction/removal cleanups
        const observer = new MutationObserver(() => {
            if (!document.body.contains(backdrop)) {
                cleanup();
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        backdrop.querySelector('button.secondary.tiny').onclick = () => {
            cleanup();
            backdrop.remove();
        };

    } catch (e) {
        document.getElementById('liveMonitorContent').innerHTML = '<div class="empty">Error loading session data</div>';
    }
}

async function terminateSession(attemptId, email) {
    if (!await UI.confirm(`Are you sure you want to terminate the session for ${email}? This will stop their assessment immediately.`, 'Terminate Session')) return;

    try {
        let assessmentId = null;
        let assessmentType = null;
        let courseId = null;
        let teacherEmail = null;

        if (attemptId) {
            const { data: attemptLogs } = await SupabaseDB.getViolations(null, null, null, { attemptId, all: true });
            if (attemptLogs && attemptLogs.length > 0) {
                const ref = attemptLogs[0];
                assessmentId = ref.assessment_id;
                assessmentType = ref.assessment_type;
                courseId = ref.course_id;
                teacherEmail = ref.teacher_email;
            }
        }

        await SupabaseDB.saveViolation({
            attempt_id: attemptId,
            user_email: email,
            assessment_id: assessmentId,
            assessment_type: assessmentType,
            course_id: courseId,
            teacher_email: teacherEmail,
            type: 'SESSION_TERMINATED',
            severity: 'CRITICAL',
            score: 100,
            metadata: { reason: 'Terminated by classroom teacher' }
        });

        UI.showNotification('Termination signal sent to student device.', 'success');
        const user = await SessionManager.getCurrentUser();
        const updatedSessions = await SupabaseDB.getLiveProctoringSessions({ teacherEmail: user.email });
        renderTeacherSessionsTable(updatedSessions);
    } catch (e) {
        UI.showNotification('Failed to terminate session: ' + e.message, 'error');
    }
}

async function sendMessageToStudent(email, attemptId = null) {
    const msg = await UI.prompt(`Send a priority message to student ${email}:`, '', 'Priority Message');
    if (!msg) return;

    try {
        let assessmentId = null;
        let assessmentType = null;
        let courseId = null;
        let teacherEmail = null;

        if (attemptId) {
            const { data: attemptLogs } = await SupabaseDB.getViolations(null, null, null, { attemptId, all: true });
            if (attemptLogs && attemptLogs.length > 0) {
                const ref = attemptLogs[0];
                assessmentId = ref.assessment_id;
                assessmentType = ref.assessment_type;
                courseId = ref.course_id;
                teacherEmail = ref.teacher_email;
            }
        }

        const user = await SessionManager.getCurrentUser();
        await SupabaseDB.notifyUser({
            email: email,
            title: 'Proctoring Alert',
            message: msg,
            type: 'system',
            metadata: { author_email: user.email }
        });

        if (attemptId) {
            await SupabaseDB.saveViolation({
                attempt_id: attemptId,
                user_email: email,
                assessment_id: assessmentId,
                assessment_type: assessmentType,
                course_id: courseId,
                teacher_email: teacherEmail,
                type: 'STAFF_MESSAGE',
                severity: 'INFO',
                score: 0,
                metadata: { message: msg }
            });
        }

        UI.showNotification('Message sent to student.', 'success');
    } catch (e) {
        UI.showNotification('Failed to send message: ' + e.message, 'error');
    }
}

async function exportProctoringReport(teacherEmail) {
    UI.showNotification('Preparing proctoring report...', 'info');
    try {
        const sessions = await SupabaseDB.getLiveProctoringSessions({ teacherEmail });
        if (!sessions || sessions.length === 0) {
            return UI.showNotification('No active sessions to export.', 'warn');
        }

        const headers = ['Student', 'Email', 'Assessment', 'Type', 'Started At', 'Last Activity', 'Violations', 'Status', 'Online'];
        const rows = sessions.map(s => [
            s.full_name,
            s.user_email,
            s.assessment_title,
            s.assessment_type,
            new Date(s.started_at).toLocaleString(),
            new Date(s.last_activity).toLocaleString(),
            s.violation_count,
            s.status,
            s.is_online ? 'YES' : 'NO'
        ]);

        Exporter.csv(`teacher_proctoring_report_${new Date().toISOString().split('T')[0]}.csv`, headers, rows);
        UI.showNotification('Report exported successfully.', 'success');
    } catch (e) {
        console.error('Export failed:', e);
        UI.showNotification('Failed to export report: ' + e.message, 'error');
    }
}

async function showTeacherLiveFeedModal(teacherEmail) {
    const backdrop = UI.showModal('Real-time Proctoring Feed', `
        <div id="live-feed-grid" class="grid-3 gap-15">
            <div class="flex-center p-40" style="grid-column: 1/-1"><div class="loading-spinner"></div></div>
        </div>
    `, { maxWidth: '1200px' });

    const grid = document.getElementById('live-feed-grid');
    let inFlight = false;
    let isClosed = false;

    const updateFeed = async () => {
        if (inFlight || isClosed) return;
        inFlight = true;

        try {
            const sessions = await SupabaseDB.getLiveProctoringSessions({ teacherEmail, withLatestSnapshots: true });
            if (isClosed) return;

            if (!sessions || sessions.length === 0) {
                grid.innerHTML = '<div class="empty p-40" style="grid-column: 1/-1">No active sessions currently streaming.</div>';
                return;
            }

            const proms = sessions.map(async s => {
                let snapUrl = null;
                if (s.latestSnapshotPath) {
                    try {
                        snapUrl = await SupabaseDB.createSignedUrl('proctoring', s.latestSnapshotPath);
                    } catch (urlErr) {
                        console.warn('Failed to sign snapshot URL:', urlErr);
                    }
                }
                return { ...s, snapUrl };
            });

            const sessionsWithSnaps = await Promise.all(proms);
            if (isClosed) return;

            grid.innerHTML = sessionsWithSnaps.map(s => `
                <div class="card p-0 overflow-hidden animate-fade-in" style="border: 2px solid ${s.violation_count > 5 ? 'var(--danger)' : (s.violation_count > 0 ? 'var(--warn)' : 'var(--border)')}">
                    <div class="p-10 flex-between bg-light">
                        <div class="flex-center-y gap-5">
                            <div class="${s.is_online ? 'pulse-indicator' : ''}" style="width:6px; height:6px; background:${s.is_online ? '#48bb78' : '#cbd5e0'}; border-radius:50%"></div>
                            <div>
                                <div class="bold tiny">${escapeHtml(s.full_name)}</div>
                                <div class="tiny text-muted">${escapeHtml(s.assessment_title)}</div>
                            </div>
                        </div>
                        <span class="badge ${s.violation_count > 0 ? 'badge-warn' : 'badge-active'} tiny">${s.violation_count} V</span>
                    </div>
                    <div class="live-snap-box bg-dark flex-center" style="height:180px; position:relative">
                        ${s.snapUrl ? `<img src="${s.snapUrl}" style="width:100%; height:100%; object-fit:cover">` : '<div class="text-muted tiny">Waiting for camera...</div>'}
                        <div class="absolute bottom-5 right-5 flex gap-5">
                            <button class="button primary tiny w-auto p-5" onclick="monitorLiveSession('${s.attempt_id}', '${escapeAttr(s.user_email)}')">Monitor</button>
                        </div>
                    </div>
                </div>
            `).join('');
        } catch (err) {
            console.error('Error refreshing live feed:', err);
            if (!isClosed && grid.children.length === 0) {
                grid.innerHTML = '<div class="empty p-40" style="grid-column: 1/-1; color: var(--danger)">Error loading live feed data.</div>';
            }
        } finally {
            inFlight = false;
        }
    };

    updateFeed();
    const interval = setInterval(updateFeed, 15000);

    const cleanup = () => {
        isClosed = true;
        clearInterval(interval);
    };

    // Use MutationObserver on body to safely catch DOM removals and prevent any interval leaks
    const observer = new MutationObserver(() => {
        if (!document.body.contains(backdrop)) {
            cleanup();
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    backdrop.querySelector('button.secondary.tiny').onclick = () => {
        cleanup();
        backdrop.remove();
    };
}

window.monitorLiveSession = monitorLiveSession;
window.terminateSession = terminateSession;
window.sendMessageToStudent = sendMessageToStudent;
window.showTeacherLiveFeedModal = showTeacherLiveFeedModal;
window.exportProctoringReport = exportProctoringReport;

async function viewAssessmentViolations(assessmentId, title) {
    const renderId = ++window.currentRenderId;
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
    const renderId = ++window.currentRenderId;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.display = 'flex';
    backdrop.innerHTML = `
        <div class="modal" style="max-width: 1000px">
            <div class="flex-between mb-20">
                <h3 class="m-0">Integrity Report: ${escapeHtml(studentEmail)}</h3>
                <button class="button secondary tiny w-auto" onclick="this.closest('.modal-backdrop').remove()">✕</button>
            </div>
            <div id="reportContentArea"></div>
        </div>
    `;
    document.body.appendChild(backdrop);

    try {
        // Fetch all violations including INFO logs for media evidence
        const { data: violations } = await SupabaseDB.getViolations(assessmentId, studentEmail, null, { all: true });
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
        { key: 'BLOCK_TEXT_SELECTION', label: 'Block Text Selection', desc: 'Disables the ability to highlight/select text.', category: 'Input' },

        { key: 'PROCTORING_WEBCAM', label: 'Webcam Monitoring', desc: 'Captures periodic snapshots of the student via webcam.', category: 'Proctoring & AI' },
        { key: 'PROCTORING_SCREEN', label: 'Screen Recording', desc: 'Records the student\'s screen in chunks throughout the assessment.', category: 'Proctoring & AI' },
        { key: 'PROCTORING_AUDIO', label: 'Periodic Audio Recording', desc: 'Captures audio chunks from the student\'s microphone.', category: 'Proctoring & AI' },
        { key: 'PROCTORING_FACE_DETECTION', label: 'AI Face Detection', desc: 'Detects presence of multiple faces or absence of the student.', category: 'Proctoring & AI' }
    ];

    const categories = ['Interaction', 'Environment', 'Input', 'Proctoring & AI'];

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
                            ${cat === 'Interaction' ? '🖱️' : cat === 'Environment' ? '🌐' : cat === 'Input' ? '⌨️' : '🤖'} ${cat} ${cat === 'Proctoring & AI' ? '' : 'Control'}
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
        const active = Object.entries(config)
            .filter(([k, v]) => v === true)
            .map(([k, v]) => k.replace('BLOCK_', '').replace('PROCTORING_', '').replace(/_/g, ' '));

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
  const renderId = ++window.currentRenderId;
  try {
    const liveClass = await SupabaseDB.getLiveClass(id);
    if (renderId !== window.currentRenderId) return;
    if (liveClass) showLiveClassForm(liveClass);
  } catch (e) {
    UI.showNotification('Error loading live class: ' + e.message, 'error');
  }
}

async function showLiveClassForm(liveClass = null) {
  const renderId = ++window.currentRenderId;
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
  const renderId = ++window.currentRenderId;
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
      <textarea id="${qId}" class="q-text" placeholder="Enter quiz question here..." required>${q ? escapeHtml(UI.htmlToPlainText(q.text)) : ''}</textarea>
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
      <textarea class="q-explanation" placeholder="Explanation for correct answer..." rows="2">${q?.explanation ? escapeHtml(UI.htmlToPlainText(q.explanation)) : ''}</textarea>
    </div>
  `;
  container.appendChild(div);
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
  const renderId = ++window.currentRenderId;
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
        <textarea id="quizDesc" placeholder="Description">${isEdit ? escapeHtml(UI.htmlToPlainText(quiz.description)) : ''}</textarea>
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
            <div class="flex gap-5">
                <button type="button" class="button w-auto secondary small" style="background: #fdf2f8; border-color: #fbcfe8; color: #be185d" onclick="openAIQuizGenerator(document.getElementById('quizCourseId')?.value)">✨ Generate with AI</button>
                <button type="button" class="button secondary w-auto small" onclick="shuffleQuizQuestions()">Shuffle Order</button>
            </div>
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
  updateACPreview();
  if (isEdit && quiz.questions) { quiz.questions.forEach(q => addQuizQuestionField(q)); }
  document.getElementById('quizForm').addEventListener('submit', handleQuizSave);
}

async function editQuiz(id) {
  const renderId = ++window.currentRenderId;
  const user = await SessionManager.getCurrentUser();
  if (renderId !== window.currentRenderId) return;
  const { data: quizzes } = await SupabaseDB.getQuizzes(null, user.email, null);
  if (renderId !== window.currentRenderId) return;
  const quiz = (quizzes || []).find(q => q.id === id);
  if (quiz) showQuizForm(quiz);
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
  const renderId = ++window.currentRenderId;
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
  const renderId = ++window.currentRenderId;
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

        UI.showLoading('pageContent', 'Synchronizing data...');
        // Authoritative reconciliation before fetching data
        try { await SupabaseDB.reconcileQuizAttempts(); } catch(e) { console.warn('Global reconciliation failed:', e); }
        if (renderId !== window.currentRenderId) return;

        UI.showLoading('pageContent', 'Initializing Grade Book...');

        const [{ data: courses }, { data: assignments }, { data: quizzes }] = await Promise.all([
            SupabaseDB.getCourses(user.email, null, { all: true }),
            SupabaseDB.getAssignments(user.email, null, null, { all: true }),
            SupabaseDB.getQuizzes(null, user.email, null, { all: true })
        ]);
        if (renderId !== window.currentRenderId) return;

        content.innerHTML = `
            <div class="card">
                <div class="flex-between flex-wrap gap-15">
                    <h2 class="m-0">Grade Book</h2>
                    <div class="flex gap-10 flex-wrap">
                        <button class="button secondary small w-auto" onclick="exportGradeBook('csv')">CSV Export</button>
                        <button class="button secondary small w-auto" onclick="exportGradeBook('pdf')">PDF Report</button>
                    </div>
                </div>
                <div class="grid-4 mt-20 gap-10">
                    <div>
                        <label class="small bold">Course</label>
                        <select id="gbCourseSelect" class="m-0">
                            <option value="">All My Courses</option>
                            ${courses.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label class="small bold">Type</label>
                        <select id="gbTypeSelect" class="m-0">
                            <option value="all">All</option>
                            <option value="assignments">Assignments</option>
                            <option value="quizzes">Quizzes</option>
                        </select>
                    </div>
                    <div id="gbAssessmentFilterContainer">
                        <label class="small bold">Specific Assessment</label>
                        <select id="gbAssessmentSelect" class="m-0">
                            <option value="">All</option>
                        </select>
                    </div>
                    <div>
                        <label class="small bold">Student</label>
                        <input type="text" id="gbStudentSearch" placeholder="Name or email..." class="m-0">
                    </div>
                </div>
            </div>
            <div id="gradeBookArea" class="mt-20"></div>
        `;

        TeacherState.gradeBookRawData = { courses, assignments, quizzes };

        // Helper to update specific assessment dropdown
        const updateAssessmentDropdown = () => {
            const courseId = document.getElementById('gbCourseSelect').value;
            const type = document.getElementById('gbTypeSelect').value;
            const select = document.getElementById('gbAssessmentSelect');
            if (!select) return;

            let filtered = [];
            if (type === 'assignments' || type === 'all') {
                filtered = filtered.concat(assignments.filter(a => (!courseId || a.course_id === courseId) && a.status === 'published').map(a => ({ id: a.id, title: '📝 ' + a.title })));
            }
            if (type === 'quizzes' || type === 'all') {
                filtered = filtered.concat(quizzes.filter(q => (!courseId || q.course_id === courseId) && q.status === 'published').map(q => ({ id: q.id, title: '❓ ' + q.title })));
            }

            select.innerHTML = '<option value="">All Assessments</option>' +
                filtered.map(item => `<option value="${item.id}">${escapeHtml(item.title)}</option>`).join('');
        };

        const courseSelect = document.getElementById('gbCourseSelect');
        const typeSelect = document.getElementById('gbTypeSelect');
        const assessmentSelect = document.getElementById('gbAssessmentSelect');
        const searchInput = document.getElementById('gbStudentSearch');

        courseSelect.addEventListener('change', () => {
            updateAssessmentDropdown();
            filterGradeBook();
        });
        typeSelect.addEventListener('change', () => {
            updateAssessmentDropdown();
            filterGradeBook();
        });
        assessmentSelect.addEventListener('change', () => filterGradeBook());

        if (searchInput) {
            searchInput.addEventListener('input', debounce(() => {
                filterGradeBook();
            }, 500));
        }

        updateAssessmentDropdown();
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

/**
 * Calculates grade book data by processing raw datasets into a display-ready format.
 * Optimized for performance using Map-based lookups to handle large datasets.
 */
function calculateGradeBookData(rawData, filters = {}) {
    const {
        courses = [],
        assignments = [],
        quizzes = [],
        submissions = [],
        quizSubs = [],
        enrollments = []
    } = rawData || {};
    const { courseId = '', typeFilter = 'all', assessmentId = '', studentSearch = '' } = filters;
    const search = (studentSearch || '').toLowerCase();

    // 1. Index submissions and quiz attempts for O(1) lookup performance
    const submissionMap = new Map();
    (submissions || []).forEach(s => {
        const key = `${s.student_email}_${s.assignment_id}`;
        submissionMap.set(key, s);
    });

    const quizSubMap = new Map();
    (quizSubs || []).forEach(s => {
        const key = `${s.student_email}_${s.quiz_id}`;
        if (!quizSubMap.has(key)) quizSubMap.set(key, []);
        quizSubMap.get(key).push(s);
    });

    let filteredCourses = courseId ? courses.filter(c => c.id === courseId) : courses;

    return filteredCourses.map(course => {
        const showAssignments = typeFilter === 'all' || typeFilter === 'assignments';
        const showQuizzes = typeFilter === 'all' || typeFilter === 'quizzes';

        let courseAssigns = showAssignments ? assignments.filter(a => a.course_id === course.id && a.status === 'published') : [];
        let courseQuizzes = showQuizzes ? quizzes.filter(q => q.course_id === course.id && q.status === 'published') : [];

        if (assessmentId) {
            courseAssigns = courseAssigns.filter(a => a.id === assessmentId);
            courseQuizzes = courseQuizzes.filter(q => q.id === assessmentId);
        }

        const courseEnrollments = (enrollments || []).filter(e => {
            if (e.course_id !== course.id) return false;
            if (!search) return true;
            const name = (e.users?.full_name || '').toLowerCase();
            const email = (e.student_email || '').toLowerCase();
            return name.includes(search) || email.includes(search);
        }).sort((a, b) => (a.users?.full_name || 'Z').localeCompare(b.users?.full_name || 'Z'));

        const students = courseEnrollments.map(e => {
            const email = e.student_email;
            const fullName = e.users?.full_name || 'N/A';
            let earnedPoints = 0;
            let itemsCount = 0;

            const assignmentGrades = courseAssigns.map(a => {
                const sub = submissionMap.get(`${email}_${a.id}`);
                let status = 'not_submitted';
                let grade = null;
                let rawScore = null;
                let pointsPossible = a.points_possible;
                let displayStatus = '-';

                if (sub) {
                    if (sub.status === 'graded') {
                        status = 'graded';
                        grade = sub.final_grade;
                        rawScore = sub.grade;
                        earnedPoints += (grade || 0);
                        itemsCount++;
                        displayStatus = `${grade}%`;
                    } else if (sub.status === 'submitted') {
                        status = 'pending';
                        displayStatus = 'Pending';
                    } else if (sub.status === 'draft') {
                        status = 'draft';
                        displayStatus = 'Draft';
                    } else if (sub.status === 'returned') {
                        status = 'returned';
                        displayStatus = 'Returned';
                    }

                    if (sub.regrade_request) {
                        status = 'regrade';
                        displayStatus = 'Regrade Req';
                    }

                    const dueDate = new Date(a.due_date);
                    const subDate = new Date(sub.submitted_at);
                    if (subDate > dueDate) {
                        status += '_late';
                    }
                }

                return {
                    id: a.id,
                    title: a.title,
                    status,
                    grade,
                    rawScore,
                    pointsPossible,
                    displayStatus,
                    isLate: status.includes('_late')
                };
            });

            const quizGrades = courseQuizzes.map(q => {
                const allAttempts = quizSubMap.get(`${email}_${q.id}`) || [];
                const submittedAttempts = allAttempts.filter(s => s.status === 'submitted');
                const inProgressAttempts = allAttempts.filter(s => s.status === 'in-progress');

                const bestSub = submittedAttempts.sort((a, b) => (b.score || 0) - (a.score || 0))[0];

                let status = 'not_started';
                let grade = null;
                let rawScore = null;
                let pointsPossible = null;
                let displayStatus = '-';

                if (bestSub) {
                    status = 'submitted';
                    grade = bestSub.score;
                    rawScore = Math.round(((bestSub.score || 0) / 100) * (bestSub.total_points || 0));
                    pointsPossible = bestSub.total_points;
                    earnedPoints += (grade || 0);
                    itemsCount++;
                    displayStatus = `${grade}%`;
                } else if (inProgressAttempts.length > 0) {
                    status = 'in_progress';
                    displayStatus = 'In Progress';
                }

                return { id: q.id, title: q.title, status, grade, rawScore, pointsPossible, displayStatus };
            });

            const average = itemsCount > 0 ? Math.round(earnedPoints / itemsCount) : null;

            return {
                email,
                fullName,
                assignmentGrades,
                quizGrades,
                average
            };
        });

        return {
            id: course.id,
            title: course.title,
            assignmentCount: courseAssigns.length,
            quizCount: courseQuizzes.length,
            studentCount: courseEnrollments.length,
            students
        };
    });
}

async function exportGradeBook(type) {
    if (!TeacherState.gradeBookRawData) return UI.showNotification('Grade Book not initialized', 'warn');

    UI.showNotification('Preparing export data...', 'info');

    try {
        const user = await SessionManager.getCurrentUser();
        const filters = {
            courseId: document.getElementById('gbCourseSelect')?.value || '',
            typeFilter: document.getElementById('gbTypeSelect')?.value || 'all',
            assessmentId: document.getElementById('gbAssessmentSelect')?.value || '',
            studentSearch: document.getElementById('gbStudentSearch')?.value || ''
        };

        const aid = filters.assessmentId;
        const cid = filters.courseId;
        const searchTerm = filters.studentSearch;
        const teacherEmail = user.email;

        const isQuiz = aid && (TeacherState.gradeBookRawData.quizzes || []).some(q => q.id === aid);
        const isAssign = aid && (TeacherState.gradeBookRawData.assignments || []).some(a => a.id === aid);

        const myCourseIds = cid ? [cid] : (TeacherState.gradeBookRawData.courses || []).map(c => c.id);
        if (myCourseIds.length === 0) return UI.showNotification('No courses found to export', 'warn');

        const [subsRes, quizSubsRes, enrollRes] = await Promise.all([
            ((filters.typeFilter === 'all' || filters.typeFilter === 'assignments') && (!aid || isAssign)) ?
                SupabaseDB.getSubmissions(isAssign ? aid : null, null, teacherEmail, { courseId: cid, searchTerm, all: true }) :
                Promise.resolve({ data: [] }),
            ((filters.typeFilter === 'all' || filters.typeFilter === 'quizzes') && (!aid || isQuiz)) ?
                SupabaseDB.getQuizSubmissions(isQuiz ? aid : null, null, teacherEmail, { courseId: cid, searchTerm, all: true }) :
                Promise.resolve({ data: [] }),
            SupabaseDB.getEnrollmentsByCourses(myCourseIds, { searchTerm, all: true })
        ]);

        const rawData = {
            ...TeacherState.gradeBookRawData,
            submissions: subsRes?.data || [],
            quizSubs: quizSubsRes?.data || [],
            enrollments: enrollRes?.data || []
        };

        const exportData = calculateGradeBookData(rawData, filters);

        let allHeaders = ['Course', 'Student', 'Type', 'Title', 'Grade', 'Late', 'Raw Score', 'Max Points', 'Course Avg'];
        let allRows = [];

        exportData.forEach(course => {
            course.students.forEach(student => {
                const courseAvg = student.average !== null ? student.average + '%' : '-';
                student.assignmentGrades.forEach(ag => {
                    allRows.push([
                        course.title,
                        student.email,
                        'Assignment',
                        ag.title,
                        ag.displayStatus,
                        ag.isLate ? 'YES' : 'No',
                        ag.rawScore !== null ? ag.rawScore : '-',
                        ag.pointsPossible,
                        courseAvg
                    ]);
                });
                student.quizGrades.forEach(qg => {
                    allRows.push([
                        course.title,
                        student.email,
                        'Quiz',
                        qg.title,
                        qg.displayStatus,
                        '-', // No late submissions for quizzes
                        qg.rawScore !== null ? qg.rawScore : '-',
                        qg.pointsPossible !== null ? qg.pointsPossible : '-',
                        courseAvg
                    ]);
                });
            });
        });

        if (allRows.length === 0) return UI.showNotification('No grades to export', 'warn');

        if (type === 'csv') {
            Exporter.csv('gradebook_export.csv', allHeaders, allRows);
        } else {
            await Exporter.pdf('gradebook_export.pdf', 'Detailed Grade Book Report', allHeaders, allRows);
        }
    } catch (error) {
        console.error('Export error:', error);
        UI.showNotification('Error preparing export: ' + error.message, 'error');
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
        DiscussionManager.cleanup();
        if (page !== 'anticheat') {
            if (TeacherState._liveProctoringInterval) {
                clearInterval(TeacherState._liveProctoringInterval);
                TeacherState._liveProctoringInterval = null;
            }
            if (TeacherState._liveViolationsChannel) {
                window.supabaseClient?.removeChannel(TeacherState._liveViolationsChannel);
                TeacherState._liveViolationsChannel = null;
            }
        }
        if(page === 'dashboard') renderDashboard();
        else if(page === 'courses') renderCourses();
        else if(page === 'materials') renderMaterials();
        else if(page === 'assignments') renderAssignments();
        else if(page === 'grading') renderGrading();
        else if(page === 'gradebook') renderGradeBook();
        else if(page === 'analytics') renderAnalytics();
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
                      <button class="button secondary tiny" style="background: #ecfdf5; color: #065f46; border-color: #a7f3d0" onclick="indexMaterialForAI('${escapeAttr(m.id)}', '${escapeAttr(m.course_id)}')">Index for AI</button>
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
  const renderId = ++window.currentRenderId;
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
    try {
        const searchTerm = document.getElementById('studentSearch')?.value || '';
        const courseFilter = document.getElementById('courseFilter')?.value || '';
        const targetCourseIds = courseFilter ? [courseFilter] : TeacherState.myCourseIds;

        const { data: allEnrollments } = await SupabaseDB.getEnrollmentsByCourses(targetCourseIds, {
            searchTerm,
            all: true
        });

        const students = (allEnrollments || []).map(e => ({
            full_name: e.users?.full_name || 'N/A',
            email: e.student_email,
            course_title: e.courses?.title || 'Unknown'
        })).filter(s => s.email);

        const headers = ['Name', 'Email', 'Course'];
        const rows = students.map(s => [s.full_name, s.email, s.course_title]);

        if (type === 'csv') {
            Exporter.csv('students_list.csv', headers, rows);
        } else {
            await Exporter.pdf('students_list.pdf', 'Enrolled Students List', headers, rows);
        }
    } catch (error) {
        console.error('Export error:', error);
        UI.showNotification('Failed to export students: ' + error.message, 'error');
    }
}

async function filterGradeBook(page = 1) {
    const area = document.getElementById('gradeBookArea');
    if (!area) return;

    // Safety check to ensure we are still on the Grade Book page before starting a new authoritative render
    if (!document.getElementById('gbCourseSelect')) return;

    const renderId = ++window.currentRenderId;
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId || !document.getElementById('gradeBookArea')) return;

    try {
        const filters = {
            courseId: document.getElementById('gbCourseSelect')?.value || '',
            typeFilter: document.getElementById('gbTypeSelect')?.value || 'all',
            assessmentId: document.getElementById('gbAssessmentSelect')?.value || '',
            studentSearch: document.getElementById('gbStudentSearch')?.value || ''
        };
        const pageSize = 20;

        area.innerHTML = '<div class="flex-center p-40"><div class="loading-spinner"></div></div>';

        const type = filters.typeFilter;
        const aid = filters.assessmentId;
        const cid = filters.courseId;
        const searchTerm = filters.studentSearch;
        const teacherEmail = user.email;

        // Ensure raw data is available
        if (!TeacherState.gradeBookRawData) return;

        // Optimization: identify if selected assessment is quiz or assignment upfront
        const isQuiz = aid && (TeacherState.gradeBookRawData.quizzes || []).some(q => q.id === aid);
        const isAssign = aid && (TeacherState.gradeBookRawData.assignments || []).some(a => a.id === aid);

        // Phase 1: Get Paginated Enrollments
        const myCourseIds = cid ? [cid] : (TeacherState.gradeBookRawData.courses || []).map(c => c.id);
        let enrollRes = { data: [], total: 0 };
        if (myCourseIds.length > 0) {
            enrollRes = await SupabaseDB.getEnrollmentsByCourses(myCourseIds, { searchTerm, page, pageSize });
        }
        if (renderId !== window.currentRenderId || !document.getElementById('gradeBookArea')) return;

        const studentEmails = (enrollRes.data || []).map(e => e.student_email);

        // Phase 2: Get Submissions for these students only
        const fetchTasks = [];

        // 1. Submissions (Assignments)
        if (studentEmails.length > 0 && (type === 'all' || type === 'assignments') && (!aid || isAssign)) {
            fetchTasks.push(SupabaseDB.getSubmissions(
                isAssign ? aid : null,
                null,
                teacherEmail,
                { courseId: cid, searchTerm, studentEmails, all: true }
            ));
        } else {
            fetchTasks.push(Promise.resolve({ data: [], total: 0 }));
        }

        // 2. Quiz Submissions
        if (studentEmails.length > 0 && (type === 'all' || type === 'quizzes') && (!aid || isQuiz)) {
            fetchTasks.push(SupabaseDB.getQuizSubmissions(
                isQuiz ? aid : null,
                null,
                teacherEmail,
                { courseId: cid, searchTerm, studentEmails, all: true }
            ));
        } else {
            fetchTasks.push(Promise.resolve({ data: [], total: 0 }));
        }

        const [subsRes, quizSubsRes] = await Promise.all(fetchTasks);
        if (renderId !== window.currentRenderId || !document.getElementById('gradeBookArea')) return;

        const rawData = {
            ...TeacherState.gradeBookRawData,
            submissions: subsRes?.data || [],
            quizSubs: quizSubsRes?.data || [],
            enrollments: enrollRes?.data || []
        };

        const data = calculateGradeBookData(rawData, filters);
        TeacherState.currentGradeBookData = data;

        let html = '';
        const hasStudents = data.some(c => c.studentCount > 0);

        if (!hasStudents) {
            html = `<div class="empty">No students found ${searchTerm ? 'matching "' + escapeHtml(searchTerm) + '"' : 'enrolled'} on this page.</div>`;
        } else {
            data.forEach(course => {
                if (course.studentCount === 0) return;

                if (course.assignmentCount === 0 && course.quizCount === 0) {
                     html += `<div class="card mb-20"><h3>${escapeHtml(course.title)}</h3><p class="empty small">No published assessments to display for this filter.</p></div>`;
                     return;
                }

            html += `
                <div class="card mb-20 animate-fade-in" style="padding:0; overflow:hidden">
                    <div class="p-15" style="background:var(--bg)">
                        <h3 class="m-0">${escapeHtml(course.title)}</h3>
                        <p class="tiny text-muted m-0">${course.studentCount} Students shown from ${enrollRes.total} Total | ${course.assignmentCount} Assignments | ${course.quizCount} Quizzes</p>
                    </div>
                    <div style="overflow-x:auto">
                        <table class="m-0">
                            <thead>
                                <tr>
                                    <th style="min-width:200px">Student</th>
                                    ${course.students[0]?.assignmentGrades.map(ag => `<th class="text-center" style="min-width:120px" title="${escapeAttr(ag.title)}">📝 ${escapeHtml(ag.title.substring(0,15))}${ag.title.length > 15 ? '...' : ''}</th>`).join('') || ''}
                                    ${course.students[0]?.quizGrades.map(qg => `<th class="text-center" style="min-width:120px" title="${escapeAttr(qg.title)}">❓ ${escapeHtml(qg.title.substring(0,15))}${qg.title.length > 15 ? '...' : ''}</th>`).join('') || ''}
                                    <th class="text-center" style="min-width:100px; background:#f8fafc">Course Avg</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${course.students.map(s => {
                                    const assignmentCells = s.assignmentGrades.map(ag => {
                                        let badgeClass = 'badge-inactive';
                                        if (ag.status === 'graded') badgeClass = ag.grade >= 70 ? 'badge-active' : 'badge-warn';
                                        else if (ag.status === 'pending' || ag.status === 'pending_late') badgeClass = 'badge-purple';
                                        else if (ag.status === 'regrade' || ag.status === 'regrade_late') badgeClass = 'badge-warn';
                                        else if (ag.status === 'draft') badgeClass = 'badge-inactive';
                                        else if (ag.status === 'returned') badgeClass = 'badge-warn';

                                        return `
                                            <td class="text-center">
                                                <span class="badge ${badgeClass}">${ag.displayStatus}</span>
                                                ${ag.isLate ? '<div class="tiny danger-text bold">LATE</div>' : ''}
                                                ${ag.rawScore !== null ? `<div class="tiny text-muted mt-5">${ag.rawScore} / ${ag.pointsPossible}</div>` : ''}
                                            </td>`;
                                    }).join('');

                                    const quizCells = s.quizGrades.map(qg => {
                                        let badgeClass = 'badge-inactive';
                                        if (qg.status === 'submitted') badgeClass = qg.grade >= 70 ? 'badge-active' : 'badge-warn';
                                        else if (qg.status === 'in_progress') badgeClass = 'badge-warn';

                                        return `
                                            <td class="text-center">
                                                <span class="badge ${badgeClass}">${qg.displayStatus}</span>
                                                ${qg.rawScore !== null ? `<div class="tiny text-muted mt-5">${qg.rawScore} / ${qg.pointsPossible}</div>` : ''}
                                            </td>`;
                                    }).join('');

                                    const avgColorClass = s.average === null ? 'text-muted' : (s.average >= 70 ? 'success-text' : 'danger-text');
                                    return `
                                        <tr>
                                            <td>
                                                <div class="bold small">${escapeHtml(s.fullName)}</div>
                                                <div class="tiny text-muted">${escapeHtml(s.email)}</div>
                                            </td>
                                            ${assignmentCells}
                                            ${quizCells}
                                            <td class="text-center" style="background:#f8fafc"><strong class="${avgColorClass}">${s.average !== null ? s.average + '%' : '-'}</strong></td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
            });
        }

        if (renderId !== window.currentRenderId) return;
        area.innerHTML = html;

        // Add pagination controls
        const paginationContainer = document.createElement('div');
        paginationContainer.id = 'gbPagination';
        area.appendChild(paginationContainer);
        UI.renderPagination('gbPagination', enrollRes.total, page, pageSize, (p) => filterGradeBook(p));

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
window.renderAnalytics = renderAnalytics;
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
window.openAIGradingAssistant = openAIGradingAssistant;
window.updateAssignmentTotalPoints = updateAssignmentTotalPoints;
window.openAIQuizGenerator = openAIQuizGenerator;
window.openAIAssignmentGenerator = openAIAssignmentGenerator;
window.indexCourseForAI = indexCourseForAI;
window.indexMaterialForAI = indexMaterialForAI;

async function indexMaterialForAI(materialId, courseId) {
    const optionsHtml = `
      <div style="text-align: left; margin-top: 15px; background: #f8fafc; padding: 15px; border-radius: 12px; border: 1px solid #e2e8f0; box-shadow: inset 0 1px 3px rgba(0,0,0,0.02)">
        <strong style="color: var(--p, #5b2ea6); font-size: 0.9rem; display: block; margin-bottom: 5px;">Document Chunking Structure Options:</strong>
        <p class="small text-muted mt-5 mb-15" style="font-size: 0.75rem; margin-bottom: 15px; line-height: 1.4;">Select which structural divisions inside the PDF are used to segment content into separate rows & embeddings:</p>
        <div class="flex flex-column gap-10" style="display: flex; flex-direction: column; gap: 10px;">
          <label class="flex gap-10 align-items-center" style="font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 0.85rem; padding: 6px 10px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px; transition: background 0.2s, border-color 0.2s;">
            <input type="checkbox" id="optChapters" checked style="margin: 0; width: 16px; height: 16px; cursor: pointer;"> Chapters (Chapter 1, Chapter II...)
          </label>
          <label class="flex gap-10 align-items-center" style="font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 0.85rem; padding: 6px 10px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px; transition: background 0.2s, border-color 0.2s;">
            <input type="checkbox" id="optSections" checked style="margin: 0; width: 16px; height: 16px; cursor: pointer;"> Sections (Section A, Section 2...)
          </label>
          <label class="flex gap-10 align-items-center" style="font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 0.85rem; padding: 6px 10px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px; transition: background 0.2s, border-color 0.2s;">
            <input type="checkbox" id="optTopics" checked style="margin: 0; width: 16px; height: 16px; cursor: pointer;"> Topics (Topic 1, Topic B...)
          </label>
          <label class="flex gap-10 align-items-center" style="font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 0.85rem; padding: 6px 10px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px; transition: background 0.2s, border-color 0.2s;">
            <input type="checkbox" id="optWeeks" checked style="margin: 0; width: 16px; height: 16px; cursor: pointer;"> Weeks (Week 1, Week 2...)
          </label>
          <label class="flex gap-10 align-items-center" style="font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 0.85rem; padding: 6px 10px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px; transition: background 0.2s, border-color 0.2s;">
            <input type="checkbox" id="optLessons" checked style="margin: 0; width: 16px; height: 16px; cursor: pointer;"> Lessons (Lesson 1, Lesson A...)
          </label>
          <label class="flex gap-10 align-items-center" style="font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 0.85rem; padding: 6px 10px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px; transition: background 0.2s, border-color 0.2s;">
            <input type="checkbox" id="optOther" style="margin: 0; width: 16px; height: 16px; cursor: pointer;" onchange="document.getElementById('otherInputContainer').style.display = this.checked ? 'block' : 'none'"> Other (Custom structural division)
          </label>
          <div id="otherInputContainer" style="display: none; margin-top: 5px; padding-left: 10px;">
            <input type="text" id="txtOtherStructure" placeholder="e.g. Appendix, Annex, Part, Unit" style="margin: 0; padding: 8px 12px; font-size: 0.85rem; border-radius: 6px; border: 1px solid #cbd5e1; width: 100%; box-sizing: border-box;">
          </div>
        </div>
      </div>
    `;

    let chunk_options = [];
    const preConfirm = (backdrop) => {
        chunk_options = [];
        const optChapters = backdrop.querySelector('#optChapters')?.checked;
        const optSections = backdrop.querySelector('#optSections')?.checked;
        const optTopics = backdrop.querySelector('#optTopics')?.checked;
        const optWeeks = backdrop.querySelector('#optWeeks')?.checked;
        const optLessons = backdrop.querySelector('#optLessons')?.checked;
        const optOther = backdrop.querySelector('#optOther')?.checked;
        const txtOther = backdrop.querySelector('#txtOtherStructure')?.value.trim();

        if (optChapters) chunk_options.push('chapter', 'chapters');
        if (optSections) chunk_options.push('section', 'sections');
        if (optTopics) chunk_options.push('topic', 'topics');
        if (optWeeks) chunk_options.push('week', 'weeks');
        if (optLessons) chunk_options.push('lesson', 'lessons');

        if (optOther) {
            if (!txtOther) {
                UI.showNotification('Please specify the preferred custom structure for "Other".', 'warn');
                return false; // Prevent closing
            }
            const lowerOther = txtOther.toLowerCase();
            chunk_options.push(lowerOther);
            if (!lowerOther.endsWith('s')) {
                chunk_options.push(lowerOther + 's');
            }
        }

        if (chunk_options.length === 0) {
            UI.showNotification('You must select at least one document structure option.', 'warn');
            return false; // Prevent closing
        }

        return true; // Dismiss modal
    };

    if (!await UI.confirm(`Would you like to dynamically extract, segment, and index this material for the AI Tutor?${optionsHtml}`, 'Index Material for AI Tutor', true, 'Confirm & Index', 'button', preConfirm)) return;

    UI.showNotification('Extracting and embedding PDF with custom structural boundaries. This may take a few moments...', 'info');
    try {
        const result = await AIManager.indexCourse(courseId, chunk_options, materialId);
        UI.showNotification(result.message || 'Successfully indexed file/material with selected structures!', 'success');
    } catch (e) {
        console.error(e);
        UI.showNotification('Indexing failed: ' + e.message, 'error');
    }
}

async function indexCourseForAI(courseId) {
    if (!await UI.confirm('This will process all course lessons and materials to populate the AI Tutor\'s knowledge base. This may take a few moments. Continue?', 'Index Course for AI')) return;

    const btn = document.querySelector('button[onclick*="indexCourseForAI"]');
    const originalText = btn.textContent;
    btn.disabled = true; btn.textContent = '⚡ Indexing...';

    try {
        const result = await AIManager.indexCourse(courseId);
        UI.showNotification(result.message || 'Course indexed successfully!', 'success');
    } catch (e) {
        console.error(e);
        UI.showNotification('Indexing failed: ' + e.message, 'error');
    } finally {
        btn.disabled = false; btn.textContent = originalText;
    }
}

async function openAIQuizGenerator(courseId = null) {
    let topics = [];
    let lessons = [];
    if (courseId) {
        UI.showNotification('Loading course topics and lessons...', 'info');
        try {
            const [topicRes, lessonRes] = await Promise.all([
                SupabaseDB.getTopics(courseId),
                SupabaseDB.getLessons(courseId)
            ]);
            topics = topicRes.data || [];
            lessons = lessonRes.data || [];
        } catch (e) {
            console.error('Failed to load topics or lessons:', e);
            UI.showNotification('Failed to load topics/lessons for filtering.', 'warn');
        }
    }

    const defaultQuizRubric = `1. Alignment: Align questions with core definitions, equations, and concepts of the selected topic/lesson.
2. Clarity & Precision: Avoid ambiguous or overly simple phrasing, double negatives, and tricky wordings.
3. Realistic Distractors: Provide plausible alternative options for multiple-choice questions.
4. Levels of Assessment: Ensure questions cover appropriate cognitive levels.`;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.display = 'flex';
    backdrop.innerHTML = `
        <div class="modal" style="max-width: 550px">
            <div class="flex-between mb-20">
                <h3 class="m-0">AI Quiz Generator</h3>
                <button class="button secondary tiny w-auto" onclick="this.closest('.modal-backdrop').remove()">✕</button>
            </div>
            <div class="flex-column gap-15">
                ${courseId ? `
                <div>
                    <label class="small bold">Select Course Topic (Optional)</label>
                    <select id="aiQuizTopicSelect" class="m-0">
                        <option value="">-- All Topics --</option>
                        ${topics.map(t => `<option value="${_safeEscapeAttr(t.id)}" data-title="${_safeEscapeAttr(t.title)}">${_safeEscapeHtml(t.title)}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label class="small bold">Select Lesson for Context (Optional)</label>
                    <select id="aiQuizLessonSelect" class="m-0">
                        <option value="">-- No Specific Lesson (Full Topic/Course) --</option>
                        ${lessons.map(l => `<option value="${_safeEscapeAttr(l.id)}" data-topic="${_safeEscapeAttr(l.topic_id || '')}" data-title="${_safeEscapeAttr(l.title)}">${_safeEscapeHtml(l.title)}</option>`).join('')}
                    </select>
                </div>
                ` : ''}
                <div>
                    <label class="small bold">Topic / Learning Objective</label>
                    <input type="text" id="aiQuizTopic" placeholder="e.g. Photosynthesis, World War II" class="m-0">
                </div>
                <div>
                    <label class="small bold">Rules / Rubrics (Teacher Editable)</label>
                    <textarea id="aiQuizRubrics" rows="3" class="m-0" placeholder="e.g. Focus on key definitions and practical application">${_safeEscapeHtml(defaultQuizRubric)}</textarea>
                </div>
                <div class="grid-2 gap-10">
                    <div>
                        <label class="small bold">Count</label>
                        <input type="number" id="aiQuizCount" value="5" min="1" max="20" class="m-0">
                    </div>
                    <div>
                        <label class="small bold">Difficulty</label>
                        <select id="aiQuizDifficulty" class="m-0">
                            <option value="Beginner">Beginner</option>
                            <option value="Intermediate" selected>Intermediate</option>
                            <option value="Advanced">Advanced</option>
                        </select>
                    </div>
                </div>
                <button class="button w-auto" id="generateAIQuizBtn">Generate Questions</button>
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);

    const topicSelect = backdrop.querySelector('#aiQuizTopicSelect');
    const lessonSelect = backdrop.querySelector('#aiQuizLessonSelect');
    const topicInput = backdrop.querySelector('#aiQuizTopic');

    if (topicSelect && lessonSelect) {
        topicSelect.addEventListener('change', () => {
            const selectedTopicId = topicSelect.value;
            const selectedTopicTitle = topicSelect.options[topicSelect.selectedIndex]?.dataset.title || '';
            if (selectedTopicTitle) {
                topicInput.value = selectedTopicTitle;
            }

            const options = lessonSelect.querySelectorAll('option');
            options.forEach(opt => {
                const optVal = opt.value;
                if (!optVal) return; // Keep "No Specific Lesson" option
                const optTopic = opt.dataset.topic;
                if (!selectedTopicId || optTopic === selectedTopicId) {
                    opt.style.display = '';
                } else {
                    opt.style.display = 'none';
                }
            });
            lessonSelect.value = '';
        });
    }

    if (lessonSelect) {
        lessonSelect.addEventListener('change', () => {
            const selectedLessonTitle = lessonSelect.options[lessonSelect.selectedIndex]?.dataset.title || '';
            if (selectedLessonTitle && !topicInput.value) {
                topicInput.value = selectedLessonTitle;
            }
        });
    }

    document.getElementById('generateAIQuizBtn').onclick = async () => {
        const topic = document.getElementById('aiQuizTopic').value.trim();
        const count = document.getElementById('aiQuizCount').value;
        const difficulty = document.getElementById('aiQuizDifficulty').value;
        const rubrics = document.getElementById('aiQuizRubrics').value.trim();

        if (!topic) return UI.showNotification('Please enter a topic', 'warn');

        const btn = document.getElementById('generateAIQuizBtn');
        btn.disabled = true; btn.textContent = 'Generating...';

        const selectedLessonId = lessonSelect?.value;
        let lessonTitle = '';
        let lessonContent = '';
        if (selectedLessonId) {
            const selectedLesson = lessons.find(l => l.id === selectedLessonId);
            if (selectedLesson) {
                lessonTitle = selectedLesson.title;
                lessonContent = selectedLesson.content || '';
            }
        }

        try {
            const questions = await AIManager.generateAssessment({
                topic,
                count,
                difficulty,
                type: 'quiz',
                course_id: courseId,
                lesson_title: lessonTitle,
                lesson_content: lessonContent,
                rubrics: rubrics
            });
            questions.forEach(q => addQuizQuestionField(q));
            UI.showNotification(`Successfully generated ${questions.length} questions!`, 'success');
            backdrop.remove();
        } catch (e) {
            console.error(e);
            UI.showNotification('Generation failed. Ensure your prompt results in valid JSON.', 'error');
            btn.disabled = false; btn.textContent = 'Generate Questions';
        }
    };
}

window.applyAIGradingFeedbackFromCache = function() {
    const data = window.currentAIGradingData;
    if (!data) return;

    if (data.isStructured) {
        window.applyAIGradingFeedback(data.overallFeedbackText, data.questionData);
    } else {
        const fb = document.getElementById('feedback');
        if (fb) {
            fb.value += (fb.value ? '\n\n' : '') + 'AI Insight:\n' + data.reportText;
            fb.dispatchEvent(new Event('input', { bubbles: true }));
        }
        UI.showNotification('AI Grading feedback successfully applied!', 'success');
    }
};

window.applyAIGradingFeedback = function(overallFeedback, questionsJsonStr) {
    try {
        let questions = [];
        if (Array.isArray(questionsJsonStr)) {
            questions = questionsJsonStr;
        } else if (typeof questionsJsonStr === 'string') {
            try {
                questions = JSON.parse(decodeURIComponent(questionsJsonStr));
            } catch (e) {
                try {
                    questions = JSON.parse(questionsJsonStr);
                } catch (e2) {
                    console.error('Failed to parse questions JSON:', e2);
                }
            }
        }

        // 1. Populate overall feedback
        const fb = document.getElementById('feedback');
        if (fb) {
            fb.value = overallFeedback;
            fb.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // 2. Populate questions scores and comments
        if (Array.isArray(questions)) {
            questions.forEach(q => {
                const idx = q.question_index;
                if (idx === undefined || idx === null) return;

                // Find score input for this question index
                const scoreInput = document.querySelector(`.q-score-input[data-q-idx="${idx}"]`);
                if (scoreInput) {
                    const max = parseInt(scoreInput.dataset.max) || 0;
                    let val = parseFloat(q.score) || 0;
                    // Clamp
                    val = Math.max(0, Math.min(val, max));
                    scoreInput.value = val;
                    // Dispatch both input and change to trigger auto-calculation listeners
                    scoreInput.dispatchEvent(new Event('input', { bubbles: true }));
                    scoreInput.dispatchEvent(new Event('change', { bubbles: true }));
                    scoreInput.dispatchEvent(new Event('keyup', { bubbles: true }));
                }

                // Find feedback input for this question index
                const feedbackInput = document.querySelector(`.q-feedback-input[data-q-idx="${idx}"]`);
                if (feedbackInput) {
                    feedbackInput.value = q.feedback || '';
                    feedbackInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
        }
        UI.showNotification('AI Grading feedback and scores successfully applied!', 'success');
    } catch (e) {
        console.error('Failed to apply AI Grading feedback:', e);
        UI.showNotification('Failed to apply feedback: ' + e.message, 'error');
    }
};

async function openAIGradingAssistant(assignmentId, studentEmail) {
    const renderId = window.currentRenderId;
    const btn = document.getElementById('aiGradingBtn');
    if (btn) { btn.disabled = true; btn.textContent = '🤖 Analyzing...'; }

    try {
        const [assignment, submission] = await Promise.all([
            SupabaseDB.getAssignment(assignmentId),
            SupabaseDB.getSubmission(assignmentId, studentEmail)
        ]);

        if (renderId !== window.currentRenderId) return;

        // Prepare context for AI
        const studentSubmission = Object.entries(submission.answers).map(([idx, ans]) => {
            return `Q${parseInt(idx)+1}: ${typeof ans === 'object' ? ans.value : ans}`;
        }).join('\n');

        const insight = await AIManager.getGradingInsights({
            assignment_id: assignmentId,
            course_id: assignment.course_id,
            assignment_title: assignment.title,
            student_submission: studentSubmission,
            rubric: assignment.description, // Use description as rubric if specific rubric not available
            questions: assignment.questions.map(q => ({ text: q.text, points: q.points }))
        });

        if (renderId !== window.currentRenderId) return;

        // Parse the insight as JSON (if it is JSON)
        let reportText = insight;
        let overallFeedbackText = '';
        let questionData = [];
        let isStructured = false;

        try {
            const parsed = JSON.parse(insight);
            if (parsed && typeof parsed === 'object') {
                reportText = parsed.report || '';
                overallFeedbackText = parsed.overall_feedback || '';
                questionData = parsed.questions || [];
                isStructured = true;
            }
        } catch (err) {
            // Try extracting using AIManager's robust helper
            try {
                const extracted = AIManager._extractJSON(insight);
                if (extracted && typeof extracted === 'object') {
                    reportText = extracted.report || '';
                    overallFeedbackText = extracted.overall_feedback || '';
                    questionData = extracted.questions || [];
                    isStructured = true;
                }
            } catch (err2) {
                // Not a JSON string - fallback to treating the raw insight as reportText
                reportText = insight;
            }
        }

        // Store current AI grading insight data in memory to completely avoid any quote/character clashing in HTML attributes
        window.currentAIGradingData = {
            reportText: reportText,
            overallFeedbackText: overallFeedbackText,
            questionData: questionData,
            isStructured: isStructured
        };

        const modalBody = `
            <div class="p-10">
                <div class="badge badge-purple mb-10">AI ASSISTANT FEEDBACK</div>
                <div class="small font-markdown-render" style="line-height: 1.6; max-height: 400px; overflow-y: auto; padding: 15px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;">
                    ${AIManager.formatMarkdown(reportText)}
                </div>
                <hr class="my-15">
                <p class="tiny text-muted italic">Note: These insights are generated by AI and should be verified by the teacher before finalizing the grade.</p>
                <div class="flex gap-10 mt-15">
                    <button class="button success small w-auto" onclick="window.applyAIGradingFeedbackFromCache(); this.closest('.modal-backdrop').remove();">Apply Feedback</button>
                    <button class="button secondary small w-auto" onclick="this.closest('.modal-backdrop').remove();">Cancel</button>
                </div>
            </div>
        `;

        UI.showModal('AI Grading Insights', modalBody, { maxWidth: '700px' });

    } catch (e) {
        console.error(e);
        UI.showNotification('AI Grading failed: ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🤖 AI Grading Insight'; }
    }
}

async function openAIAssignmentGenerator(courseId = null) {
    let topics = [];
    let lessons = [];
    if (courseId) {
        UI.showNotification('Loading course topics and lessons...', 'info');
        try {
            const [topicRes, lessonRes] = await Promise.all([
                SupabaseDB.getTopics(courseId),
                SupabaseDB.getLessons(courseId)
            ]);
            topics = topicRes.data || [];
            lessons = lessonRes.data || [];
        } catch (e) {
            console.error('Failed to load topics or lessons:', e);
            UI.showNotification('Failed to load topics/lessons for filtering.', 'warn');
        }
    }

    const defaultAssignRubric = `1. Depth of Inquiry: Prompt critical thinking, analytical reasoning, and practical application.
2. Structure & Formatting: Instruct the student to format with headings, introductions, and clear sections.
3. Technical Rigor: Ensure the response addresses the technical principles and vocabulary of the topic.
4. Supporting Evidence: Instruct the student to support arguments with logical reasoning or citations.`;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.display = 'flex';
    backdrop.innerHTML = `
        <div class="modal" style="max-width: 550px">
            <div class="flex-between mb-20">
                <h3 class="m-0">AI Assignment Generator</h3>
                <button class="button secondary tiny w-auto" onclick="this.closest('.modal-backdrop').remove()">✕</button>
            </div>
            <div class="flex-column gap-15">
                ${courseId ? `
                <div>
                    <label class="small bold">Select Course Topic (Optional)</label>
                    <select id="aiAssignTopicSelect" class="m-0">
                        <option value="">-- All Topics --</option>
                        ${topics.map(t => `<option value="${_safeEscapeAttr(t.id)}" data-title="${_safeEscapeAttr(t.title)}">${_safeEscapeHtml(t.title)}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label class="small bold">Select Lesson for Context (Optional)</label>
                    <select id="aiAssignLessonSelect" class="m-0">
                        <option value="">-- No Specific Lesson (Full Topic/Course) --</option>
                        ${lessons.map(l => `<option value="${_safeEscapeAttr(l.id)}" data-topic="${_safeEscapeAttr(l.topic_id || '')}" data-title="${_safeEscapeAttr(l.title)}">${_safeEscapeHtml(l.title)}</option>`).join('')}
                    </select>
                </div>
                ` : ''}
                <div>
                    <label class="small bold">Topic / Learning Objective</label>
                    <input type="text" id="aiAssignTopic" placeholder="e.g. Critical Analysis of Macbeth" class="m-0">
                </div>
                <div>
                    <label class="small bold">Specific Rubrics / Instructions (Teacher Editable)</label>
                    <textarea id="aiAssignRubrics" placeholder="e.g. Focus on character development, minimum 500 words" rows="4" class="m-0">${_safeEscapeHtml(defaultAssignRubric)}</textarea>
                </div>
                <div class="grid-2 gap-10">
                    <div>
                        <label class="small bold">Questions Count</label>
                        <input type="number" id="aiAssignCount" value="1" min="1" max="10" class="m-0">
                    </div>
                    <div>
                        <label class="small bold">Difficulty</label>
                        <select id="aiAssignDifficulty" class="m-0">
                            <option value="Beginner">Beginner</option>
                            <option value="Intermediate" selected>Intermediate</option>
                            <option value="Advanced">Advanced</option>
                        </select>
                    </div>
                </div>
                <button class="button w-auto" id="generateAIAssignBtn">Generate Assignment Content</button>
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);

    const topicSelect = backdrop.querySelector('#aiAssignTopicSelect');
    const lessonSelect = backdrop.querySelector('#aiAssignLessonSelect');
    const topicInput = backdrop.querySelector('#aiAssignTopic');

    if (topicSelect && lessonSelect) {
        topicSelect.addEventListener('change', () => {
            const selectedTopicId = topicSelect.value;
            const selectedTopicTitle = topicSelect.options[topicSelect.selectedIndex]?.dataset.title || '';
            if (selectedTopicTitle) {
                topicInput.value = selectedTopicTitle;
            }

            const options = lessonSelect.querySelectorAll('option');
            options.forEach(opt => {
                const optVal = opt.value;
                if (!optVal) return; // Keep "No Specific Lesson" option
                const optTopic = opt.dataset.topic;
                if (!selectedTopicId || optTopic === selectedTopicId) {
                    opt.style.display = '';
                } else {
                    opt.style.display = 'none';
                }
            });
            lessonSelect.value = '';
        });
    }

    if (lessonSelect) {
        lessonSelect.addEventListener('change', () => {
            const selectedLessonTitle = lessonSelect.options[lessonSelect.selectedIndex]?.dataset.title || '';
            if (selectedLessonTitle && !topicInput.value) {
                topicInput.value = selectedLessonTitle;
            }
        });
    }

    document.getElementById('generateAIAssignBtn').onclick = async () => {
        const topic = document.getElementById('aiAssignTopic').value.trim();
        const rubrics = document.getElementById('aiAssignRubrics').value.trim();
        const count = document.getElementById('aiAssignCount').value;
        const difficulty = document.getElementById('aiAssignDifficulty').value;

        if (!topic) return UI.showNotification('Please enter a topic', 'warn');

        const btn = document.getElementById('generateAIAssignBtn');
        btn.disabled = true; btn.textContent = 'Generating...';

        const selectedLessonId = lessonSelect?.value;
        let lessonTitle = '';
        let lessonContent = '';
        if (selectedLessonId) {
            const selectedLesson = lessons.find(l => l.id === selectedLessonId);
            if (selectedLesson) {
                lessonTitle = selectedLesson.title;
                lessonContent = selectedLesson.content || '';
            }
        }

        try {
            const questions = await AIManager.generateAssessment({
                topic,
                rubrics,
                count,
                difficulty,
                type: 'assignment',
                course_id: courseId,
                lesson_title: lessonTitle,
                lesson_content: lessonContent
            });
            questions.forEach(q => addQuestionField(q));
            UI.showNotification(`Generated ${questions.length} assignment questions!`, 'success');
            backdrop.remove();
        } catch (e) {
            console.error(e);
            UI.showNotification('Generation failed.', 'error');
            btn.disabled = false; btn.textContent = 'Generate Assignment Content';
        }
    };
}

// Enterprise-grade safety: Ensure escape helpers are available even if core.js load is deferred
const _safeEscapeAttr = (s) => {
    if (typeof window.escapeAttr === 'function') return window.escapeAttr(s);
    if (s === null || s === undefined) return '';
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

const _safeEscapeHtml = (s) => {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

// Export analytics sub-functions to window for HTML event handlers
window.renderAnalyticsDashboard = renderAnalyticsDashboard;
window.renderAnalyticsUI = renderAnalyticsUI;
window.renderAssessmentRows = renderAssessmentRows;
window.renderInterventionRows = renderInterventionRows;
window.initTableInteractivity = initTableInteractivity;
window.renderAnalyticsCharts = renderAnalyticsCharts;
window.renderAttendanceHeatmap = renderAttendanceHeatmap;

window.clearAnalyticsFilters = () => {
    const cs = document.getElementById('analyticsCourseSelect');
    const ss = document.getElementById('analyticsSemesterSelect');
    if (cs) cs.value = '';
    if (ss) ss.value = '';
    if (cs) {
        Array.from(cs.options).forEach(opt => opt.style.display = '');
    }
    renderAnalyticsDashboard('', '');
};

async function renderAnalytics() {
  const renderId = ++window.currentRenderId;
  const content = document.getElementById('pageContent');
  if (!content) return;
  clearActiveCountdowns();

  try {
    const user = await SessionManager.getCurrentUser();
    if (renderId !== window.currentRenderId) return;
    if (!user) {
        console.warn('Analytics: No active session found.');
        return;
    }

    const [{ data: courses }, semesters] = await Promise.all([
      SupabaseDB.getCourses(user.email, null, { all: true }),
      SupabaseDB.getTeacherSemesters(user.email)
    ]);
    if (renderId !== window.currentRenderId) return;

    // Proactive caching for cross-page performance optimization
    TeacherState.myCourses = courses || [];
    TeacherState.myCourseIds = TeacherState.myCourses.map(c => c.id);

    content.innerHTML = `
      <div class="card mb-20 flex-between flex-wrap gap-15">
        <div>
            <h2 class="m-0">Course Analytics & Insights</h2>
            <p class="tiny text-muted mt-5">Enterprise-grade performance monitoring and interventions.</p>
        </div>
        <div class="flex gap-10 flex-wrap">
          <select id="analyticsSemesterSelect" class="m-0" style="width:150px">
            <option value="">All Semesters</option>
            ${(semesters || []).map(s => `<option value="${_safeEscapeAttr(s.semester)}">${_safeEscapeHtml(s.semester)}</option>`).join('')}
          </select>
          <select id="analyticsCourseSelect" class="m-0" style="width:200px">
            <option value="">All My Courses</option>
            ${(courses || []).map(c => `<option value="${_safeEscapeAttr(c.id)}" data-semester="${_safeEscapeAttr(c.semester || '')}">${_safeEscapeHtml(c.title)}</option>`).join('')}
          </select>
          <button class="button secondary w-auto small" onclick="window.clearAnalyticsFilters()" title="Reset Filters">🧹 Clear</button>
          <button class="button secondary w-auto small" onclick="renderAnalyticsDashboard(document.getElementById('analyticsCourseSelect').value, document.getElementById('analyticsSemesterSelect').value, true)" title="Refresh Data">🔄 Refresh</button>
          <div class="flex gap-5 border-left pl-10 ml-5">
              <button class="button secondary w-auto small" onclick="window.exportAnalyticsData('csv')" style="background:#f0fdf4; color:#166534; border-color:#bbf7d0">CSV</button>
              <button class="button secondary w-auto small" onclick="window.exportAnalyticsData('pdf')" style="background:#fef2f2; color:#991b1b; border-color:#fecaca">PDF</button>
          </div>
        </div>
      </div>
      <div id="analyticsDashboard"></div>
    `;

    const courseSelect = document.getElementById('analyticsCourseSelect');
    const semSelect = document.getElementById('analyticsSemesterSelect');

    const updateFilter = () => renderAnalyticsDashboard(courseSelect.value, semSelect.value);

    courseSelect.addEventListener('change', updateFilter);
    semSelect.addEventListener('change', () => {
        // Optionally filter course list by semester
        const selectedSem = semSelect.value;
        Array.from(courseSelect.options).forEach(opt => {
            if (!opt.value) return; // Skip "All"
            const courseSem = opt.dataset.semester;
            opt.style.display = (!selectedSem || courseSem === selectedSem) ? '' : 'none';
        });
        // If current selected course is hidden, reset to All
        if (courseSelect.selectedOptions[0]?.style.display === 'none') {
            courseSelect.value = '';
        }
        updateFilter();
    });

    updateFilter();
  } catch (error) {
    console.error('Analytics Error:', error);
    UI.showNotification('Error loading analytics: ' + error.message, 'error');
  }
}

async function renderAnalyticsDashboard(courseId, semester = null, bypassCache = false) {
  const renderId = ++window.currentRenderId;
  const dashboard = document.getElementById('analyticsDashboard');
  if (!dashboard) return;

  const cacheKey = `${courseId || 'all'}_${semester || 'all'}`;
  const now = Date.now();
  if (!bypassCache && TeacherState.analyticsCache.has(cacheKey)) {
    const cached = TeacherState.analyticsCache.get(cacheKey);
    if (now - cached.timestamp < 300000) { // 5 min cache
      renderAnalyticsUI(cached.data);
      return;
    }
  }

  UI.showLoading('analyticsDashboard', 'Aggregating class insights...');

  try {
    const user = await SessionManager.getCurrentUser();
    if (!user) return;

    if (bypassCache) {
        TeacherState.analyticsCache.delete(cacheKey);
    }

    const [summary, students, assessments, gaps, heatmapData] = await Promise.all([
      SupabaseDB.getCourseAnalyticsSummary(user.email, courseId || null, semester || null),
      SupabaseDB.getStudentPerformanceComparison(courseId || null, semester || null),
      SupabaseDB.getAssessmentPerformanceAnalysis(courseId || null, semester || null),
      SupabaseDB.getLearningGapsAndInterventions(courseId || null, semester || null),
      SupabaseDB.getAttendanceHeatmapData(user.email, courseId || null, semester || null)
    ]);

    if (renderId !== window.currentRenderId) return;

    // Standardize empty data
    const safeSummary = Array.isArray(summary) ? summary : [];
    const safeStudents = Array.isArray(students) ? students : [];
    const safeAssessments = Array.isArray(assessments) ? assessments : [];
    const safeGaps = gaps || { low_performing_students: [], course_average: 0 };
    const safeHeatmap = heatmapData || {};

    let processedData = {
        summary: safeSummary,
        students: safeStudents,
        assessments: safeAssessments,
        gaps: safeGaps,
        heatmapData: safeHeatmap,
        semester,
        courseId
    };

    TeacherState.analyticsCache.set(cacheKey, { data: processedData, timestamp: now });
    TeacherState.lastAnalyticsData = processedData; // Keep reference for exports
    renderAnalyticsUI(processedData);
  } catch (error) {
    console.error('Analytics Dashboard Error:', error);
    dashboard.innerHTML = `
      <div class="card danger-border animate-fade-in">
        <h3 class="danger-text">Error Synchronizing Insights</h3>
        <p class="small text-muted">${escapeHtml(error.message)}</p>
        <button class="button w-auto mt-10" onclick="renderAnalyticsDashboard('${courseId || ''}', '${semester || ''}', true)">Retry Sync</button>
      </div>
    `;
  }
}

function renderAnalyticsUI(data) {
  const dashboard = document.getElementById('analyticsDashboard');
  if (!dashboard) return;

  const { summary, students, assessments, gaps, heatmapData } = data;
  const totalSeats = summary.reduce((sum, c) => sum + (parseInt(c.total_students) || 0), 0);
  const uniqueStudentsCount = new Set(students.map(s => s.email)).size;
  const avgScore = gaps?.course_average || 0;

  dashboard.innerHTML = `
    <div class="stats-grid mb-20 animate-fade-in">
      <div class="stat-card">
        <h4>Active Students</h4>
        <div class="value">${uniqueStudentsCount}</div>
        <div class="tiny text-muted mt-5">${totalSeats} seats across ${summary.length} courses</div>
      </div>
      <div class="stat-card">
        <h4>Avg Performance</h4>
        <div class="value">${parseFloat(avgScore).toFixed(1)}%</div>
        <div class="tiny text-muted mt-5">Global student average</div>
      </div>
      <div class="stat-card warn">
        <h4>At Risk</h4>
        <div class="value">${gaps?.low_performing_students?.length || 0}</div>
        <div class="tiny text-muted mt-5">Needs intervention</div>
      </div>
      <div class="stat-card">
        <h4>Total Assessments</h4>
        <div class="value">${assessments?.length || 0}</div>
        <div class="tiny text-muted mt-5">Published items</div>
      </div>
    </div>

    <div class="card mb-20">
      <div class="flex-between mb-15">
        <h3 class="m-0">Attendance & Activity Heatmap</h3>
        <div class="flex gap-10 tiny text-muted">
            <span>Less</span>
            <div style="width:12px; height:12px; background:#ebedf0; border-radius:2px"></div>
            <div style="width:12px; height:12px; background:#9be9a8; border-radius:2px"></div>
            <div style="width:12px; height:12px; background:#40c463; border-radius:2px"></div>
            <div style="width:12px; height:12px; background:#30a14e; border-radius:2px"></div>
            <div style="width:12px; height:12px; background:#216e39; border-radius:2px"></div>
            <span>More</span>
        </div>
      </div>
      <div id="attendanceHeatmap" class="heatmap-container" style="overflow-x:auto"></div>
    </div>

    <div class="grid-3 gap-20">
      <div class="card">
        <h3>Exam Performance Trends</h3>
        <canvas id="performanceChart" height="250"></canvas>
      </div>
      <div class="card">
        <h3>Grade Distribution</h3>
        <canvas id="distributionChart" height="250"></canvas>
      </div>
      <div class="card">
        <h3>Top Student Profiles</h3>
        <canvas id="studentChart" height="250"></canvas>
      </div>
    </div>

    <div class="grid-2 gap-20 mt-20">
      <div class="card">
        <div class="flex-between flex-wrap gap-10 mb-15">
            <h3 class="m-0">Assessment Breakdown</h3>
            <input type="text" id="assessmentSearch" placeholder="Search assessments..." class="small m-0" style="width:200px">
        </div>
        <div class="p-0 mt-10" style="overflow-x:auto">
          <table>
            <thead>
                <tr>
                    <th class="pointer sortable" data-sort="title">Assessment ↕</th>
                    <th class="pointer sortable" data-sort="type">Type ↕</th>
                    <th class="pointer sortable" data-sort="avg_score">Avg Score ↕</th>
                    <th class="pointer sortable" data-sort="submission_count">Count ↕</th>
                </tr>
            </thead>
            <tbody id="assessmentTableBody">
              ${renderAssessmentRows(assessments)}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="flex-between flex-wrap gap-10 mb-15">
            <h3 class="m-0 danger-text">Intervention Insights</h3>
            <input type="text" id="interventionSearch" placeholder="Search students..." class="small m-0" style="width:200px">
        </div>
        <div class="p-0 mt-10" style="overflow-x:auto">
          <table>
            <thead>
                <tr>
                    <th class="pointer sortable" data-sort="full_name">Student ↕</th>
                    <th class="pointer sortable" data-sort="email">Email ↕</th>
                    <th class="pointer sortable" data-sort="total_avg">Avg ↕</th>
                    <th class="pointer sortable" data-sort="risk_level">Risk ↕</th>
                </tr>
            </thead>
            <tbody id="interventionTableBody">
              ${renderInterventionRows(gaps?.low_performing_students || [])}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="analyticsAIChat" class="mt-20"></div>
  `;

  AIManager.renderChatbot('analyticsAIChat', {
      title: 'Teacher Insights Assistant',
      welcomeMessage: 'Hi! I can help you analyze class performance, identify at-risk students, and suggest teaching interventions based on your course data.',
      onSend: async (msg) => {
          const dataContext = {
              class_summary: summary,
              at_risk_count: gaps?.low_performing_students?.length || 0,
              assessment_performance: assessments.map(a => ({ title: a.title, avg: a.avg_score })),
              top_risk_students: (gaps?.low_performing_students || []).slice(0, 5)
          };
          return await AIManager.analyzeAnalytics(msg, dataContext);
      }
  });

  renderAttendanceHeatmap('attendanceHeatmap', heatmapData);
  renderAnalyticsCharts(students, assessments);
  initTableInteractivity(data);
}

function renderAssessmentRows(items) {
    return (items || []).map(a => `
        <tr>
          <td><div class="bold small">${_safeEscapeHtml(a.title)}</div><div class="tiny text-muted">${_safeEscapeHtml(a.course_title || '')}</div></td>
          <td><span class="badge tiny">${_safeEscapeHtml(a.type ? a.type.toUpperCase() : '')}</span></td>
          <td>${a.avg_score ? parseFloat(a.avg_score).toFixed(1) + '%' : '---'}</td>
          <td>${a.submission_count || 0}</td>
        </tr>
    `).join('') || '<tr><td colspan="4" class="empty">No assessments found.</td></tr>';
}

function renderInterventionRows(items) {
    return (items || []).map(s => `
        <tr>
          <td><div class="bold small">${_safeEscapeHtml(s.full_name)}</div></td>
          <td class="tiny">${_safeEscapeHtml(s.email)}</td>
          <td class="bold ${s.risk_level === 'CRITICAL' ? 'danger-text' : 'warning-text'}">${parseFloat(s.total_avg || 0).toFixed(1)}%</td>
          <td>
            <div class="flex-between gap-10">
                <span class="badge ${s.risk_level === 'CRITICAL' ? 'badge-inactive' : 'badge-warn'}">${_safeEscapeHtml(s.risk_level || 'UNKNOWN')}</span>
                <button class="button secondary tiny w-auto" onclick="window.viewStudentDetails('${_safeEscapeAttr(s.email)}')">View</button>
            </div>
          </td>
        </tr>
    `).join('') || '<tr><td colspan="4" class="empty success-text">All students are performing well.</td></tr>';
}

function initTableInteractivity(data) {
    const assessSearch = document.getElementById('assessmentSearch');
    const interSearch = document.getElementById('interventionSearch');

    const updateAssessTable = () => {
        if (!assessSearch) return;
        const term = assessSearch.value.toLowerCase();
        const filtered = data.assessments.filter(a =>
            a.title.toLowerCase().includes(term) || (a.course_title || '').toLowerCase().includes(term)
        );
        const body = document.getElementById('assessmentTableBody');
        if (body) body.innerHTML = renderAssessmentRows(filtered);
    };

    const updateInterTable = () => {
        if (!interSearch) return;
        const term = interSearch.value.toLowerCase();
        const filtered = (data.gaps?.low_performing_students || []).filter(s =>
            s.full_name.toLowerCase().includes(term) || s.email.toLowerCase().includes(term)
        );
        const body = document.getElementById('interventionTableBody');
        if (body) body.innerHTML = renderInterventionRows(filtered);
    };

    // Remove existing listeners to prevent duplication
    const newAssessSearch = assessSearch.cloneNode(true);
    assessSearch.parentNode.replaceChild(newAssessSearch, assessSearch);
    newAssessSearch.addEventListener('input', debounce(updateAssessTable, 300));

    const newInterSearch = interSearch.cloneNode(true);
    interSearch.parentNode.replaceChild(newInterSearch, interSearch);
    newInterSearch.addEventListener('input', debounce(updateInterTable, 300));

    // Sort logic with hardening
    document.querySelectorAll('.sortable').forEach(th => {
        const newTh = th.cloneNode(true);
        th.parentNode.replaceChild(newTh, th);

        newTh.addEventListener('click', () => {
            const table = newTh.closest('table');
            const tbody = table.querySelector('tbody');
            const tableId = tbody.id;
            const isAssess = tableId === 'assessmentTableBody';
            const prop = newTh.dataset.sort;

            // Get local list reference
            const list = isAssess ? [...data.assessments] : [...(data.gaps?.low_performing_students || [])];

            const ascending = newTh.classList.contains('asc');
            table.querySelectorAll('.sortable').forEach(h => h.classList.remove('asc', 'desc'));

            list.sort((a, b) => {
                let v1 = a[prop], v2 = b[prop];
                if (v1 === null || v1 === undefined) return ascending ? 1 : -1;
                if (v2 === null || v2 === undefined) return ascending ? -1 : 1;

                // Handle mixed numeric strings and numbers
                const n1 = parseFloat(v1), n2 = parseFloat(v2);
                if (!isNaN(n1) && !isNaN(n2)) {
                    return ascending ? (n1 - n2) : (n2 - n1);
                }

                if (typeof v1 === 'string' && typeof v2 === 'string') {
                    return ascending ? v1.localeCompare(v2) : v2.localeCompare(v1);
                }
                return 0;
            });

            newTh.classList.toggle('asc', !ascending);
            newTh.classList.toggle('desc', ascending);

            if (isAssess) {
                const term = newAssessSearch.value.toLowerCase();
                const filtered = list.filter(a =>
                    a.title.toLowerCase().includes(term) || (a.course_title || '').toLowerCase().includes(term)
                );
                tbody.innerHTML = renderAssessmentRows(filtered);
            } else {
                const term = newInterSearch.value.toLowerCase();
                const filtered = list.filter(s =>
                    s.full_name.toLowerCase().includes(term) || s.email.toLowerCase().includes(term)
                );
                tbody.innerHTML = renderInterventionRows(filtered);
            }
        });
    });
}

window.exportAnalyticsData = async (type) => {
    const data = TeacherState.lastAnalyticsData;
    if (!data) return UI.showNotification('No data available to export', 'warn');

    UI.showNotification('Preparing export...', 'info');
    const headers = ['Title', 'Course', 'Type', 'Avg Score %', 'Submission Count'];
    const rows = data.assessments.map(a => [
        a.title,
        a.course_title || 'N/A',
        a.type ? a.type.toUpperCase() : 'N/A',
        a.avg_score ? parseFloat(a.avg_score).toFixed(1) : '0.0',
        a.submission_count || 0
    ]);

    if (type === 'csv') {
        Exporter.csv('teacher_analytics_report.csv', headers, rows);
    } else {
        await Exporter.pdf('teacher_analytics_report.pdf', 'Course Assessment Performance Report', headers, rows);
    }
};

window.viewStudentDetails = async (email) => {
    const renderId = window.currentRenderId;
    const user = await SessionManager.getCurrentUser();

    // Use a lightweight loading indicator for the modal instead of full page reload
    UI.showNotification('Loading student profile...', 'info');

    try {
        const [student, comparison] = await Promise.all([
            SupabaseDB.getUser(email),
            SupabaseDB.getStudentPerformanceComparison()
        ]);

        if (renderId !== window.currentRenderId) return;

        const studentStatsList = (comparison || []).filter(s => s.email === email);
        const studentStats = studentStatsList[0]; // Reference for metadata

        // Aggregate if student is in multiple courses
        const overallAvg = studentStatsList.length > 0
            ? studentStatsList.reduce((sum, s) => sum + (parseFloat(s.overall_average) || 0), 0) / studentStatsList.length
            : 0;

        const { data: violations } = await SupabaseDB.getViolations(null, email, user.email, { all: true });
        const { data: attendance } = await SupabaseDB.getAttendance(null, email, { all: true });

        const modalHtml = `
            <div class="student-details-modal">
                <div class="stats-grid mb-20" style="grid-template-columns: repeat(3, 1fr)">
                    <div class="stat-card">
                        <h4>Overall Average</h4>
                        <div class="value">${overallAvg.toFixed(1)}%</div>
                        <div class="tiny text-muted">Across ${studentStatsList.length} course(s)</div>
                    </div>
                    <div class="stat-card">
                        <h4>Attendance</h4>
                        <div class="value">${attendance.length}</div>
                        <div class="tiny text-muted">Sessions attended</div>
                    </div>
                    <div class="stat-card danger">
                        <h4>Security Alerts</h4>
                        <div class="value">${violations.filter(v => v.severity !== 'INFO').length}</div>
                    </div>
                </div>

                <div class="card mb-20">
                    <h3 class="m-0 mb-15">Category Performance</h3>
                    <div style="height: 250px">
                        <canvas id="studentTrendChart"></canvas>
                    </div>
                </div>

                <div class="card">
                    <h3 class="m-0 mb-15">Recent Activity Log</h3>
                    <div class="p-0" style="max-height: 250px; overflow-y: auto;">
                        <table class="m-0">
                            <thead><tr><th>Activity</th><th>Time</th><th>Details</th></tr></thead>
                            <tbody>
                                ${attendance.slice(0, 10).map(a => `
                                    <tr>
                                        <td><span class="badge badge-active tiny">CLASS</span></td>
                                        <td class="tiny">${new Date(a.join_time).toLocaleString()}</td>
                                        <td class="small">${escapeHtml(a.live_classes?.title || 'Live Session')}</td>
                                    </tr>
                                `).join('') || '<tr><td colspan="3" class="empty">No recent activity found.</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        UI.showModal(`Student Profile: ${student?.full_name || email}`, modalHtml, { maxWidth: '900px' });

        // Render Chart in Modal
        const ctx = document.getElementById('studentTrendChart')?.getContext('2d');
        if (ctx && studentStatsList.length > 0) {
            const labels = studentStatsList.map(s => s.course_title.substring(0, 15) + (s.course_title.length > 15 ? '...' : ''));
            new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Assignments Avg %',
                        data: studentStatsList.map(s => s.avg_assignment_grade || 0),
                        backgroundColor: '#667eea',
                        borderRadius: 4
                    }, {
                        label: 'Quizzes Avg %',
                        data: studentStatsList.map(s => s.avg_quiz_grade || 0),
                        backgroundColor: '#9f7aea',
                        borderRadius: 4
                    }]
                },
                options: {
                    maintainAspectRatio: false,
                    scales: { y: { beginAtZero: true, max: 100 } },
                    plugins: { legend: { display: false } }
                }
            });
        }
    } catch (e) {
        console.error('View Student Error:', e);
        UI.showNotification('Error loading student details: ' + e.message, 'error');
    }
};

function renderAnalyticsCharts(students, assessments) {
  if (typeof Chart === 'undefined') {
      console.warn('Chart.js library not loaded. Analytics visualizations disabled.');
      return;
  }
  const perfCtx = document.getElementById('performanceChart')?.getContext('2d');
  const distCtx = document.getElementById('distributionChart')?.getContext('2d');
  const studCtx = document.getElementById('studentChart')?.getContext('2d');

  if (perfCtx && assessments && assessments.length > 0) {
    new Chart(perfCtx, {
      type: 'line',
      data: {
        labels: assessments.map(a => (a.title || '').substring(0, 12)),
        datasets: [{
          label: 'Avg Score %',
          data: assessments.map(a => a.avg_score || 0),
          borderColor: '#667eea',
          backgroundColor: 'rgba(102, 126, 234, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointHoverRadius: 6
        }]
      },
      options: {
          scales: { y: { beginAtZero: true, max: 100 } },
          plugins: { legend: { display: false } }
      }
    });
  }

  if (distCtx && students) {
      const buckets = { '90-100': 0, '80-89': 0, '70-79': 0, '60-69': 0, '< 60': 0 };
      students.forEach(s => {
          const avg = s.overall_average || 0;
          if (avg >= 90) buckets['90-100']++;
          else if (avg >= 80) buckets['80-89']++;
          else if (avg >= 70) buckets['70-79']++;
          else if (avg >= 60) buckets['60-69']++;
          else buckets['< 60']++;
      });

      new Chart(distCtx, {
          type: 'bar',
          data: {
              labels: Object.keys(buckets),
              datasets: [{
                  label: 'Students',
                  data: Object.values(buckets),
                  backgroundColor: ['#48bb78', '#38b2ac', '#4299e1', '#ed8936', '#f56565'],
                  borderRadius: 4
              }]
          },
          options: {
              plugins: { legend: { display: false } },
              scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
          }
      });
  }

  if (studCtx && students && students.length > 0) {
    const topStudents = [...students].sort((a,b) => (b.overall_average || 0) - (a.overall_average || 0)).slice(0, 5);
    new Chart(studCtx, {
      type: 'radar',
      data: {
        labels: topStudents.map(s => (s.full_name || 'Student').split(' ')[0]),
        datasets: [{
          label: 'Quiz Avg',
          data: topStudents.map(s => s.avg_quiz_grade || 0),
          fill: true,
          backgroundColor: 'rgba(255, 99, 132, 0.2)',
          borderColor: 'rgb(255, 99, 132)',
          pointBackgroundColor: 'rgb(255, 99, 132)'
        }, {
          label: 'Assignment Avg',
          data: topStudents.map(s => s.avg_assignment_grade || 0),
          fill: true,
          backgroundColor: 'rgba(54, 162, 235, 0.2)',
          borderColor: 'rgb(54, 162, 235)',
          pointBackgroundColor: 'rgb(54, 162, 235)'
        }]
      },
      options: { elements: { line: { borderWidth: 3 } } }
    });
  }
}

function renderAttendanceHeatmap(containerId, heatmapData, activeSemester = null) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Detect target year from semester string (e.g., "Fall 2023") or fallback to current year
    const yearMatch = activeSemester ? String(activeSemester).match(/\d{4}/) : null;
    const year = yearMatch ? parseInt(yearMatch[0]) : new Date().getFullYear();

    const startDate = new Date(year, 0, 1);
    // Align to the start of the week (Sunday)
    const startOffset = startDate.getDay();
    const displayStart = new Date(startDate);
    displayStart.setDate(startDate.getDate() - startOffset);

    const endDate = new Date(year, 11, 31);

    let html = `<div class="heatmap-wrapper" style="display: flex; gap: 10px;">
        <div class="heatmap-labels tiny text-muted" style="display: grid; grid-template-rows: repeat(7, 1fr); gap: 3px; padding-top: 15px;">
            <div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
        </div>
        <div class="heatmap-grid" style="display: grid; grid-template-rows: repeat(7, 1fr); grid-auto-flow: column; gap: 3px; overflow-x: auto; padding-bottom: 5px;">`;

    const day = new Date(displayStart);
    // Render 53 weeks to ensure full year coverage
    const totalDays = 53 * 7;
    for (let i = 0; i < totalDays; i++) {
        // Use local date parts to avoid timezone shifts common with toISOString()
        const dateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
        const count = heatmapData[dateStr] || 0;
        const isCurrentYear = day.getFullYear() === year;

        let color = isCurrentYear ? '#ebedf0' : 'transparent';
        if (isCurrentYear && count > 0) {
            if (count > 10) color = '#216e39';
            else if (count > 5) color = '#30a14e';
            else if (count > 2) color = '#40c463';
            else color = '#9be9a8';
        }

        html += `<div class="heatmap-day" title="${isCurrentYear ? dateStr + ': ' + count + ' activities' : ''}"
                     style="width: 12px; height: 12px; background: ${color}; border-radius: 2px; border: ${isCurrentYear ? '1px solid rgba(27,31,35,0.06)' : 'none'}"></div>`;
        day.setDate(day.getDate() + 1);
    }

    html += `</div></div>`;
    container.innerHTML = html;
}

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
