#!/usr/bin/env node
// The module this criterion actually executes is named at run time.
const target = process.env['CHECK_IMPL'] ?? './impl-default.mjs';
const mod = await import(target);
process.exit(mod.run());
