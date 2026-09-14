import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestTaskStatus,taskWorkStatus} from '../../src/headquarters/task-status.js';
import {projectRunPresentation} from '../../src/headquarters/projects.js';

test('project history shares the strict reviewed-analysis evidence status',()=>{
  const run={id:'analysis',workKind:'analysis',state:'ready_for_review',analysis:{reviewed:true,sourceUnchanged:true,reportCount:1,evidenceIssues:[]}};
  assert.deepEqual(projectRunPresentation(run),{bucket:'done',label:'Reviewed analysis',tone:'complete'});
  for(const analysis of [{...run.analysis,reviewed:false},{...run.analysis,sourceUnchanged:false},{...run.analysis,reportCount:0},{...run.analysis,evidenceIssues:['missing report']}]){
    assert.equal(projectRunPresentation({...run,analysis}).tone,'blocked');
  }
  assert.equal(projectRunPresentation({...run,state:'interrupted'}).label,'Stopped');
  assert.equal(projectRunPresentation({...run,workKind:'implementation'}).label,'ready for review');
});

test('routing and queued work have distinct live buckets',()=>{
  assert.equal(requestTaskStatus({state:'queued',route:{state:'pending'}}).bucket,'progress');
  assert.equal(requestTaskStatus({state:'queued',route:{state:'delegated'}}).bucket,'backlog');
  assert.equal(requestTaskStatus({state:'held'}).bucket,'waiting');
});
test('successful chat and work count as done; interruption and failed verification do not',()=>{
  assert.equal(requestTaskStatus({state:'ended',exitCode:0,controlReply:'Answer'}).bucket,'done');
  assert.equal(requestTaskStatus({state:'ended',exitCode:0,runId:'r'},{state:'failed'}).bucket,'waiting');
  assert.equal(requestTaskStatus({state:'ended',exitCode:0,runId:'r'},{headReview:{state:'changes_requested'}}).bucket,'waiting');
  assert.equal(requestTaskStatus({state:'ended',exitCode:0,runId:'r'},{state:'interrupted'}).bucket,'closed');
  assert.equal(requestTaskStatus({state:'ended',exitCode:0,signal:'SIGTERM'}).bucket,'closed');
  assert.equal(requestTaskStatus({state:'discarded'}).bucket,'closed');
  assert.equal(requestTaskStatus({state:'discarded',route:{state:'blocked'}}).bucket,'closed');
  assert.equal(requestTaskStatus({state:'failed_to_start'}).bucket,'waiting');
});
test('completed runtime attempts are not accepted tasks',()=>{
  assert.equal(taskWorkStatus({state:'validating',attempt:{state:'completed'}}).bucket,'progress');
  assert.equal(taskWorkStatus({state:'accepted',attempt:{state:'completed'}}).bucket,'done');
  assert.equal(taskWorkStatus({state:'superseded'}).bucket,'closed');
  assert.equal(taskWorkStatus({state:'waiting',waitReason:'dependency'}).bucket,'backlog');
  assert.equal(taskWorkStatus({state:'waiting',waitReason:'user_intent'}).bucket,'waiting');
});
