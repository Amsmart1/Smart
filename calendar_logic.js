/**
 * Modern Academic Calendar Logic for SmartLMS
 */

class CalendarManager {
    constructor() {
        this.events = [];
        this.eventMap = {};
        this.currentDate = new Date();
        this.selectedDate = new Date();
        this.viewMode = 'grid'; // 'grid' or 'list'
        this.filter = 'all'; // 'all', 'assignment', 'quiz', 'live', 'planner'
        this.user = null;
    }

    async init() {
        this.user = await SessionManager.getCurrentUser();
        await this.refreshData();
    }

    async refreshData() {
        await this.fetchData();
        this.preprocessEvents();
    }

    async fetchData() {
        if (!this.user) return;

        let assignments = [], liveClasses = [], quizzes = [], plannerItems = [];

        try {
            if (this.user.role === 'teacher') {
                const [aRes, lRes, qRes] = await Promise.all([
                    SupabaseDB.getAssignments(this.user.email, null, null),
                    SupabaseDB.getLiveClasses(null, this.user.email, null),
                    SupabaseDB.getQuizzes(null, this.user.email, null)
                ]);
                assignments = aRes.data || [];
                liveClasses = lRes.data || [];
                quizzes = qRes.data || [];
            } else {
                const enrollRes = await SupabaseDB.getEnrollments(this.user.email);
                const enrollments = enrollRes.data || [];
                const enrolledIds = enrollments.map(e => e.course_id);

                const promises = [SupabaseDB.getPlannerItems(this.user.email)];
                if (enrolledIds.length > 0) {
                    promises.push(SupabaseDB.getAssignments(null, null, enrolledIds));
                    promises.push(SupabaseDB.getLiveClasses(null, null, enrolledIds));
                    promises.push(SupabaseDB.getQuizzes(null, null, enrolledIds));
                } else {
                    promises.push(Promise.resolve({ data: [] }));
                    promises.push(Promise.resolve({ data: [] }));
                    promises.push(Promise.resolve({ data: [] }));
                }

                const results = await Promise.all(promises);
                plannerItems = results[0].data || [];
                assignments = results[1].data || [];
                liveClasses = results[2].data || [];
                quizzes = results[3].data || [];
            }
        } catch (e) {
            console.error("Calendar data fetch error:", e);
        }

        this.events = [];

        // Assignments
        (assignments || []).filter(a => a.status === 'published').forEach(a => {
            this.events.push({
                id: a.id,
                type: 'assignment',
                title: a.title,
                date: new Date(a.due_date),
                original: a
            });
        });

        // Quizzes
        (quizzes || []).filter(q => q.status === 'published').forEach(q => {
            this.events.push({
                id: q.id,
                type: 'quiz',
                title: q.title,
                date: new Date(q.end_at || q.due_date),
                original: q
            });
        });

        // Live Classes
        liveClasses.forEach(lc => {
            this.events.push({
                id: lc.id,
                type: 'live',
                title: lc.title,
                date: new Date(lc.start_at),
                original: lc,
                recurring: lc.recurring_config
            });
        });

        // Planner Items
        plannerItems.forEach(p => {
            this.events.push({
                id: p.id,
                type: 'planner',
                title: p.title,
                date: new Date(p.due_date),
                original: p
            });
        });
    }

    preprocessEvents() {
        const windowStart = new Date(this.currentDate.getFullYear() - 1, 0, 1);
        const windowEnd = new Date(this.currentDate.getFullYear() + 1, 11, 31);

        const allOccurrences = [];
        this.events.forEach(event => {
            if (event.recurring && event.recurring.pattern && event.recurring.pattern !== 'none') {
                allOccurrences.push(...this.generateOccurrences(event, windowStart, windowEnd));
            } else {
                allOccurrences.push(event);
            }
        });

        this.eventMap = {};
        allOccurrences.forEach(event => {
            const key = this.formatDateKey(event.date);
            if (!this.eventMap[key]) this.eventMap[key] = [];
            this.eventMap[key].push(event);
        });
    }

