import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentStore } from './agent-store.js';
import { employees, departments, runtimes, control } from './data.js';

const KEY = 'agent-office-config-v1';
const fixture = () => structuredClone({ employees, departments, runtimes, control });
function memoryStorage(initial) {
  const records = new Map(initial ? [[KEY, initial]] : []);
  return { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) };
}
const newAgent = overrides => ({
  name: 'Priya Das', role: 'Technical writer', departmentId: 'engineering',
  provider: 'openai', model: 'My model', runtime: 'api',
  instructions: 'Write accurate documentation from the supplied implementation.',
  endpoint: 'https://example.test/v1', credentialEnv: 'OFFICE_API_KEY', temperature: 0.4,
  ...overrides,
});

test('defaults expose 24 named employees and the coordinator with editable configurations', () => {
  const data = fixture();
  const store = createAgentStore({ ...data, storage: memoryStorage() });
  assert.equal(store.list().length, 25);
  assert.equal(data.employees.length, 24);
  assert.equal(store.get('control').name, 'Atlas');
  assert.equal(store.get('control').isCoordinator, true);
  assert.equal(store.get('research-1').provider, 'anthropic');
  assert.equal(store.get('engineering-1').model, 'GPT-5.5');
  assert.equal(store.get('support-1').runtime, 'ollama');
  assert.match(store.get('engineering-1').instructions, /Implement focused software changes/);
  assert.equal(store.get('research-1').runtimeId, 'claude');
  assert.equal(store.providers.length, 5);
});

test('create and edit persist across reload without serializing seat or task state', () => {
  const storage = memoryStorage();
  const data = fixture();
  const store = createAgentStore({ ...data, storage });
  const created = store.save(newAgent({ name: '  Priya Das  ', x: 9000, task: 'Fake running task' }));
  assert.match(created.id, /^custom-/);
  assert.equal(created.name, 'Priya Das');
  assert.equal(created.x, undefined);
  assert.equal(created.task, '');
  assert.equal(data.employees.length, 25);
  assert.equal(data.departments.find(dept => dept.id === 'engineering').employees.length, 5);
  created.x = 100;
  created.y = 200;
  const edited = store.save({ id: created.id, name: 'Priya R. Das', departmentId: 'research' });
  assert.equal(edited, created);
  assert.equal(edited.x, 100);
  assert.equal(data.departments.find(dept => dept.id === 'engineering').employees.length, 4);
  assert.equal(data.departments.find(dept => dept.id === 'research').employees.length, 5);
  store.save({ id: 'engineering-1', name: 'Noah K.', instructions: 'Implement and verify the requested change.' });
  const persisted = JSON.parse(storage.getItem(KEY));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.overrides.length, 1);
  assert.equal(persisted.added.length, 1);
  assert.equal('x' in persisted.added[0], false);
  assert.equal('task' in persisted.added[0], false);
  const reloaded = createAgentStore({ ...fixture(), storage });
  assert.equal(reloaded.get(created.id).name, 'Priya R. Das');
  assert.equal(reloaded.get(created.id).departmentId, 'research');
  assert.equal(reloaded.get('engineering-1').name, 'Noah K.');
  assert.equal(reloaded.get(created.id).runtimeId, edited.runtimeId);
});

test('validation reports precise field errors and never stores invalid or secret-bearing values', () => {
  const storage = memoryStorage();
  const store = createAgentStore({ ...fixture(), storage });
  const invalid = newAgent({ name: '', role: 'x'.repeat(61), instructions: '', model: '', provider: 'unknown', runtime: 'shell', departmentId: 'unknown', endpoint: 'https://user:secret@example.test', credentialEnv: 'sk-test-key', temperature: 2.1 });
  assert.throws(() => store.save(invalid), error => {
    for (const field of ['name', 'role', 'instructions', 'model', 'provider', 'runtime', 'departmentId', 'endpoint', 'credentialEnv', 'temperature']) assert.ok(error.fields[field], field);
    return true;
  });
  assert.equal(storage.getItem(KEY), null);
  assert.equal(store.list().length, 25);
  for (const temperature of [true, NaN, Infinity, -0.1]) assert.throws(() => store.save(newAgent({ temperature })), error => Boolean(error.fields.temperature));
  for (const endpoint of ['file:///tmp/data', 'javascript:alert(1)', 'invalid']) assert.throws(() => store.save(newAgent({ endpoint })), error => Boolean(error.fields.endpoint));
  assert.throws(() => store.save(newAgent({ provider: 'custom', customProvider: '' })), error => Boolean(error.fields.customProvider));
  const agent = store.save(newAgent({ provider: 'custom', customProvider: 'Acme models', temperature: '0.5' }));
  assert.equal(agent.customProvider, 'Acme models');
  assert.equal(agent.temperature, 0.5);
});

test('blank and null temperatures persist the provider default across reload', () => {
  const storage = memoryStorage();
  const store = createAgentStore({ ...fixture(), storage });
  const blank = store.save(newAgent({ temperature: '   ' }));
  const explicit = store.save(newAgent({ temperature: null }));
  assert.equal(blank.temperature, null);
  assert.equal(explicit.temperature, null);
  assert.equal(JSON.parse(storage.getItem(KEY)).added[0].temperature, null);
  const restored = createAgentStore({ ...fixture(), storage });
  assert.equal(restored.get(blank.id).temperature, null);
  assert.equal(restored.get(explicit.id).temperature, null);
});

