import { departments as sourceDepartments, employees as sourceEmployees } from '../data.js';
export const departments = sourceDepartments.map(d => ({...d, name: ({marketing:'Marketing',operations:'Operations',support:'Customer support'}[d.id] || d.name)}));
export const employees = sourceEmployees.map(e => ({...e}));
export const seedTasks = [
  {id:'WP-104',title:'Website launch',departmentId:'engineering',assigneeId:'engineering-1',status:'working',priority:'High',description:'Build the new company website from the approved design. Coordinate the interface handoff with Design and share a working preview for review.'},
  {id:'WP-103',title:'Customer insights report',departmentId:'research',assigneeId:'research-0',status:'working',priority:'Medium',description:'Synthesize the interview findings into a concise report. Share the most actionable opportunities with Atlas.'},
  {id:'WP-102',title:'September operations review',departmentId:'operations',assigneeId:'operations-0',status:'queued',priority:'Medium',description:'Prepare the monthly operations review, including the team workload and proposed priorities.'},
  {id:'WP-101',title:'Homepage direction',departmentId:'design',assigneeId:'design-0',status:'review',priority:'High',description:'Review the proposed homepage direction: a clear product story, accessible navigation, and a focused call to action. The team needs your approval before implementation.'},
  {id:'WP-100',title:'Launch messaging',departmentId:'marketing',assigneeId:'marketing-0',status:'review',priority:'Medium',description:'Approve the positioning and three launch message options. This preview records a local review decision only.'},
  {id:'WP-099',title:'Help center structure',departmentId:'support',assigneeId:'support-3',status:'done',priority:'Low',description:'Outline the help center categories and first set of how-to articles. The example deliverable is ready for the next planning session.'},
  {id:'WP-098',title:'Onboarding accessibility audit',departmentId:'engineering',assigneeId:'engineering-2',status:'queued',priority:'Medium',description:'Check keyboard navigation, readable contrast, form labels, and screen reader behavior in the onboarding flow.'},
];
const storageKey = 'workplace-mockup-v1';
export function loadTasks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(parsed) && parsed.length && parsed.length < 500 && parsed.every(t => typeof t.id === 'string' && typeof t.title === 'string' && typeof t.description === 'string' && ['queued','working','review','done'].includes(t.status) && departments.some(d=>d.id===t.departmentId) && employees.some(e=>e.id===t.assigneeId && e.departmentId===t.departmentId))) return parsed;
  } catch { /* A fresh preview remains usable without storage. */ }
  return structuredClone(seedTasks);
}
export function persistTasks(tasks) {
  try { localStorage.setItem(storageKey,JSON.stringify(tasks)); return true; } catch { return false; }
}
export const personById = id => employees.find(e => e.id === id);
export const departmentById = id => departments.find(d => d.id === id);
