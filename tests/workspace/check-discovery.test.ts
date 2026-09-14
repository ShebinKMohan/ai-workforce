import {afterEach,describe,expect,it} from 'vitest';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {resolveProjectChecks} from '../../src/workspace/readiness.js';
import {cleanupAll,gitRepo} from './helpers.js';
afterEach(cleanupAll);
describe('automatic project verification discovery',()=>{
 it('detects a committed check script without running it, and ignores working-tree replacement',async()=>{
  const repoPath=await gitRepo({'package.json':JSON.stringify({scripts:{check:'node check.mjs'}}),'check.mjs':'throw new Error("Do not run during discovery")'});
  writeFileSync(path.join(repoPath,'package.json'),JSON.stringify({scripts:{check:'untrusted-replacement'}}));
  const result=await resolveProjectChecks({id:'app',name:'App',repoPath,checks:[],archived:false});
  expect(result).toMatchObject({count:1,source:'detected'});expect(result.detail).toContain('node check.mjs');expect(result.detail).not.toContain('untrusted');
 });
 it('keeps an existing test script ahead of check and never treats startup/build as proof',async()=>{
  const repoPath=await gitRepo({'package.json':JSON.stringify({scripts:{test:'node --test',check:'node check.mjs'}})});
  expect((await resolveProjectChecks({id:'app',name:'App',repoPath,checks:[],archived:false})).detail).toContain('"test"');
  const other=await gitRepo({'package.json':JSON.stringify({scripts:{build:'node build.mjs',start:'node serve.mjs'}})});
  expect((await resolveProjectChecks({id:'other',name:'Other',repoPath:other,checks:[],archived:false})).count).toBe(0);
 });
});