    generateOccurrences(event, start, end) {
        const occurrences = [];
        const config = event.recurring;
        const type = config.recurrenceType || config.pattern;
        let current = new Date(event.date);

        const recurrenceEnd = config.recurrenceEnd ? new Date(config.recurrenceEnd) : (config.endDate ? new Date(config.endDate) : end);
        const actualEnd = new Date(Math.min(recurrenceEnd.getTime(), end.getTime()));

        let count = 0;
        const maxOccurrences = 1000; // Increased limit for daily/weekly expansions

        while (current <= actualEnd && count < maxOccurrences) {
            if (current >= start) {
                let shouldAdd = true;
                if (type === 'weekly' && config.recurrenceDays && Array.isArray(config.recurrenceDays)) {
                    if (!config.recurrenceDays.includes(current.getDay())) {
                        shouldAdd = false;
                    }
                }

                if (shouldAdd) {
                    occurrences.push({
                        ...event,
                        date: new Date(current),
                        isOccurrence: true
                    });
                }
            }

            if (type === 'daily') current.setDate(current.getDate() + 1);
            else if (type === 'weekly') {
                if (config.recurrenceDays && Array.isArray(config.recurrenceDays)) {
                    current.setDate(current.getDate() + 1);
                } else {
                    current.setDate(current.getDate() + 7);
                }
            }
            else if (type === 'monthly') current.setMonth(current.getMonth() + 1);
            else break;

            count++;
        }
        return occurrences;
    }

