import { materializeFixture } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/fixtures/materialize.ts';
const target = process.argv[2];
const fixture = await materializeFixture('ts-bug', { targetDir: target });
console.log(`${fixture.path} base ${fixture.headRevision}`);
