/**
 * Original procedural furniture for the local office.
 * Coordinates: Y up, desk centered at the origin, employee on +Z facing -Z.
 * Screen graphics are a static decorative pattern, never execution evidence.
 * No models, images, fonts or material assets are downloaded by this module.
 */
import * as THREE from './vendor/three.module.min.js';

const geometries = new Map();
const materials = new Map();
const textures = new Map();
const UP = new THREE.Vector3(0, 1, 0);
const C = {
  wood: '#caa982', woodEdge: '#b8946d', steel: '#c6c6bd', dark: '#38464b',
  keyboard: '#e8e4da', keys: '#c5c4bd', paper: '#f4eee2', pot: '#d7b6a0',
  soil: '#544c3e', leaf: '#718b64', leafLight: '#8da178',
};

function hash(value) {
  let n = 2166136261;
  for (const c of String(value)) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return n >>> 0;
}

function material(color, roughness = .77, metalness = 0) {
  const key = `${color}:${roughness}:${metalness}`;
  if (!materials.has(key)) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    mat.userData.sharedFurniture = true;
    materials.set(key, mat);
  }
  return materials.get(key);
}

function geometry(key, make) {
  if (!geometries.has(key)) {
    const shape = make();
    shape.userData.sharedFurniture = true;
    geometries.set(key, shape);
  }
  return geometries.get(key);
}

function add(parent, shape, mat, x, y, z, name = '') {
  const mesh = new THREE.Mesh(shape, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function box(parent, w, h, d, color, x, y, z, bevel = .02) {
  const key = `box:${w}:${h}:${d}:${bevel}`;
  const shape = geometry(key, () => {
    const b = Math.min(bevel, w / 5, h / 5, d / 5);
    if (!b) return new THREE.BoxGeometry(w, h, d);
    const a = w / 2 - b, c = h / 2 - b;
    const s = new THREE.Shape();
    s.moveTo(-a, -c); s.lineTo(a, -c); s.lineTo(a, c); s.lineTo(-a, c); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: d - 2 * b, bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: 3, steps: 1 });
    g.translate(0, 0, -(d - 2 * b) / 2);
    g.computeVertexNormals();
    return g;
  });
  return add(parent, shape, typeof color === 'string' || typeof color === 'number' ? material(color) : color, x, y, z);
}

function ellipsoid(parent, sx, sy, sz, color, x, y, z) {
  const mesh = add(parent, geometry('sphere', () => new THREE.SphereGeometry(1, 16, 12)), material(color), x, y, z);
  mesh.scale.set(sx, sy, sz);
  return mesh;
}

function cylinder(parent, r1, r2, h, color, x, y, z, sides = 16) {
  return add(parent, geometry(`cyl:${r1}:${r2}:${h}:${sides}`, () => new THREE.CylinderGeometry(r1, r2, h, sides)), material(color), x, y, z);
}

function limb(parent, a, b, radius, color) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
  const direction = end.clone().sub(start), length = direction.length();
  const mesh = add(parent, geometry(`capsule:${radius}:${length.toFixed(4)}`, () => new THREE.CapsuleGeometry(radius, Math.max(.005, length - radius * 2), 4, 10)), material(color), 0, 0, 0);
  mesh.position.copy(start).add(end).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(UP, direction.normalize());
  return mesh;
}

