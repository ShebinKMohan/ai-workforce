#!/usr/bin/env node
import { existsSync } from 'node:fs';
if (existsSync('docs/note.md')) { process.stdout.write('docs/note.md is present\n'); process.exit(0); }
process.stdout.write('docs/note.md is missing\n');
process.exit(1);
