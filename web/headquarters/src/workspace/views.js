const STATUS_LABELS = { working: 'Working', review: 'In review', idle: 'Available', queued: 'Queued', done: 'Done', offline: 'Offline' };
const RUNTIME_LABELS = { codex: 'Codex', claude: 'Claude Code', local: 'Local model' };
const BOARD_COLUMNS = [
  { id: 'queued', name: 'Queued', caption: 'Ready for a clear next step' },
  { id: 'working', name: 'In progress', caption: 'Assigned and moving forward' },
  { id: 'review', name: 'Needs review', caption: 'A second pair of eyes' },
  { id: 'done', name: 'Done', caption: 'Completed work, in one place' },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function append(parent, ...children) {
  children.filter(Boolean).forEach(child => parent.append(child));
  return parent;
}

function initials(name = '') {
  if (name === 'Atlas') return 'AT';
  return String(name).trim().split(/\s+/).slice(0, 2).map(word => word[0] || '').join('');
}

function avatar(name, department, className = '') {
  const node = el('span', `person-avatar ${className}`, initials(name));
  node.setAttribute('aria-hidden', 'true');
  if (department?.color) node.style.setProperty('--person-color', department.color);
  return node;
}

function statusBadge(status, className = '') {
  const state = Object.hasOwn(STATUS_LABELS, status) ? status : 'idle';
  return el('span', `person-status person-status--${state} ${className}`, STATUS_LABELS[state]);
}

function header(title, description, count) {
  const node = el('header', 'view-heading');
  append(node,
    append(el('div', 'view-heading-copy'), el('h2', 'view-title', title), el('p', 'view-description', description)),
    count ? el('span', 'view-count', count) : null,
  );
  return node;
}

function emptyState(title, description) {
  return append(el('div', 'view-empty'), el('span', 'view-empty-mark', '—'), el('h3', '', title), el('p', '', description));
}

function personButton(employee, department, onSelect, lead = false) {
  const button = el('button', lead ? 'org-person org-person--lead' : 'org-person');
  button.type = 'button';
  button.addEventListener('click', () => onSelect?.('employee', employee.id));
  append(button,
    avatar(employee.name, department),
    append(el('span', 'org-person-copy'), el('span', 'org-person-name', employee.name), el('span', 'org-person-role', lead ? 'Department lead' : employee.role)),
    el('span', `org-status-dot org-status-dot--${employee.status || 'idle'}`),
  );
  button.setAttribute('aria-label', `${employee.name}, ${lead ? `${department.name} lead` : employee.role}. ${STATUS_LABELS[employee.status] || 'Available'}. View profile`);
  return button;
}

/** A connected company hierarchy. onSelect receives (type, id). */
export function renderOrganization({ departments = [], employees = [], onSelect } = {}) {
  const root = el('section', 'org-view');
  root.setAttribute('aria-label', 'Company organization');
  const departmentMembers = employees.filter(employee => departments.some(department => department.id === employee.departmentId));
  append(root, header('Built around your teams', 'A shared direction, with clear ownership at every level.', `${departments.length} ${departments.length === 1 ? 'department' : 'departments'} · ${departmentMembers.length + 1} AI employees`));

  const chartScroll = el('div', 'org-chart-scroll');
  chartScroll.setAttribute('tabindex', '0');
  chartScroll.setAttribute('role', 'region');
  chartScroll.setAttribute('aria-label', 'Organization chart. Scroll horizontally if needed to see all departments.');
  const tree = el('div', 'org-tree');
  tree.style.setProperty('--org-columns', Math.max(1, departments.length));
  tree.style.setProperty('--org-min-width', `${Math.max(285, departments.length * 150 + Math.max(0, departments.length - 1) * 10 + 4)}px`);
  if (departments.length <= 1) tree.classList.add('org-tree--single');
  const coordinator = el('button', 'org-coordinator');
  coordinator.type = 'button';
  coordinator.addEventListener('click', () => onSelect?.('coordinator', 'control'));
  append(coordinator,
    el('span', 'org-coordinator-symbol', 'AT'),
    append(el('span', 'org-coordinator-copy'), el('span', 'org-coordinator-eyebrow', 'Company orchestrator'), el('strong', 'org-coordinator-name', 'Atlas'), el('span', 'org-coordinator-description', 'Routes work. Connects teams.')),
    el('span', 'org-coordinator-arrow', '↗'),
  );
  coordinator.setAttribute('aria-label', 'Atlas, company orchestrator. View details');
  append(tree, coordinator, el('div', 'org-routing-label', 'Shared direction, distributed ownership'));

  const departmentsGrid = el('div', 'org-departments');
  departments.forEach(department => {
    const team = employees.filter(employee => employee.departmentId === department.id);
    const lead = team.find(employee => employee.role?.toLowerCase() === 'lead');
    const specialists = team.filter(employee => employee.id !== lead?.id);
    const branch = el('section', 'org-branch');
    branch.style.setProperty('--person-color', department.color || '#728773');
    branch.setAttribute('aria-label', `${department.name} department`);
    const departmentButton = el('button', 'org-department-header');
    departmentButton.type = 'button';
    departmentButton.addEventListener('click', () => onSelect?.('department', department.id));
    append(departmentButton,
      append(el('span', 'org-department-title'), el('span', 'org-department-marker'), el('strong', '', department.name)),
      el('span', 'org-department-number', String(team.length)),
    );
    append(branch, departmentButton, el('p', 'org-reporting-to', 'Reports to Atlas'));
    if (lead) append(branch, personButton(lead, department, onSelect, true));
    else append(branch, el('p', 'org-no-lead', 'No lead assigned'));
    const specialistsList = el('div', 'org-specialists');
    specialists.forEach(employee => append(specialistsList, personButton(employee, department, onSelect)));
    append(branch, specialistsList);
    append(departmentsGrid, branch);
  });
  append(tree, departmentsGrid);
  append(chartScroll, tree);
  append(root, chartScroll,
    append(el('footer', 'org-legend'),
      append(el('span', ''), el('i', 'org-legend-line'), document.createTextNode('Reporting line')),
      append(el('span', ''), el('i', 'org-status-dot org-status-dot--working'), document.createTextNode('Working')),
      append(el('span', ''), el('i', 'org-status-dot org-status-dot--review'), document.createTextNode('In review')),
      append(el('span', ''), el('i', 'org-status-dot org-status-dot--idle'), document.createTextNode('Available')),
    ),
  );
  return root;
}

function taskCard(task, departments, employees, onTask, onMove) {
  const department = departments.find(item => item.id === task.departmentId);
  const owner = employees.find(item => item.id === task.assigneeId);
  const card = el('article', 'board-card');
  const detailButton = el('button', 'board-card-open');
  detailButton.type = 'button';
  detailButton.addEventListener('click', () => onTask?.(task.id));
  const priority = String(task.priority || 'medium').toLowerCase();
  const priorityClass = ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : 'medium';
  const departmentPill = el('span', 'board-department', department?.name || 'Unassigned');
  if (department?.color) departmentPill.style.setProperty('--person-color', department.color);
  append(detailButton,
    append(el('span', 'board-card-topline'), departmentPill, el('span', `board-priority board-priority--${priorityClass}`, priority.charAt(0).toUpperCase() + priority.slice(1))),
    el('strong', 'board-task-title', task.title || 'Untitled task'),
  );
  if (task.description) append(detailButton, el('span', 'board-task-description', task.description));
  append(detailButton,
    append(el('span', 'board-owner'), avatar(owner?.name || '?', department, 'person-avatar--small'), el('span', '', owner?.name || 'Unassigned'), el('span', 'board-open-arrow', '↗')),
  );
  append(card, detailButton);

  const controls = el('div', 'board-card-controls');
  const select = el('select', 'board-move-select');
  select.setAttribute('aria-label', `Move ${task.title || 'task'} to a different status`);
  BOARD_COLUMNS.forEach(column => {
    const option = el('option', '', column.name);
    option.value = column.id;
    option.selected = column.id === task.status;
    select.append(option);
  });
  select.addEventListener('change', event => onMove?.(task.id, event.target.value));
  append(controls, el('span', 'board-move-label', 'Status'), select);
  append(card, controls);
  return card;
}

/** A task board. onTask receives taskId; onMove receives (taskId, nextStatus). */
export function renderBoard({ departments = [], employees = [], tasks = [], onTask, onMove, filter = 'all' } = {}) {
  const root = el('section', 'board-view');
  root.setAttribute('aria-label', 'Task board');
  const filtered = filter === 'all' ? tasks : tasks.filter(task => task.departmentId === filter);
  const departmentName = departments.find(department => department.id === filter)?.name;
  append(root, header(departmentName ? `${departmentName} work` : 'A shared view of the work', 'Follow each task from a first brief to a finished result.', `${filtered.length} ${filtered.length === 1 ? 'task' : 'tasks'}`));
  const columns = el('div', 'board-columns');
  BOARD_COLUMNS.forEach(column => {
    const items = filtered.filter(task => task.status === column.id);
    const section = el('section', `board-column board-column--${column.id}`);
    section.setAttribute('aria-label', `${column.name}, ${items.length} tasks`);
    append(section,
      append(el('header', 'board-column-heading'),
        append(el('div', 'board-column-title'), el('span', 'board-column-dot'), el('h3', '', column.name), el('span', 'board-column-count', items.length)),
        el('p', 'board-column-description', column.caption),
      ),
    );
    const list = el('div', 'board-task-list');
    items.forEach(task => append(list, taskCard(task, departments, employees, onTask, onMove)));
    if (!items.length) append(list, emptyState(column.id === 'done' ? 'A little room for progress' : 'All clear here', column.id === 'done' ? 'Completed tasks will appear here.' : `No ${departmentName ? `${departmentName.toLowerCase()} ` : ''}tasks ${column.id === 'queued' ? 'in the queue' : column.id === 'review' ? 'waiting for review' : 'in progress'}.`));
    append(section, list);
    append(columns, section);
  });
  append(root, columns);
  return root;
}

/** A searchable roster. Query matches name, role, department, and runtime. */
export function renderPeople({ departments = [], employees = [], onSelect, query = '' } = {}) {
  const root = el('section', 'people-view');
  root.setAttribute('aria-label', 'Agent directory');
  const directory = departments.length === 6 ? [
    { id: 'control', name: 'Atlas', role: 'Company orchestrator', departmentId: null, status: 'idle', runtimeId: 'codex', task: 'Coordinate priorities and route work between teams', isCoordinator: true },
    ...employees,
  ] : employees;
  const normalizedQuery = String(query).trim().toLowerCase();
  const matches = directory.filter(employee => {
    const department = departments.find(item => item.id === employee.departmentId);
    return !normalizedQuery || [employee.name, employee.role, employee.isCoordinator ? 'Company-wide' : department?.name, RUNTIME_LABELS[employee.runtimeId] || employee.runtimeId].join(' ').toLowerCase().includes(normalizedQuery);
  });
  append(root, header('Meet your team', 'The people, responsibilities, and focus behind every department.', `${matches.length} of ${directory.length} AI employees`));
  if (!matches.length) {
    append(root, emptyState('No matching agents', 'Try another name, role, department, or runtime.'));
    return root;
  }
  const grid = el('div', 'people-grid');
  matches.forEach(employee => {
    const department = departments.find(item => item.id === employee.departmentId);
    const card = el('button', 'people-card');
    card.type = 'button';
    card.addEventListener('click', () => onSelect?.(employee.isCoordinator ? 'coordinator' : 'employee', employee.id));
    card.setAttribute('aria-label', `${employee.name}, ${employee.role === 'Lead' ? `${department?.name || 'Department'} lead` : employee.role}. View profile`);
    append(card,
      append(el('span', 'people-card-top'), avatar(employee.name, department, 'person-avatar--large'), statusBadge(employee.status)),
      el('strong', 'people-name', employee.name),
      el('span', 'people-role', employee.role === 'Lead' ? 'Department lead' : employee.role),
      append(el('span', 'people-department'), el('span', 'people-department-dot'), document.createTextNode(employee.isCoordinator ? 'Company-wide' : department?.name || 'Unassigned')),
      append(el('span', 'people-focus'), el('span', 'people-focus-label', 'CURRENT FOCUS'), el('span', 'people-focus-text', employee.task || 'Ready for the next assignment')),
      append(el('span', 'people-card-footer'), el('span', 'people-runtime', RUNTIME_LABELS[employee.runtimeId] || employee.runtimeId || 'Unassigned runtime'), el('span', 'people-profile-link', 'View profile ↗')),
    );
    if (department?.color) card.style.setProperty('--person-color', department.color);
    else if (employee.isCoordinator) card.style.setProperty('--person-color', 'var(--accent)');
    append(grid, card);
  });
  append(root, grid);
  return root;
}
