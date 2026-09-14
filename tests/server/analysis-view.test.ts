import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { analysisEvidenceView } from '../../src/storage/analysis-view.js';
import { artifactAbsolutePath, writeArtifact } from '../../src/storage/artifacts.js';
import { appendEvent } from '../../src/storage/events.js';
import { runsDocument, runStatusJson } from '../../src/server/read-api.js';
import { openTempState, seedRunAndTask, type TempState } from '../helpers/state.js';
const states:TempState[]=[];
afterEach(()=>{for(const state of states.splice(0))state.cleanup();});
function fixture(options:{stopped?:boolean;unchanged?:boolean;tools?:number;empty?:boolean}={}) {
  const state=openTempState();states.push(state);const {run,task}=seedRunAndTask(state);const base='a'.repeat(40);
  appendEvent(state.store.db,{runId:run.id,type:'run.created',payload:{workKind:'analysis'}});
  const report=writeArtifact(state.store.db,state.paths,{runId:run.id,taskId:task.id,type:'analysis_report',relativePath:'analysis/report.json',provenance:{producer:'analysisRunner'},bytes:JSON.stringify({runId:run.id,taskId:task.id,baseRevision:base,report:options.empty?'':'Source references and findings.',sourceUnchanged:options.unchanged??true,sessionStopped:options.stopped??true,toolCallCount:options.tools??3})});
  const review={verdict:'passed',sessionStopped:true,reviewId:'review-1',candidateRevision:base};
  const receipt=writeArtifact(state.store.db,state.paths,{runId:run.id,type:'head_review_result',relativePath:'analysis/review.json',provenance:{producer:'headReviewer'},bytes:JSON.stringify(review)});
  const manifest={runId:run.id,base:{revision:base},workKind:'analysis',analysisReviewed:true,accepted:false,reportArtifactIds:[report.id],headReview:{...review,artifactId:receipt.id}};
  appendEvent(state.store.db,{runId:run.id,type:'run.analysis_reviewed',payload:{analysisReviewed:true,reportArtifactIds:[report.id]}});
  appendEvent(state.store.db,{runId:run.id,type:'control.final_reply',payload:{verificationStatus:'reviewed_analysis',source:'department_head_analysis_review',artifactId:receipt.id,reportArtifactIds:[report.id]}});
  const read=()=>analysisEvidenceView(state.store,run.id,manifest);
  return {state,run,task,report,receipt,manifest,read};
}
describe('read-only reviewed analysis evidence',()=>{
  it('publishes reviewed reports and unchanged source without code acceptance',()=>{
    const f=fixture();expect(f.read()).toMatchObject({workKind:'analysis',analysis:{reviewed:true,sourceUnchanged:true,reportCount:1,evidenceIssues:[]}});
    expect(f.read()).not.toHaveProperty('accepted');
  });
  it.each([{stopped:false},{unchanged:false},{tools:0},{empty:true}])('rejects missing execution proof: %j',options=>{
    const f=fixture(options);expect(f.read().analysis?.reviewed).toBe(false);expect(f.read().analysis?.evidenceIssues.length).toBeGreaterThan(0);
  });
  it('revokes reviewed status if report or head review bytes change after delivery',()=>{
    for(const part of ['report','receipt'] as const){const f=fixture();writeFileSync(artifactAbsolutePath(f.state.paths,f[part]),'{}');expect(f.read().analysis?.reviewed).toBe(false);}
  });
  it('requires the manifest and both delivery receipts to name the same report list',()=>{
    const f=fixture();appendEvent(f.state.store.db,{runId:f.run.id,type:'control.final_reply',payload:{verificationStatus:'reviewed_analysis',source:'department_head_analysis_review',artifactId:f.receipt.id,reportArtifactIds:[]}});
    expect(f.read().analysis?.reviewed).toBe(false);
  });
  it('does not promote another run or a changed original source revision',()=>{
    const f=fixture();expect(analysisEvidenceView(f.state.store,f.run.id,{...f.manifest,runId:'elsewhere'}).analysis?.reviewed).toBe(false);
    expect(analysisEvidenceView(f.state.store,f.run.id,{...f.manifest,base:{revision:'b'.repeat(40)}}).analysis?.reviewed).toBe(false);
  });
  it('does not trust an unavailable or compromised manifest',()=>{
    const f=fixture();expect(analysisEvidenceView(f.state.store,f.run.id,null)).toMatchObject({workKind:'analysis',analysis:{reviewed:false,sourceUnchanged:false}});
    expect(analysisEvidenceView(f.state.store,f.run.id,f.manifest,['Manifest hash mismatch']).analysis?.reviewed).toBe(false);
  });
  it('exposes the same hash-verified report state through list and detail reads',()=>{
    const f=fixture();writeArtifact(f.state.store.db,f.state.paths,{runId:f.run.id,type:'analysis_result',relativePath:'result.json',provenance:{producer:'analysisRunner'},bytes:JSON.stringify(f.manifest)});
    const page=runsDocument(f.state.paths,10) as {runs:Array<{analysis:unknown;workKind:string}>};
    const detail=JSON.parse(runStatusJson(f.state.root,f.run.id)) as {analysis:unknown;workKind:string};
    expect(page.runs[0]?.workKind).toBe('analysis');expect(page.runs[0]?.analysis).toEqual(detail.analysis);expect(detail.analysis).toMatchObject({reviewed:true,sourceUnchanged:true});
  });
  it('does not recategorize ordinary implementation work',()=>{
    const state=openTempState();states.push(state);const {run}=seedRunAndTask(state);
    expect(analysisEvidenceView(state.store,run.id,{acceptance:{accepted:true}})).toEqual({workKind:'implementation',analysis:null});
  });
});
