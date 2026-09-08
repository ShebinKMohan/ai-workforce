import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const mode = process.argv[3] ?? 'events';
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);
if (mode === 'schema') {
  for (const t of tables) console.log(t, ':', db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map(r=>r.name).join(', '));
  process.exit(0);
}
if (mode === 'events') {
  const cols = db.prepare("SELECT name FROM pragma_table_info('events')").all().map(r=>r.name);
  const filter = process.argv[4];
  const rows = db.prepare('SELECT * FROM events ORDER BY rowid').all();
  for (const r of rows) {
    const s = JSON.stringify(r);
    if (filter && !s.includes(filter)) continue;
    console.log(s.length > 2000 ? s.slice(0,2000)+'…' : s);
  }
  process.exit(0);
}
if (mode === 'types') {
  for (const r of db.prepare('SELECT type, COUNT(*) c FROM events GROUP BY type ORDER BY type').all()) console.log(r.c, r.type);
  process.exit(0);
}
if (mode === 'messages') {
  const rows = db.prepare('SELECT * FROM messages ORDER BY rowid').all();
  console.log(`# ${rows.length} message row(s)`);
  for (const r of rows) console.log(JSON.stringify(r));
  process.exit(0);
}
if (mode === 'tasks') {
  for (const r of db.prepare('SELECT * FROM tasks ORDER BY rowid').all()) console.log(JSON.stringify(r));
  process.exit(0);
}
if (mode === 'attempts') {
  for (const r of db.prepare('SELECT * FROM attempts ORDER BY rowid').all()) console.log(JSON.stringify(r));
  process.exit(0);
}
console.error('unknown mode'); process.exit(2);