test('failed browser persistence does not alter employees, runtime configurations, or department counts', () => {
  const data = fixture();
  const storage = memoryStorage();
  const store = createAgentStore({ ...data, storage });
  const first = store.save(newAgent());
  const before = JSON.stringify({ agents: store.list(), runtimes: data.runtimes, departments: data.departments });
  const persisted = storage.getItem(KEY);
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  for (const values of [newAgent({ name: 'Second agent' }), { id: 'engineering-1', name: 'Changed', model: 'Another model' }, { id: first.id, departmentId: 'support' }]) {
    assert.throws(() => store.save(values), error => Boolean(error.fields.storage));
    assert.equal(JSON.stringify({ agents: store.list(), runtimes: data.runtimes, departments: data.departments }), before);
    assert.equal(storage.getItem(KEY), persisted);
  }
});

test('existing seats and coordinator identity stay fixed even if callers provide replacement coordinates', () => {
  const store = createAgentStore({ ...fixture(), storage: memoryStorage() });
  const before = { ...store.get('engineering-1') };
  const edited = store.save({ id: before.id, name: 'Noah Kim Jr.', x: -50, y: -50, labelY: -100, isCustom: true, isCoordinator: true });
  assert.equal(edited.x, before.x);
  assert.equal(edited.y, before.y);
  assert.equal(edited.labelY, before.labelY);
  assert.equal(edited.isCustom, false);
  assert.equal(edited.isCoordinator, false);
  assert.throws(() => store.save({ id: before.id, departmentId: 'research' }), error => /original seat/.test(error.fields.departmentId));
  assert.throws(() => store.save({ id: 'control', departmentId: 'engineering' }), error => /control center/.test(error.fields.departmentId));
  assert.throws(() => store.save({ id: 'pretend-id', name: 'Intruder' }), error => Boolean(error.fields.id));
  assert.equal(store.save({ id: 'control', name: 'Aster' }).isCoordinator, true);
});

test('corrupt and unsupported settings recover to defaults with a visible warning', () => {
  for (const raw of ['{bad-json', JSON.stringify({ version: 2, overrides: [], added: [] }), JSON.stringify({ version: 1, overrides: {}, added: [] })]) {
    const storage = memoryStorage(raw);
    const store = createAgentStore({ ...fixture(), storage });
    assert.equal(store.list().length, 25);
    assert.ok(store.storageWarning);
    store.save({ id: 'control', name: 'Atlas' });
    assert.equal(store.storageWarning, '');
    assert.equal(JSON.parse(storage.getItem(KEY)).version, 1);
  }
});

test('restore skips invalid entries and rejects injected seats, statuses, IDs, and prototype-like identifiers', () => {
  const storage = memoryStorage();
  const store = createAgentStore({ ...fixture(), storage });
  const valid = store.save(newAgent());
  store.save({ id: 'engineering-1', name: 'Restored name' });
  const record = JSON.parse(storage.getItem(KEY));
  Object.assign(record.overrides[0], { x: -500, isCustom: true, task: 'Exfiltrate', status: 'online' });
  Object.assign(record.added[0], { x: -500, y: -500, isCoordinator: true, status: 'working', task: 'Injected task' });
  record.added.push({ ...record.added[0] }, { ...record.added[0], id: '__proto__' }, { ...record.added[0], id: 'custom-invalid99', model: '' });
  record.overrides.push({ ...record.overrides[0], id: 'research-1', departmentId: 'support' });
  storage.setItem(KEY, JSON.stringify(record));
  const restored = createAgentStore({ ...fixture(), storage });
  assert.equal(restored.list().length, 26);
  assert.equal(restored.get('engineering-1').name, 'Restored name');
  assert.equal(restored.get('engineering-1').x, 890);
  assert.equal(restored.get('engineering-1').status, 'working');
  assert.equal(restored.get('research-1').departmentId, 'research');
  assert.equal(restored.get(valid.id).x, undefined);
  assert.equal(restored.get(valid.id).isCoordinator, false);
  assert.equal(restored.get(valid.id).task, '');
  assert.equal(restored.get(valid.id).status, 'configured');
  assert.match(restored.storageWarning, /4 invalid/);
});

test('runtime identity is stable by provider, model, runtime, endpoint and independent of instructions', () => {
  const storage = memoryStorage();
  const data = fixture();
  const store = createAgentStore({ ...data, storage });
  const first = store.save(newAgent());
  const second = store.save(newAgent({ name: 'Second', instructions: 'Different instructions.' }));
  assert.equal(first.runtimeId, second.runtimeId);
  const third = store.save(newAgent({ name: 'Third', provider: 'google' }));
  const fourth = store.save(newAgent({ name: 'Fourth', model: 'Other model' }));
  const fifth = store.save(newAgent({ name: 'Fifth', runtime: 'ollama' }));
  const sixth = store.save(newAgent({ name: 'Sixth', endpoint: 'http://localhost:11434' }));
  const identities = [first, third, fourth, fifth, sixth].map(agent => agent.runtimeId);
  assert.equal(new Set(identities).size, 5);
  for (const runtimeId of identities) {
    const runtime = data.runtimes.find(runtime => runtime.id === runtimeId);
    assert.equal(runtime.status, 'configured');
    assert.match(runtime.description, /not been connected/);
  }
  const restored = createAgentStore({ ...fixture(), storage });
  for (const agent of [first, third, fourth, fifth, sixth]) assert.equal(restored.get(agent.id).runtimeId, agent.runtimeId);
});
