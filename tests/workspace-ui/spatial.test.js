import { describe, expect, it, vi } from 'vitest';
import { initialRasterMode, rasterModel, rasterOfficeHtml, seatPatch } from '../../web/workspace/src/office/raster.js';
import { floorModel } from '../../web/workspace/src/office/floor-model.js';
import { createCamera } from '../../web/workspace/src/office/raster-camera.js';
import { clone, contextFor, fixture } from './support.js';

const context = (live = false) => contextFor(fixture('workspace.json'), fixture(live ? 'runs-live.json' : 'runs.json'), fixture(live ? 'requests-live.json' : 'requests.json'));
const floor = (ctx) => floorModel(ctx.ws, ctx.runsDoc, ctx.entries);

describe('the original illustrated office uses actual workspace occupants', () => {
  it('starts phones with the readable team and preserves an explicit map choice', () => {
    expect(initialRasterMode(390)).toBe('team');
    expect(initialRasterMode(1512)).toBe('map');
    expect(initialRasterMode(390, 'map')).toBe('map');
  });

  it('preserves a panned/zoomed camera while the Team view hides its viewport', () => {
    let onResize;
    const viewport = { clientWidth: 650, clientHeight: 500, hidden: false, style: {}, classList: { toggle() {}, remove() {} }, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class { constructor(callback) { onResize = callback; } observe() {} disconnect() {} });
    let camera;
    try {
      camera = createCamera({ viewport, world: { style: {} } });
      camera.zoomBy(1.8);
      const before = camera.getState();
      viewport.hidden = true;
      viewport.clientWidth = 0;
      viewport.clientHeight = 0;
      onResize();
      expect(camera.getState()).toEqual(before);
      viewport.hidden = false;
      viewport.clientWidth = 650;
      viewport.clientHeight = 500;
      onResize();
      expect(camera.getState()).toEqual(before);
    } finally {
      camera?.destroy();
      vi.unstubAllGlobals();
    }
  });
  it('covers all 24 unassigned figures and labels every island unassigned in an empty workspace', () => {
    const ctx = contextFor(fixture('workspace-empty.json'), fixture('runs-empty.json'), fixture('requests-empty.json'));
    const html = rasterOfficeHtml(floor(ctx));
    expect(html).toContain('src="/assets/office-inward.png"');
    expect(html).toContain("background-image:url('/assets/office-inward-empty.png')");
    expect(html.match(/data-raster-open-seat=/g)).toHaveLength(24);
    expect(html.match(/Unassigned · add a department/g)).toHaveLength(12);
    expect(html).not.toContain('data-raster-agent=');
    expect(html).toContain('System scheduler · 0 active · 0 queued');
    expect(html).toContain('No team configured yet');
    expect(html).not.toMatch(/25 agents|agents online|Memory synced|Models connected/);
  });

  it('keeps heads first and retains configured membership rather than inferring it from capabilities', () => {
    const model = rasterModel(floor(context()));
    const eng = model.islands.find((island) => island.id === 'engineering');
    const design = model.islands.find((island) => island.id === 'design');
    expect(eng.department.id).toBe('eng');
    expect(eng.seats.map((seat) => seat.desk?.agentId)).toEqual(['atlas', 'nova', 'mira', 'bench']);
    expect(design.department.id).toBe('design');
    expect(design.seats.map((seat) => seat.desk?.agentId ?? null)).toEqual(['vera', 'mo', null, null]);
    expect(model.totalAgents).toBe(6);
    expect(model.assignedSeats).toBe(6);
    expect(model.overflow).toEqual([]);
  });

  it('links configured occupants to their actual live tasks and never assigns the center person a model', () => {
    const ctx = context(true);
    const f = floor(ctx);
    const html = rasterOfficeHtml(f, { active: 1, queued: 0 });
    for (const desk of f.departments.flatMap((department) => department.desks)) {
      expect(html).toContain(`data-raster-agent="${desk.agentId}"`);
      expect(html).toContain(`href="${desk.href}"`);
    }
    expect(html).toContain('Nova, worker in Engineering. Working on');
    expect(html).toContain('System scheduler · 1 active · 0 queued');
    expect(html).not.toContain('data-raster-agent="coordinator"');
    expect(html.match(/data-raster-open-seat=/g)).toHaveLength(18);
  });

  it('shows unlocked work as Stalled and settled workers as Available', () => {
    const ctx = context(true);
    ctx.runsDoc = clone(ctx.runsDoc);
    for (const run of ctx.runsDoc.runs) run.projectLock = { held: false };
    ctx.entries = [];
    const html = rasterOfficeHtml(floor(ctx));
    expect(html).toContain('Stalled');
    expect(html).not.toContain(' is-active');
    const settled = rasterOfficeHtml(floor(context()));
    expect(settled).toContain('Available');
    expect(settled).not.toContain('tone-verified');
  });

  it('keeps every overflow worker and department reachable in the real Team list', () => {
    const base = floor(context()).departments[0];
    const departments = Array.from({ length: 8 }, (_, i) => ({ ...base, id: `dept-${i}`, label: `Custom team ${i}`, href: `#/departments/dept-${i}`, desks: Array.from({ length: 5 }, (_, j) => ({ ...base.desks[j % 4], agentId: `person-${i}-${j}`, name: `Person ${i} ${j}` })) }));
    const f = { departments, createTile: { enabled: true, href: '#/departments/new' } };
    const model = rasterModel(f);
    expect(model.assignedSeats).toBe(24);
    expect(model.totalAgents).toBe(40);
    expect(model.overflow).toHaveLength(16);
    expect(model.overflowDepartments).toHaveLength(2);
    const html = rasterOfficeHtml(f);
    expect(html).toContain('16 more people in Team list');
    for (let i = 0; i < 8; i += 1) for (let j = 0; j < 5; j += 1) expect(html).toContain(`Person ${i} ${j}`);
    expect(html).toContain('href="#/departments/dept-7"');
  });

  it('reserves the intended visual slot for a named department before seating custom names', () => {
    const base = floor(context()).departments[0];
    const model = rasterModel({ departments: [{ ...base, id: 'custom', label: 'Team Alpha' }, { ...base, id: 'research-team', label: 'Research' }] });
    expect(model.islands.find((island) => island.id === 'research').department.id).toBe('research-team');
    expect(model.islands.find((island) => island.id === 'engineering').department.id).toBe('custom');
  });

  it('escapes names and identifiers in label text, links and aria descriptions', () => {
    const f = floor(context());
    f.departments[0].label = '<img src=x onerror=alert(1)>';
    f.departments[0].desks[0].name = '"><script>alert(1)</script>';
    f.departments[0].desks[0].agentId = '" onclick="alert(1)';
    const html = rasterOfficeHtml(f);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('data-raster-agent="" onclick=');
    expect(html).toContain('&lt;script&gt;');
  });

  it('exposes labeled pan/zoom/fit, configured routing and full team controls without launching work', () => {
    const html = rasterOfficeHtml(floor(context()));
    expect(html).toContain('data-raster-viewport tabindex="0"');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Fit office to view"');
    expect(html).toContain('data-raster-mode="connections"');
    expect(html).toContain('data-raster-mode="team"');
    expect(html).not.toContain('data-action="open-sheet"');
  });

  it('can cover only unassigned seats with aligned empty-art regions without replacing occupied people', () => {
    const f = floor(context());
    const html = rasterOfficeHtml(f, { active: 0, queued: 0 });
    expect(html.match(/class="raster-seat-patch"/g)).toHaveLength(18);
    expect(html).not.toContain('class="raster-seat-veil"');
    expect(html).not.toContain('data-raster-open-seat="engineering-0"');
    expect(html).not.toContain('data-raster-open-seat="engineering-1"');
    expect(html).toContain('data-raster-open-seat="research-0"');
    const patch = seatPatch({ id: 'engineering-2' });
    // The inward-facing bottom monitor spans x943–985; the old figure crop cut it at x970.
    expect(patch.left).toBeLessThan(943);
    expect(patch.left + patch.width).toBeGreaterThan(1048);
    expect(patch.top).toBeLessThan(235);
    expect(patch.top + patch.height).toBeGreaterThan(360);
    for (const island of rasterModel(f).islands) for (const seat of island.seats) {
      const region = seatPatch(seat);
      expect(region.left).toBeLessThan(seat.x);
      expect(region.left + region.width).toBeGreaterThan(seat.x);
      expect(region.top).toBeLessThan(seat.y);
      expect(region.top + region.height).toBeGreaterThan(seat.y);
    }
    expect(html).toContain('background-position:-359px -65px');
  });
});