/** A single static desktop motif; bars are explicitly decorative geometry. */
function screenTexture(color) {
  if (textures.has(color)) return textures.get(color);
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 320;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#26373d'; ctx.fillRect(0, 0, 512, 320);
  ctx.fillStyle = '#34484e'; ctx.fillRect(0, 0, 512, 31);
  ctx.fillStyle = '#607679';
  for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(18 + i * 15, 15, 3, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#2d4147'; ctx.fillRect(0, 32, 108, 288);
  ctx.fillStyle = '#718a8b';
  for (let i = 0; i < 5; i++) ctx.fillRect(20, 59 + i * 32, 53 - i % 2 * 12, 5);
  ctx.fillStyle = color; ctx.globalAlpha = .76; ctx.fillRect(133, 56, 112, 8);
  ctx.globalAlpha = 1;
  const lengths = [212, 154, 231, 112, 193, 144, 222, 167];
  lengths.forEach((length, i) => {
    ctx.fillStyle = i % 3 === 0 ? '#90afa8' : '#647f86';
    ctx.fillRect(135 + i % 3 * 12, 87 + i * 23, length, 5);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  texture.userData.decorativeOnly = true;
  texture.userData.sharedFurniture = true;
  textures.set(color, texture);
  return texture;
}

function monitor(parent, { x = 0, z = -.24, angle = 0, width = .94, color = '#92afc1' } = {}) {
  const group = new THREE.Group(); group.position.set(x, 1.105, z); group.rotation.y = angle;
  parent.add(group);
  box(group, .36, .026, .23, C.steel, 0, .015, .01, .012);
  box(group, .075, .27, .065, C.steel, 0, .155, -.015, .009);
  const body = box(group, width, width * .62, .063, '#425057', 0, .49, -.02, .022);
  body.name = 'monitor';
  const panel = new THREE.Mesh(geometry(`screen:${width}`, () => new THREE.PlaneGeometry(width - .065, width * .62 - .065)), new THREE.MeshBasicMaterial({ map: screenTexture(color), toneMapped: false }));
  // PlaneGeometry points along +Z: the visible panel faces the seated person.
  panel.position.set(0, .49, .013);
  panel.name = 'decorative-screen'; panel.userData.decorativeOnly = true;
  group.add(panel);
  ellipsoid(group, .009, .009, .007, '#667d77', width / 2 - .045, .49 - width * .31 + .021, .017);
  return group;
}

function keyboard(parent, x = 0, z = .25) {
  const deck = box(parent, .55, .035, .195, C.keyboard, x, 1.12, z, .012);
  deck.rotation.x = .035;
  // Five bands read as keys at office scale without hundreds of small meshes.
  for (let row = 0; row < 4; row++) box(parent, .48, .007, .018, C.keys, x, 1.141, z - .06 + row * .034, .002);
  box(parent, .19, .007, .02, '#b7b8b2', x, 1.142, z + .075, .002);
  ellipsoid(parent, .065, .026, .092, '#e0e0d7', x + .42, 1.137, z + .01);
}

function desk(parent, width, color, head) {
  box(parent, width, .105, 1.1, C.wood, 0, 1.05, 0, .032);
  box(parent, width - .04, .027, 1.045, C.woodEdge, 0, .99, 0, .013);
  for (const x of [-width / 2 + .16, width / 2 - .16]) {
    for (const z of [-.39, .39]) box(parent, .065, .94, .065, C.steel, x, .48, z, .012);
    box(parent, .086, .063, .91, C.steel, x, .055, 0, .018);
  }
  box(parent, width - .29, .07, .055, C.steel, 0, .75, -.4, .012);
  // A fabric privacy screen gives each department a subtle, consistent accent.
  const privacy = box(parent, width - .17, .26, .045, color, 0, 1.225, -.555, .018);
  privacy.name = 'department-accent';
  if (head) {
    box(parent, .34, .12, .33, '#e5ddd1', -width / 2 + .29, 1.157, .14, .014);
    box(parent, .33, .012, .32, '#f6f0e6', -width / 2 + .29, 1.224, .14, .006);
  } else {
    const notebook = box(parent, .29, .023, .35, '#d8d0bb', -width / 2 + .26, 1.118, .16, .008);
    notebook.rotation.y = -.12;
    box(parent, .021, .018, .24, '#696a65', -width / 2 + .29, 1.14, .18, .005).rotation.y = -.12;
  }
  const mug = new THREE.Group(); mug.position.set(width / 2 - .22, 1.106, -.25); parent.add(mug);
  cylinder(mug, .067, .057, .145, '#e8e1d4', 0, .073, 0);
  cylinder(mug, .054, .054, .005, '#655346', 0, .148, 0);
  const handle = add(mug, geometry('mug-handle', () => new THREE.TorusGeometry(.044, .014, 8, 16)), material('#e8e1d4'), .072, .085, 0);
  handle.rotation.y = Math.PI / 2;
}

function chair(parent, color = '#748684', executive = false) {
  const upholstery = new THREE.Color(color).lerp(new THREE.Color('#7b837d'), .55).getStyle();
  cylinder(parent, .043, .05, .39, C.dark, 0, .35, .98);
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI * 2 / 5;
    const x = Math.sin(angle) * .30, z = .98 + Math.cos(angle) * .30;
    limb(parent, [0, .14, .98], [x, .1, z], .032, C.dark);
    const wheel = cylinder(parent, .043, .043, .05, '#46514e', x, .07, z, 12);
    wheel.rotation.z = Math.PI / 2;
  }
  box(parent, .52, .11, .49, upholstery, 0, .62, .97, .052);
  const back = box(parent, .50, executive ? .63 : .48, .105, upholstery, 0, executive ? 1.04 : .97, 1.25, .048);
  back.rotation.x = -.09;
  box(parent, .08, .39, .065, C.dark, 0, .70, 1.24, .013);
  for (const x of [-.315, .315]) {
    box(parent, .045, .21, .045, C.dark, x, .75, 1.07, .01);
    box(parent, .073, .05, .30, upholstery, x, .87, .97, .023);
  }
}

function person(parent, agent, index, executive = false) {
  const seed = hash(agent?.id ?? agent?.name ?? `seat-${index}`);
  const skins = ['#e4b89b', '#c58b68', '#9b674f', '#eec7a7', '#815741', '#b77c61'];
  const shirts = ['#738f9b', '#b58b7e', '#718d83', '#c3b19a', '#8b829c', '#788492'];
  const hairs = ['#443931', '#5b4535', '#2f3231', '#846647', '#654337'];
  const skin = skins[seed % skins.length], shirt = executive ? '#677f86' : shirts[(seed >>> 5) % shirts.length];
  const hair = hairs[(seed >>> 9) % hairs.length], trousers = '#586264';
  const group = new THREE.Group(); group.name = 'seated-employee'; parent.add(group);
  const torso = ellipsoid(group, .245, .305, .175, shirt, 0, 1.075, .89); torso.rotation.x = -.10;
  ellipsoid(group, .225, .12, .175, trousers, 0, .785, .97);
  cylinder(group, .07, .078, .16, skin, 0, 1.375, .835);
  for (const sign of [-1, 1]) {
    const shoulder = [sign * .205, 1.28, .84], elbow = [sign * .32, 1.115, .65];
    limb(group, shoulder, [sign * .29, 1.17, .72], .083, shirt);
    limb(group, [sign * .29, 1.17, .72], elbow, .061, skin);
    limb(group, elbow, [sign * .16, 1.16, .31], .054, skin);
    ellipsoid(group, .06, .027, .087, skin, sign * .15, 1.155, .27).rotation.y = sign * -.2;
    limb(group, [sign * .125, .79, .98], [sign * .145, .57, .48], .102, trousers);
    limb(group, [sign * .145, .57, .48], [sign * .15, .17, .38], .075, trousers);
    box(group, .16, .115, .28, '#ded9cc', sign * .15, .10, .30, .045);
    box(group, .162, .025, .285, '#bdbdb2', sign * .15, .05, .30, .011);
  }
  const head = new THREE.Group(); head.position.set(0, 1.58, .815); head.rotation.x = -.06; group.add(head);
  ellipsoid(head, .16, .197, .155, skin, 0, 0, 0);
  ellipsoid(head, .125, .116, .126, skin, 0, -.075, -.018);
  ellipsoid(head, .027, .036, .044, skin, 0, -.022, -.15);
  for (const sign of [-1, 1]) {
    ellipsoid(head, .027, .044, .026, skin, sign * .156, -.014, .006);
    ellipsoid(head, .009, .012, .005, '#49423b', sign * .061, .024, -.142);
  }
  const cap = add(head, geometry('hair-cap', () => new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI * .53)), material(hair), 0, .017, .013);
  cap.scale.set(.168, .20, .161);
  ellipsoid(head, .144, .126, .078, hair, 0, -.01, .112);
  const style = (seed >>> 12) % 4;
  if (style === 1) {
    for (const sign of [-1, 1]) ellipsoid(head, .055, .18, .117, hair, sign * .135, -.057, .035);
  } else if (style === 2) {
    ellipsoid(head, .084, .09, .089, hair, 0, .105, .185);
  } else if (style === 3) {
    for (let i = 0; i < 5; i++) ellipsoid(head, .069, .07, .081, hair, Math.sin(i * 1.25) * .10, .14 + Math.cos(i * 1.25) * .025, Math.cos(i * 1.25) * .08);
  }
  group.userData.agentId = agent?.id ?? null;
  return group;
}

/** Desk top: width 1.9, depth 1.1, center height 1.05; chair sits on +Z. */
export function createWorkstation({ agent = {}, color = '#8ca7b4', index = 0, head = false } = {}) {
  const group = new THREE.Group();
  group.name = head ? 'head-workstation' : 'employee-workstation';
  group.userData.agentId = agent.id ?? null;
  desk(group, 1.9, color, head);
  monitor(group, { color });
  keyboard(group);
  chair(group, color, head);
  person(group, agent, index, head);
  return group;
}

/** The sole three-monitor desk, reserved for the central coordinator. */
export function createControlCenter() {
  const group = new THREE.Group(); group.name = 'control-center';
  desk(group, 2.8, '#aab8ab', true);
  monitor(group, { width: .86, color: '#9bb4b1', z: -.33 });
  monitor(group, { x: -.88, z: -.21, angle: .20, width: .79, color: '#9bb4b1' });
  monitor(group, { x: .88, z: -.21, angle: -.20, width: .79, color: '#9bb4b1' });
  keyboard(group);
  chair(group, '#778f85', true);
  person(group, { id: 'central-coordinator' }, 0, true);
  return group;
}

export function createPlant() {
  const group = new THREE.Group(); group.name = 'office-plant';
  cylinder(group, .205, .145, .34, C.pot, 0, .17, 0);
  cylinder(group, .188, .188, .018, C.soil, 0, .333, 0);
  cylinder(group, .21, .21, .055, C.pot, 0, .322, 0);
  for (let i = 0; i < 7; i++) {
    const angle = i * 2.3999, height = .50 + i % 3 * .12;
    const x = Math.sin(angle) * .17, z = Math.cos(angle) * .17;
    limb(group, [0, .32, 0], [x, height + .17, z], .014, '#7d8960');
    const leaf = ellipsoid(group, .084, .23, .029, i % 2 ? C.leaf : C.leafLight, x, height + .15, z);
    leaf.rotation.set(Math.cos(angle) * .45, angle, -Math.sin(angle) * .5);
  }
  return group;
}
