export const SCENE = { width: 1402, height: 1122 };

export const runtimes = [
  { id: 'codex', name: 'Codex', model: 'GPT-5.5', kind: 'Headless CLI', status: 'demo', description: 'Example mapping for engineering, operations, and the coordinator. GPT-5.5 is an illustrative selection; this preview does not detect installed models or open a Codex session.' },
  { id: 'claude', name: 'Claude Code', model: 'Claude Sonnet', kind: 'Headless CLI', status: 'demo', description: 'Example mapping for research, design, and marketing. Claude Sonnet is an illustrative selection; a production adapter must report the actual model and session state.' },
  { id: 'local', name: 'Local model', model: 'Qwen3', kind: 'Model API', status: 'demo', description: 'Example mapping for customer support. Qwen3 is an illustrative selection; no local endpoint or model has been detected or connected.' },
];

export const departments = [
  { id: 'research', name: 'Research', color: '#5595c4', x: 440, y: 232, label: [252, 25], bounds: { x: 180, y: 60, width: 510, height: 350 }, polygon: '187,225 451,73 686,211 685,275 458,403 190,268', runtimeId: 'claude', description: 'Turn questions into useful knowledge.' },
  { id: 'engineering', name: 'Engineering', color: '#5b8daa', x: 1030, y: 235, label: [1110, 22], bounds: { x: 770, y: 65, width: 510, height: 350 }, polygon: '777,225 1029,73 1274,212 1271,282 1041,408 778,272', runtimeId: 'codex', description: 'Build, test, and ship with confidence.' },
  { id: 'design', name: 'Design', color: '#d48897', x: 245, y: 548, label: [119, 350], bounds: { x: 25, y: 375, width: 445, height: 365 }, polygon: '29,502 256,383 459,507 458,601 259,733 30,592', runtimeId: 'claude', description: 'Make every interaction feel considered.' },
  { id: 'marketing', name: 'Marketing & Sales', color: '#c7a160', x: 1160, y: 589, label: [1253, 375], bounds: { x: 940, y: 395, width: 440, height: 375 }, polygon: '946,537 1146,409 1374,540 1372,641 1156,770 946,640', runtimeId: 'claude', description: 'Bring the right message to the right people.' },
  { id: 'operations', name: 'Operations & Finance', color: '#a391bb', x: 422, y: 872, label: [30, 794], bounds: { x: 178, y: 692, width: 490, height: 360 }, polygon: '184,839 408,693 660,839 660,920 420,1048 186,893', runtimeId: 'codex', description: 'Keep the whole office running smoothly.' },
  { id: 'support', name: 'Customer Support', color: '#7b9f8e', x: 967, y: 894, label: [1315, 1030], bounds: { x: 725, y: 715, width: 465, height: 355 }, polygon: '738,855 954,719 1182,854 1181,936 977,1065 736,929', runtimeId: 'local', description: 'Help, resolve, and bring learning back.' },
].map(d => ({ ...d, employees: [] }));

const seats = [
  ['research', [['Maya Chen','Lead',437,128,'working'],['Lena Ortiz','Researcher',299,221,'working'],['Oliver Park','Analyst',435,278,'working'],['Eli Brooks','Knowledge',563,216,'idle']]],
  ['engineering', [['Alex Morgan','Lead',1040,128,'working'],['Noah Kim','Developer',890,224,'working'],['Sofia Rivera','QA',1040,281,'working'],['Arjun Shah','DevOps',1175,222,'working']]],
  ['design', [['Theo Martin','Lead',236,456,'working'],['Ava Patel','UX',122,533,'working'],['Lucas Reed','Visual',245,603,'working'],['Zoe Wilson','Prototype',362,532,'review']]],
  ['marketing', [['Jamie Taylor','Lead',1164,479,'working'],['Grace Lewis','Content',1035,570,'working'],['Mia Harris','Sales',1147,635,'working'],['Ben Walker','Outreach',1282,569,'idle']]],
  ['operations', [['Sam Wright','Lead',414,772,'working'],['Isabella Diaz','Operations',296,857,'working'],['Nina Bose','Finance',420,923,'working'],['Emma Clarke','Review',548,854,'review']]],
  ['support', [['Jordan Lee','Lead',965,778,'working'],['Leo Evans','Support',844,857,'working'],['Amara Jones','Triage',956,927,'working'],['Daniel Chen','Knowledge',1080,860,'review']]],
];

const tasks = {
  research: ['Synthesize the customer interviews', 'Review customer feedback', 'Compare the research findings', 'Organize shared knowledge'],
  engineering: ['Coordinate the onboarding build', 'Build the onboarding flow', 'Check the onboarding experience', 'Prepare the preview environment'],
  design: ['Review the interface direction', 'Map the onboarding journey', 'Refine the interface assets', 'Review the interactive prototype'],
  marketing: ['Review the launch plan', 'Draft the product story', 'Prepare customer follow-ups', 'Plan the next outreach round'],
  operations: ['Coordinate the monthly review', 'Prepare the monthly report', 'Reconcile the budget overview', 'Review the monthly report'],
  support: ['Coordinate the support queue', 'Resolve customer questions', 'Sort incoming requests', 'Review the help-center update'],
};

export const employees = seats.flatMap(([departmentId, roster]) => roster.map(([name, role, x, y, status], i) => {
  const department = departments.find(d => d.id === departmentId);
  const id = `${departmentId}-${i}`;
  department.employees.push(id);
  return { id, name, role, departmentId, x, y, labelY: y - 36, status, runtimeId: department.runtimeId, task: tasks[departmentId][i] };
}));

export const control = { id: 'control', x: 714, y: 529, bounds: { x: 510, y: 366, width: 405, height: 333 } };

// Explicit sample events. No background task completion or model execution is simulated.
export const demoCommunications = [
  { from: 'research-1', to: 'research-0', message: 'Researcher → Lead · Findings ready' },
  { from: 'research', to: 'control', message: 'Research → Control center · Research brief' },
  { from: 'control', to: 'engineering', message: 'Control center → Engineering · Build brief' },
  { from: 'engineering-1', to: 'engineering-2', message: 'Developer → QA · Ready for review' },
  { from: 'design', to: 'engineering', message: 'Design → Engineering · Interface handoff' },
  { from: 'support', to: 'control', message: 'Support → Control center · Customer feedback' },
];
