import {describe,expect,it,vi} from 'vitest';
const path='../../web/headquarters/src/headquarters/fleet-records.js';
const {createFleetRecords}=await import(path);
const run={id:'run',projectId:'project',state:'running',eventCount:2,updatedAt:'now',taskViews:[{id:'task',state:'running'}]};
describe('fleet read-only history cache',()=>{
 it('caches unchanged runs and enriches messages without replacing summary status',async()=>{
  const api=vi.fn(async(url:string)=>url.includes('/events?')?{events:[{sequence:2,type:'head.assigned',payload:{agentId:'worker'}}],hasMore:false}:{state:'cancelled',taskViews:[],messages:[{id:'message'}],messageCount:1});
  const cache=createFleetRecords({api});await cache.refresh([run]);await cache.refresh([run]);
  expect(api).toHaveBeenCalledTimes(2);
  expect(cache.runs([run])[0]).toMatchObject({state:'running',taskViews:run.taskViews,messages:[{id:'message'}]});
  expect(cache.eventPages()[0]).toMatchObject({projectId:'project',runId:'run',events:[{sequence:2}]});cache.dispose();
 });
 it('reads only the recent event window and keeps project identities separate',async()=>{
  const api=vi.fn(async(url:string)=>url.includes('/events?')?{events:[],hasMore:false}:{messages:[{id:url}]});
  const cache=createFleetRecords({api});const other={...run,projectId:'other',eventCount:900};await cache.refresh([run,other]);
  expect(api).toHaveBeenCalledWith('/api/projects/other/runs/run/events?after=400&limit=500');
  expect(cache.runs([run,other]).map((r:{messages:Array<{id:string}>})=>r.messages[0]?.id)).toEqual(['/api/projects/project/runs/run','/api/projects/other/runs/run']);cache.dispose();
 });
 it('does not let an in-flight request discard a newer summary refresh',async()=>{
  let resolveFirst:()=>void=()=>{};const wait=new Promise<void>(resolve=>{resolveFirst=resolve;});let calls=0;
  const api=vi.fn(async(url:string)=>{if(calls++===0)await wait;return url.includes('/events?')?{events:[],hasMore:false}:{messages:[]};});
  const cache=createFleetRecords({api});const reading=cache.refresh([run]);cache.refresh([{...run,eventCount:3}]);resolveFirst();await reading;
  expect(api).toHaveBeenCalledTimes(4);cache.dispose();
 });
 it('retains last received data and backs off failed reads',async()=>{
  let current=0;let fail=false;const api=vi.fn(async(url:string)=>{if(fail)throw Error('offline');return url.includes('/events?')?{events:[],hasMore:false}:{messages:[{id:'saved'}]};});
  const cache=createFleetRecords({api,now:()=>current});await cache.refresh([run]);fail=true;
  await cache.refresh([{...run,eventCount:3}]);const calls=api.mock.calls.length;await cache.refresh([{...run,eventCount:4}]);
  expect(api).toHaveBeenCalledTimes(calls);expect(cache.runs([run])[0].messages).toEqual([{id:'saved'}]);current=16000;fail=false;await cache.refresh([{...run,eventCount:4}]);expect(api.mock.calls.length).toBeGreaterThan(calls);cache.dispose();
 });
 it('refreshes message receipts independently of an unchanged run summary',async()=>{
  vi.useFakeTimers();let deliveryState='submitted';
  const api=vi.fn(async(url:string)=>url.includes('/events?')?{events:[],hasMore:false}:{messages:[{id:'message',deliveryState}]});
  const cache=createFleetRecords({api});
  try{await cache.refresh([run]);deliveryState='acknowledged';await vi.advanceTimersByTimeAsync(4000);
   expect(cache.runs([run])[0].messages[0].deliveryState).toBe('acknowledged');expect(api).toHaveBeenCalledTimes(4);
  }finally{cache.dispose();vi.useRealTimers();}
 });
 it('bounds hydration and skips runtime prose in the overview event cache',async()=>{
  const api=vi.fn(async(url:string)=>url.includes('/events?')?{events:[{sequence:1,type:'runtime.output',payload:{text:'untrusted'}},{sequence:2,type:'head.planning_started'}],hasMore:false}:{messages:[]});
  const cache=createFleetRecords({api});await cache.refresh(Array.from({length:30},(_,i)=>({...run,id:`r${i}`})));
  expect(api).toHaveBeenCalledTimes(24);expect(cache.eventPages()).toHaveLength(12);expect(cache.eventPages()[0].events).toEqual([{sequence:2,type:'head.planning_started'}]);cache.dispose();
 });
 it('enriches matching task detail and normalized activity without accepting stale state or raw reasoning',async()=>{
  const detail={run:{id:'run',state:'running',updatedAt:'now'},eventCount:2,taskViews:[{id:'task',state:'running',objective:'Inspect API',attempt:{startedAt:'then'}}]};
  const api=vi.fn(async(url:string)=>url.includes('/events?')?{events:[{sequence:1,type:'runtime.reasoning',payload:{text:'private'}},{sequence:2,type:'runtime.command_exec',taskId:'task',payload:{command:'rg --files'}}],hasMore:false}:detail);
  const cache=createFleetRecords({api});await cache.refresh([run]);
  expect(cache.runs([run])[0].taskViews[0].objective).toBe('Inspect API');
  expect(cache.runs([{...run,eventCount:3}])[0].taskViews).toEqual(run.taskViews);
  expect(cache.eventPages()[0].events.map((event:{type:string})=>event.type)).toEqual(['runtime.command_exec']);cache.dispose();
 });
 it('retains task context while the same department-head review is active',async()=>{
  const headReview={state:'running',headAgentId:'head'};
  const detail={run:{id:'run',state:'running',updatedAt:'now'},eventCount:2,headReview,taskViews:[{id:'task',state:'validating',objective:'Inspect API',attempt:{startedAt:'then'}}]};
  const api=vi.fn(async(url:string)=>url.includes('/events?')?{events:[],hasMore:false}:detail);
  const cache=createFleetRecords({api});
  try{await cache.refresh([{...run,headReview}]);expect(cache.runs([{...run,headReview}])[0].taskViews[0].objective).toBe('Inspect API');expect(cache.runs([{...run,headReview:{state:'passed'}}])[0].taskViews).toEqual(run.taskViews);}finally{cache.dispose();}
 });
 it('recovers final delivery context but excludes head raw and reasoning payloads',async()=>{
  const events=[{sequence:1,type:'head.runtime.raw',payload:{text:'private raw'}},{sequence:2,type:'head.runtime.reasoning_delta',payload:{text:'private reasoning'}},{sequence:3,type:'control.final_reply',payload:{verificationStatus:'reviewed_analysis'}},{sequence:4,type:'run.analysis_reviewed'}];
  const api=vi.fn(async(url:string)=>url.includes('/events?')?{events,hasMore:false}:{messages:[]});
  const cache=createFleetRecords({api});
  try{await cache.refresh([run]);expect(cache.eventPages()[0].events.map((event:{type:string})=>event.type)).toEqual(['control.final_reply','run.analysis_reviewed']);}finally{cache.dispose();}
 });

 it('does not notify on an unchanged TTL refresh but notifies changed activity and removal',async()=>{
  let current=0,changed=false;
  const onChange=vi.fn();
  const api=vi.fn(async(url:string)=>url.includes('/events?')?{events:changed?[{sequence:3,type:'runtime.command_exec',taskId:'task',payload:{command:'npm test'}}]:[],hasMore:false}:{run:{id:'run',state:'running',updatedAt:'now'},eventCount:2,taskViews:[{id:'task',state:'running'}],messages:[]});
  const cache=createFleetRecords({api,onChange,now:()=>current});
  try{
   await cache.refresh([run]);expect(onChange).toHaveBeenCalledTimes(1);
   current=5000;await cache.refresh([structuredClone(run)]);expect(api).toHaveBeenCalledTimes(4);expect(onChange).toHaveBeenCalledTimes(1);
   current=10000;changed=true;await cache.refresh([run]);expect(onChange).toHaveBeenCalledTimes(2);
   await cache.refresh([]);expect(onChange).toHaveBeenCalledTimes(3);expect(cache.eventPages()).toEqual([]);
  }finally{cache.dispose();}
 });
 it('retains exact head lifecycle identities for recorded phase durations',async()=>{
  const events=[{sequence:1,type:'head.review_started',timestamp:'2026-09-14T10:00:00Z',payload:{headAgentId:'head',reviewId:'review-one'}},{sequence:2,type:'head.review_finished',timestamp:'2026-09-14T10:02:00Z',payload:{headAgentId:'head',reviewId:'review-one',verdict:'passed'}}];
  const api=vi.fn(async(url:string)=>url.includes('/events?')?{events,hasMore:false}:{messages:[]});
  const cache=createFleetRecords({api});
  try{await cache.refresh([run]);expect(cache.eventPages()[0].events).toEqual(events);}finally{cache.dispose();}
 });

});
