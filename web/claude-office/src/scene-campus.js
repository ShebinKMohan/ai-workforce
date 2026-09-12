/**
 * Original, asset-free campus geometry based on the selected office's visual
 * language: pastel islands, substantial shaded edges and sand-colored links.
 * All coordinates are in scene units with Y up. Islands end at Y=.35 and
 * walkway decks at Y=.32. Nothing in this module represents runtime activity.
 */
import * as THREE from './vendor/three.module.min.js';

const ISLAND_TOP = .35;
const WALKWAY_TOP = .32;

function finiteSize(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(.5, value) : fallback;
}

function finish(color, roughness = .86) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
}

/** Resolve strong label accents into the selected office's floor palette. */
export function campusColor(color = '#a9becf') {
  const base = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl, THREE.SRGBColorSpace);
  // Explicit pastel surfaces may be supplied by the layout without changes.
  if (hsl.l >= .80) return base;
  const degrees = hsl.h * 360;
  const pastel = degrees >= 250 && degrees < 315 ? '#d7d2e5'
    : degrees >= 180 && degrees < 250 ? '#d2e1f3'
    : degrees >= 75 && degrees < 180 ? '#d6e4dd'
    : degrees >= 20 && degrees < 75 ? '#f3e8d8'
    : '#f7d8d8';
  return new THREE.Color(pastel);
}

function roundedOutline(points, radius) {
  const corners = points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const before = new THREE.Vector2(previous[0] - point[0], previous[1] - point[1]);
    const after = new THREE.Vector2(next[0] - point[0], next[1] - point[1]);
    const distance = Math.min(radius, before.length() * .32, after.length() * .32);
    before.normalize().multiplyScalar(distance);
    after.normalize().multiplyScalar(distance);
    return { point, incoming: [point[0] + before.x, point[1] + before.y], outgoing: [point[0] + after.x, point[1] + after.y] };
  });
  const shape = new THREE.Shape();
  shape.moveTo(...corners[0].incoming);
  for (const corner of corners) {
    shape.lineTo(...corner.incoming);
    shape.quadraticCurveTo(...corner.point, ...corner.outgoing);
  }
  shape.closePath();
  return shape;
}

function rectangle(width, depth, radius, inset = 0) {
  const x = width / 2 - inset, z = depth / 2 - inset;
  // Shape Y is negative world Z after extrusion rotates onto the floor.
  return roundedOutline([[-x, -z], [x, -z], [x, z], [-x, z]], Math.max(.012, radius - inset));
}

function centralOutline(width, depth, inset = 0) {
  const w = width - inset * 2, d = depth - inset * 2;
  // The back half is broad and octagonal. Inset shoulders open into a
  // narrower front apron, echoing the original central island's cut corners.
  // The mild concavity is intentional; this is not a rectangular plinth.
  const worldPoints = [
    [-w * .28, -d / 2], [w * .28, -d / 2],
    [w / 2, -d * .28], [w / 2, -d * .035],
    [w * .385, d * .08], [w * .385, d * .31],
    [w * .235, d / 2], [-w * .235, d / 2],
    [-w * .385, d * .31], [-w * .385, d * .08],
    [-w / 2, -d * .035], [-w / 2, -d * .28],
  ];
  return roundedOutline(worldPoints.map(([x, z]) => [x, -z]), Math.max(.055, Math.min(w, d) * .027));
}

