/** The hash router's pure half: a URL hash to a route, and a route to its page title. */

export function parseRoute(hash) {
  const [path, query = ''] = String(hash ?? '').replace(/^#/, '').split('?');
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  const params = Object.fromEntries(new URLSearchParams(query));
  const [a, b, c] = parts;
  if (a === 'office') return { name: 'office', params };
  if (a === 'tasks' && b === 'q' && c) return { name: 'task', requestId: c, params };
  if (a === 'tasks' && b && c) return { name: 'task', projectId: b, runId: c, params };
  if (a === 'tasks') return { name: 'tasks', params };
  if (a === 'projects' && b) return { name: 'project', projectId: b, params };
  if (a === 'projects') return { name: 'projects', params };
  if (a === 'departments' && b === 'new') return { name: 'department', departmentId: null, params };
  if (a === 'departments' && b) return { name: 'department', departmentId: b, params };
  if (a === 'departments') return { name: 'departments', params };
  if (a === 'settings') return { name: 'settings', params };
  return { name: 'home', params };
}

export function routeKey(route) {
  return [route.name, route.requestId, route.projectId, route.runId, route.departmentId].filter((part) => part !== undefined && part !== null).join('/');
}

export function navSection(route) {
  if (route.name === 'task' || route.name === 'tasks') return 'tasks';
  if (route.name === 'project' || route.name === 'projects') return 'projects';
  if (route.name === 'department' || route.name === 'departments') return 'departments';
  return route.name;
}

const TITLES = { home: 'Home', office: 'Office', tasks: 'Tasks', task: 'Task', projects: 'Projects', project: 'Project', departments: 'Departments', department: 'Department', settings: 'Settings' };
export const routeTitle = (route) => TITLES[route.name] ?? 'Home';
