const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const rows = value => Array.isArray(value) ? value : [];
const stamp = record => Math.max(0, ...['updatedAt','endedAt','heldAt','startedAt','receivedAt'].map(key => Date.parse(record?.[key] || '') || 0), Date.parse(record?.route?.decidedAt || '') || 0);

function mergeFields(base, local, remote) {
  if (remote === undefined) return local;
  if (equal(local, base)) return remote;
  if (equal(remote, base) || equal(local, remote)) return local;
  if (!object(local) || !object(remote)) return local;
  const result = {};
  for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    result[key] = key === 'messages'
      ? mergeRows(base?.[key], local[key], remote[key], true)
      : key === 'request' && object(local[key]) && object(remote[key])
        ? stamp(remote[key]) > stamp(local[key]) ? remote[key] : local[key]
        : mergeFields(base?.[key], local[key], remote[key]);
  }
  return result;
}

function mergeRows(base, local, remote, messages = false) {
  const before = new Map(rows(base).map(item => [item.id, item]));
  const ours = new Map(rows(local).map(item => [item.id, item]));
  const theirs = new Map(rows(remote).map(item => [item.id, item]));
  const order = messages ? [...rows(remote), ...rows(local)] : [...rows(local).filter(item => !before.has(item.id)), ...rows(remote), ...rows(local)];
  return [...new Set(order.map(item => item.id))].map(id => {
    if (!ours.has(id)) return theirs.get(id);
    if (!theirs.has(id)) return ours.get(id);
    const saved = mergeFields(before.get(id), ours.get(id), theirs.get(id));
    if (messages && stamp(theirs.get(id)?.request) > stamp(ours.get(id)?.request)) return {...saved, text:theirs.get(id).text};
    return saved;
  });
}

/** Three-way merge: an unchanged stale draft cannot overwrite another tab's edits. */
export function mergeConversationStorage(base = {}, local = {}, remote = {}) {
  return {...mergeFields(base, local, remote), threads:mergeRows(base?.threads, local?.threads, remote?.threads).slice(0,100)};
}

/** Adopt peer changes without replacing objects retained by an in-flight upload. */
export function adoptConversationStorage(local, merged) {
  const existing = new Map(rows(local.threads).map(thread => [thread.id, thread]));
  const adopt = (current, saved) => {
    if (!current) return saved;
    for (const key of Object.keys(saved)) if (!equal(current[key], saved[key])) {
      if (key === 'messages') {
        const messages = new Map(rows(current.messages).map(message => [message.id, message]));
        current.messages = rows(saved.messages).map(message => adopt(messages.get(message.id), message));
      } else current[key] = saved[key];
    }
    return current;
  };
  return {...merged, threads:rows(merged.threads).map(thread => adopt(existing.get(thread.id), thread)), feedDraft:adopt(local.feedDraft, merged.feedDraft)};
}

export function createConversationStorage({read, write, initial = {}}) {
  let baseline = JSON.parse(JSON.stringify(initial || {}));
  return { save(local) {
    const merged = mergeConversationStorage(baseline, local, read() || {});
    write(merged);
    baseline = JSON.parse(JSON.stringify(merged));
    return adoptConversationStorage(local, merged);
  }};
}