function slab(parent, outline, bottom, top, topMaterial, sideMaterial, bevel = .012, name = '') {
  const height = top - bottom;
  const b = Math.min(bevel, height * .23);
  const geometry = new THREE.ExtrudeGeometry(outline, {
    depth: height - 2 * b,
    bevelEnabled: b > 0,
    bevelSize: b,
    bevelThickness: b,
    bevelSegments: 3,
    steps: 1,
    curveSegments: 8,
    material: 0,
    extrudeMaterial: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bottom + b, 0);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, [topMaterial, sideMaterial]);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function island(width, depth, color, central) {
  const group = new THREE.Group();
  group.name = central ? 'central-campus-island' : 'department-campus-island';
  const surfaceColor = campusColor(color);
  const sideColor = surfaceColor.clone().lerp(new THREE.Color(central ? '#55766d' : '#7d8790'), central ? .72 : .62);
  const body = finish(sideColor);
  const underside = finish(sideColor.clone().multiplyScalar(.94));
  const rim = finish('#f6f6ee', .78);
  const surface = finish(surfaceColor, .90);
  const radius = Math.min(.43, Math.min(width, depth) * .07);
  const shape = inset => central ? centralOutline(width, depth, inset) : rectangle(width, depth, radius, inset);

  // A slight foot inset and the bevel catch the light without a black outline.
  slab(group, shape(.045), .005, .075, underside, underside, .015, 'island-bottom-edge');
  slab(group, shape(.018), .025, .332, rim, body, .018, 'island-thick-sides');
  // The thin white perimeter survives above the tinted vertical faces.
  slab(group, shape(.029), .323, .344, rim, rim, .005, 'island-white-edge');
  const floor = slab(group, shape(.066), .337, ISLAND_TOP, surface, surface, .0025, 'island-floor');
  group.userData.pickSurface = floor;
  group.userData.floorY = ISLAND_TOP;
  group.userData.width = width;
  group.userData.depth = depth;
  return group;
}

export function createDepartmentIsland(width, depth, color) {
  return island(finiteSize(width, 6), finiteSize(depth, 6), color ?? '#adc4d5', false);
}

export function createCentralIsland(width = 6, depth = 6) {
  return island(finiteSize(width, 6), finiteSize(depth, 6), '#d8e4d9', true);
}

/** A quiet physical connection; board joints indicate construction, not flow. */
export function createWalkway(start, end, width = 1.5) {
  const group = new THREE.Group(); group.name = 'campus-walkway';
  const sx = Number(start?.x), sz = Number(start?.z), ex = Number(end?.x), ez = Number(end?.z);
  if (![sx, sz, ex, ez].every(Number.isFinite)) return group;
  const dx = ex - sx, dz = ez - sz;
  const length = Math.hypot(dx, dz);
  if (length < .02) return group;
  width = finiteSize(width, 1.5);
  group.position.set((sx + ex) / 2, 0, (sz + ez) / 2);
  group.rotation.y = Math.atan2(dx, dz);
  const deck = finish('#f5e8d7', .93);
  const face = finish('#c6bbaa', .91);
  const edge = finish('#faf0dc', .86);
  const radius = Math.min(.065, width * .05, length * .1);
  slab(group, rectangle(width, length, radius, .012), .035, .305, edge, face, .01, 'walkway-side');
  const surface = slab(group, rectangle(width - .035, length - .012, radius, .006), .299, WALKWAY_TOP, deck, edge, .004, 'walkway-deck');

  // Long cream edging and restrained cross joints follow the deck's geometry.
  const seamMaterial = finish('#d7cbb6', .96);
  for (const x of [-width / 2 + .045, width / 2 - .045]) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(.012, .002, Math.max(.02, length - .095)), edge);
    line.position.set(x, WALKWAY_TOP - .001, 0);
    line.receiveShadow = true; group.add(line);
  }
  const boards = Math.max(1, Math.round(length / 1.25));
  for (let i = 1; i < boards; i++) {
    const seam = new THREE.Mesh(new THREE.BoxGeometry(Math.max(.05, width - .105), .0015, .007), seamMaterial);
    seam.position.set(0, WALKWAY_TOP - .00075, -length / 2 + length * i / boards);
    seam.receiveShadow = true; group.add(seam);
  }
  group.userData.pickSurface = surface;
  group.userData.floorY = WALKWAY_TOP;
  return group;
}
