/**
 * The office SCENE: geometry only.
 *
 * The illustration (public/assets/office-clean.png) was drawn around these
 * islands, polygons and seats, so the numbers here stay exactly as the user's
 * prototype had them. Nothing in this file says who sits where or what anyone
 * is doing: people, statuses and runtimes come from the workforce API
 * (GET /api/office, GET /api/runs), and a seat with no configured agent is an
 * open desk. See office-model.js for how agents are seated.
 */
export const SCENE = { width: 1402, height: 1122 };

export const departments = [
  { id: 'research', name: 'Research', color: '#5595c4', x: 440, y: 232, label: [252, 25], bounds: { x: 180, y: 60, width: 510, height: 350 }, polygon: '187,225 451,73 686,211 685,275 458,403 190,268', description: 'Turn questions into useful knowledge.' },
  { id: 'engineering', name: 'Engineering', color: '#5b8daa', x: 1030, y: 235, label: [1110, 22], bounds: { x: 770, y: 65, width: 510, height: 350 }, polygon: '777,225 1029,73 1274,212 1271,282 1041,408 778,272', description: 'Build, test, and ship with confidence.' },
  { id: 'design', name: 'Design', color: '#d48897', x: 245, y: 548, label: [119, 350], bounds: { x: 25, y: 375, width: 445, height: 365 }, polygon: '29,502 256,383 459,507 458,601 259,733 30,592', description: 'Make every interaction feel considered.' },
  { id: 'marketing', name: 'Marketing & Sales', color: '#c7a160', x: 1160, y: 589, label: [1253, 375], bounds: { x: 940, y: 395, width: 440, height: 375 }, polygon: '946,537 1146,409 1374,540 1372,641 1156,770 946,640', description: 'Bring the right message to the right people.' },
  { id: 'operations', name: 'Operations & Finance', color: '#a391bb', x: 422, y: 872, label: [30, 794], bounds: { x: 178, y: 692, width: 490, height: 360 }, polygon: '184,839 408,693 660,839 660,920 420,1048 186,893', description: 'Keep the whole office running smoothly.' },
  { id: 'support', name: 'Customer Support', color: '#7b9f8e', x: 967, y: 894, label: [1315, 1030], bounds: { x: 725, y: 715, width: 465, height: 355 }, polygon: '738,855 954,719 1182,854 1181,936 977,1065 736,929', description: 'Help, resolve, and bring learning back.' },
];

/**
 * The 24 drawn seats, four per island, in the prototype's order. Index 0 of
 * each island is the head of its table. Coordinates are the seated figure in
 * the illustration; the nameplate sits 36px above it.
 */
const seatCoordinates = [
  ['research', [[437, 128], [299, 221], [435, 278], [563, 216]]],
  ['engineering', [[1040, 128], [890, 224], [1040, 281], [1175, 222]]],
  ['design', [[236, 456], [122, 533], [245, 603], [362, 532]]],
  ['marketing', [[1164, 479], [1035, 570], [1147, 635], [1282, 569]]],
  ['operations', [[414, 772], [296, 857], [420, 923], [548, 854]]],
  ['support', [[965, 778], [844, 857], [956, 927], [1080, 860]]],
];

export const seats = seatCoordinates.flatMap(([departmentId, coordinates]) =>
  coordinates.map(([x, y], index) => ({ id: `${departmentId}-${index}`, departmentId, index, x, y, labelY: y - 36 })),
);

/** The control center: where Atlas, the workforce coordinator itself, sits. */
export const control = { id: 'control', x: 714, y: 529, bounds: { x: 510, y: 366, width: 405, height: 333 } };
