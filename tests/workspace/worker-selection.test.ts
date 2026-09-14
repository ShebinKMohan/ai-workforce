import {describe,it,expect} from 'vitest';
import {rankAvailableWorkers} from '../../src/workspace/worker-selection.js';
import type {WorkspaceAgent} from '../../src/core/workspace-config.js';
const worker=(id:string,capabilities:string[],policy:WorkspaceAgent['policy']='local-development')=>({id,name:id,role:'worker',runtime:'runtime',departmentId:'engineering',capabilities,policy,projectIds:[],instructions:'Work within the role',archived:false} satisfies WorkspaceAgent);
describe('available specialist selection',()=>{
 const workers=[worker('ui',['frontend','design']),worker('api',['backend','api']),worker('architect',['architecture','review'],'analysis')];
 it('selects relevant capabilities ahead of roster order',()=>{
  expect(rankAvailableWorkers(workers,{task:'Fix the backend API',workKind:'implementation',preferredWorkerIds:[]})[0]?.id).toBe('api');
 });
 it('honors semantic intake preference only within the available admitted roster',()=>{
  expect(rankAvailableWorkers(workers.slice(0,2),{task:'Review system',workKind:'analysis',preferredWorkerIds:['architect','api']}).map(w=>w.id)).toEqual(['api','ui']);
 });
 it('prefers read-oriented specialists for generic analysis and keeps a stable order',()=>{
  expect(rankAvailableWorkers(workers,{task:'Explain this codebase',workKind:'analysis',preferredWorkerIds:[]}).map(w=>w.id)).toEqual(['architect','ui','api']);
 });
});