    formatDateKey(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    getEventsForDate(date) {
        const key = this.formatDateKey(date);
        const events = this.eventMap[key] || [];
        if (this.filter === 'all') return events;
        return events.filter(e => e.type === this.filter);
    }
}

const calendarMgr = new CalendarManager();

async function renderCalendar() {
    const renderId = ++window.currentRenderId;
    const content = document.getElementById('pageContent');
    if (!content) return;
    if (typeof clearActiveCountdowns === 'function') clearActiveCountdowns();

    content.innerHTML = `<div class="flex-center p-40"><div class="bar" style="width:100px; height:4px; background:var(--purple); animation: pulse 1.5s infinite"></div></div>`;

    try {
        await calendarMgr.init();
        if (renderId !== window.currentRenderId) return;
        renderCalendarUI();
    } catch (error) {
        console.error('Calendar error:', error);
        UI.showNotification('Error loading calendar: ' + error.message, 'error');
        content.innerHTML = `<div class="stat-card danger">
            <h3>Error Loading Calendar</h3>
            <div class="small danger-text">${escapeHtml(error.message)}</div>
            <button class="button w-auto mt-10" onclick="renderCalendar()">Retry</button>
        </div>`;
    }
}

function renderCalendarUI() {
    const content = document.getElementById('pageContent');
    if (!content) return;

    content.innerHTML = `
        <div class="calendar-container calendar-animate-fade">
            ${renderCalendarHeader()}
            <div class="calendar-grid-wrapper">
                <div class="calendar-main" id="calendarMain">
                    ${calendarMgr.viewMode === 'grid' ? renderGridView() : renderListView()}
                </div>
                ${renderAgendaSidebar()}
            </div>
        </div>
    `;
}

function renderCalendarHeader() {
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const month = calendarMgr.currentDate.getMonth();
    const year = calendarMgr.currentDate.getFullYear();

    return `
        <div class="calendar-header">
            <div>
                <h2 class="calendar-title">${monthNames[month]} ${year}</h2>
            </div>
            <div class="calendar-controls">
                <button class="button secondary small w-auto" onclick="changeCalendarMonth(0, true)">Today</button>
                <div class="flex gap-5">
                    <button class="button secondary small w-auto" onclick="changeCalendarMonth(-1)">&larr;</button>
                    <button class="button secondary small w-auto" onclick="changeCalendarMonth(1)">&rarr;</button>
                </div>
                <div class="calendar-view-toggles">
                    <button class="view-btn ${calendarMgr.viewMode === 'grid' ? 'active' : ''}" onclick="toggleCalendarView('grid')">Grid</button>
                    <button class="view-btn ${calendarMgr.viewMode === 'list' ? 'active' : ''}" onclick="toggleCalendarView('list')">List</button>
                </div>
                <div class="calendar-filter">
                    <select onchange="filterCalendarEvents(this.value)">
                        <option value="all" ${calendarMgr.filter === 'all' ? 'selected' : ''}>All Events</option>
                        <option value="assignment" ${calendarMgr.filter === 'assignment' ? 'selected' : ''}>Assignments</option>
                        <option value="quiz" ${calendarMgr.filter === 'quiz' ? 'selected' : ''}>Quizzes</option>
                        <option value="live" ${calendarMgr.filter === 'live' ? 'selected' : ''}>Live Classes</option>
                        <option value="planner" ${calendarMgr.filter === 'planner' ? 'selected' : ''}>Planner</option>
                    </select>
                </div>
            </div>
        </div>
    `;
}

function renderGridView() {
    const month = calendarMgr.currentDate.getMonth();
    const year = calendarMgr.currentDate.getFullYear();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    const todayKey = calendarMgr.formatDateKey(today);
    const selectedKey = calendarMgr.formatDateKey(calendarMgr.selectedDate);

    let html = `
        <div class="calendar-grid calendar-animate-slide">
            ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="calendar-day-label">${d}</div>`).join('')}
    `;

    for (let i = 0; i < firstDay; i++) {
        html += `<div class="calendar-cell empty-cell"></div>`;
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const dateKey = calendarMgr.formatDateKey(date);
        const events = calendarMgr.getEventsForDate(date);
        const isToday = dateKey === todayKey;
        const isSelected = dateKey === selectedKey;

        let workloadClass = '';
        if (events.length > 0) {
            const count = Math.min(5, events.length);
            workloadClass = `workload-${count}`;
        }

        html += `
            <div class="calendar-cell ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${workloadClass}" onclick="selectCalendarDate('${dateKey}')">
                <div class="cell-header">
                    <span class="day-number">${day}</span>
                </div>
                <div class="calendar-events">
                    ${events.slice(0, 2).map(e => `
                        <div class="calendar-event-mini event-${e.type}">${escapeHtml(e.title)}</div>
                    `).join('')}
                    ${events.length > 2 ? `<div class="more-events">+${events.length - 2} more</div>` : ''}
                </div>
            </div>
        `;
    }

    const totalCells = firstDay + daysInMonth;
    const remaining = 42 - totalCells;
    for (let i = 0; i < remaining; i++) {
        html += `<div class="calendar-cell empty-cell"></div>`;
    }

    html += `</div>`;
    return html;
}

function renderListView() {
    const month = calendarMgr.currentDate.getMonth();
    const year = calendarMgr.currentDate.getFullYear();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    let html = `<div class="calendar-list-view calendar-animate-slide">`;
    let hasEvents = false;

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const events = calendarMgr.getEventsForDate(date);

        if (events.length > 0) {
            hasEvents = true;
            html += `
                <div class="list-date-group">
                    <div class="list-date-header">${date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
                    ${events.map(e => `
                        <div class="agenda-item" onclick="viewEventDetail('${e.type}', '${e.id}')">
                            <div class="agenda-time" style="color: var(--${e.type === 'assignment' ? 'purple' : e.type === 'quiz' ? 'danger' : e.type === 'live' ? 'ok' : 'warn'})">
                                ${e.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                            <div class="agenda-info">
                                <div class="agenda-title">${escapeHtml(e.title)}</div>
                                <div class="agenda-desc">${e.type.toUpperCase()}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }
    }

    if (!hasEvents) {
        html += `<div class="empty">No events found for this month with the selected filter.</div>`;
    }

    html += `</div>`;
    return html;
}

function renderAgendaSidebar() {
    const now = new Date();
    const selectedDate = calendarMgr.selectedDate;
    const selectedEvents = calendarMgr.getEventsForDate(selectedDate);
    const isToday = calendarMgr.formatDateKey(selectedDate) === calendarMgr.formatDateKey(now);

    const upcomingDeadlines = calendarMgr.events
        .filter(e => (e.type === 'assignment' || e.type === 'quiz') && e.date > now)
        .sort((a, b) => a.date - b.date)
        .slice(0, 3);

    const nextLive = calendarMgr.events
        .filter(e => e.type === 'live' && e.date > now)
        .sort((a, b) => a.date - b.date)[0];

    return `
        <div class="calendar-agenda">
            <div class="agenda-section">
                <h4>${isToday ? "Today's Schedule" : `Schedule for ${selectedDate.toLocaleDateString(undefined, {month:'short', day:'numeric'})}`}</h4>
                ${selectedEvents.length > 0 ? selectedEvents.map(e => `
                    <div class="agenda-item" onclick="viewEventDetail('${e.type}', '${e.id}')">
                        <div class="agenda-time">${e.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                        <div class="agenda-info">
                            <div class="agenda-title">${escapeHtml(e.title)}</div>
                            <div class="agenda-desc">${e.type.toUpperCase()}</div>
                        </div>
                    </div>
                `).join('') : '<p class="small text-muted">Nothing scheduled.</p>'}
            </div>

            <div class="agenda-section">
                <h4>Upcoming Deadlines</h4>
                ${upcomingDeadlines.map(e => `
                    <div class="agenda-item" onclick="viewEventDetail('${e.type}', '${e.id}')">
                        <div class="agenda-info">
                            <div class="agenda-title">${escapeHtml(e.title)}</div>
                            <div class="agenda-desc">Due: ${e.date.toLocaleDateString()}</div>
                        </div>
                    </div>
                `).join('') || '<p class="small text-muted">No upcoming deadlines.</p>'}
            </div>

            ${nextLive ? `
                <div class="agenda-section">
                    <h4>Next Live Session</h4>
                    <div class="agenda-item" style="border-left: 4px solid var(--ok)" onclick="viewEventDetail('live', '${nextLive.id}')">
                        <div class="agenda-info">
                            <div class="agenda-title">${escapeHtml(nextLive.title)}</div>
                            <div class="agenda-desc">${nextLive.date.toLocaleString()}</div>
                        </div>
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

window.changeCalendarMonth = (delta, reset = false) => {
    if (reset) {
        calendarMgr.currentDate = new Date();
        calendarMgr.selectedDate = new Date();
    } else {
        const d = calendarMgr.currentDate;
        calendarMgr.currentDate = new Date(d.getFullYear(), d.getMonth() + delta, 1);
    }
    calendarMgr.preprocessEvents();
    renderCalendarUI();
};

window.selectCalendarDate = (dateKey) => {
    calendarMgr.selectedDate = new Date(dateKey);
    renderCalendarUI();

    // Auto-open details modal if there are events
    const events = calendarMgr.getEventsForDate(new Date(dateKey));
    if (events.length > 0) {
        showDayDetails(dateKey);
    }
};

window.toggleCalendarView = (mode) => {
    calendarMgr.viewMode = mode;
    renderCalendarUI();
};

window.filterCalendarEvents = (filter) => {
    calendarMgr.filter = filter;
    renderCalendarUI();
};

window.showDayDetails = (dateKey) => {
    const events = calendarMgr.getEventsForDate(new Date(dateKey));
    if (events.length === 0) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.display = 'flex';
    backdrop.innerHTML = `
        <div class="modal" style="max-width:500px">
            <div class="flex-between mb-20">
                <h3 class="m-0">Events for ${new Date(dateKey).toLocaleDateString()}</h3>
                <button class="button secondary small w-auto" onclick="this.closest('.modal-backdrop').remove()">Close</button>
            </div>
            <div class="event-modal-content">
                ${events.map(e => `
                    <div class="event-detail-item">
                        <div>
                            <div class="bold">${escapeHtml(e.title)}</div>
                            <div class="small text-muted">${e.type.toUpperCase()} | ${e.date.toLocaleTimeString()}</div>
                        </div>
                        <button class="button small w-auto" onclick="viewEventDetail('${e.type}', '${e.id}')">View</button>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);
};

window.viewEventDetail = (type, id) => {
    let page = '';
    if (type === 'assignment') page = 'assignments';
    else if (type === 'quiz') page = 'quizzes';
    else if (type === 'live') page = 'live';
    else if (type === 'planner') page = 'planner';

    const navBtn = document.querySelector(`nav button[data-page="${page}"]`);
    if (navBtn) {
        document.querySelectorAll('.modal-backdrop').forEach(m => m.remove());
        navBtn.click();
    }
};

window.renderCalendar = renderCalendar;
