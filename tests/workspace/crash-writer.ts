/**
 * Child process for the store crash test: saves a workspace change and is
 * killed with SIGKILL after the temp file is durable and before the rename.
 * Not a test file itself (vitest only collects *.test.ts).
 */
import { addDepartment } from '../../src/workspace/operations.js';
import { updateWorkspace } from '../../src/workspace/store.js';

const stateRoot = process.argv[2];
if (stateRoot === undefined) throw new Error('usage: crash-writer.ts <state-root>');

updateWorkspace(stateRoot, (current) => addDepartment(current, { name: 'Never saved' }), {
  hooks: {
    beforeRename: () => {
      process.kill(process.pid, 'SIGKILL');
    },
  },
});
