/** Bounded read-only enrichment for recorded handoffs; summaries remain status authority. */
export function createFleetRecords({api,onChange=()=>{},now=()=>Date.now()}={}) {
  const records=new Map();
  let pending=null,latest=[],disposed=false,retryTimer;
  const key=run=>`${run.projectId||''}:${run.id}`;
  const signature=run=>JSON.stringify([run.eventCount,run.updatedAt,run.state,run.headReview]);
  const url=run=>run.projectId?`/api/projects/${encodeURIComponent(run.projectId)}/runs/${encodeURIComponent(run.id)}`:`/api/runs/${encodeURIComponent(run.id)}`;
  async function read(run){
    const id=key(run),prior=records.get(id),version=signature(run);
    const awaitingDelivery=(prior?.messages||[]).some(message=>['recorded','submitted'].includes(message.deliveryState));
    const ttl=run.state==='running'||awaitingDelivery?4000:30000;
    if((prior?.version===version&&now()-prior.loadedAt<ttl)||prior?.retryAt>now())return;
    try {
      const after=Math.max(prior?.cursor||0,Number(run.eventCount||0)-500,0);
      const [detail,page]=await Promise.all([api(url(run)),api(`${url(run)}/events?after=${after}&limit=500`)]);
      if(disposed)return;
      const events=new Map((prior?.events||[]).map(e=>[e.sequence,e]));
      for(const event of page.events||[])if(/^(head\.|coordination\.|task\.(accepted|started|settled)|attempt\.started|runtime\.(assistant_message|command_exec|tool_call|tool_result|file_change|error)$)/.test(event.type))events.set(event.sequence,event);
      // Cursor follows the events actually received, never skips an unread page.
      const cursor=Math.max(after,...(page.events||[]).map(e=>Number(e.sequence)||0));
      records.set(id,{version:page.hasMore?null:version,loadedAt:now(),cursor,events:[...events.values()].slice(-500),runId:run.id,projectId:run.projectId||null,taskViews:detail.taskViews,detailSignature:signature(detail.run ? {...detail.run,eventCount:detail.eventCount} : detail),messages:detail.messages||[],messageCount:detail.messageCount,messagesTruncated:detail.messagesTruncated});
      onChange();
    }catch{
      if(!disposed){records.set(id,{...prior,version:null,retryAt:now()+15000});clearTimeout(retryTimer);retryTimer=setTimeout(()=>controller.refresh(latest),15000);}
    }
  }
  async function drain(){
    const candidates=[...latest].sort((a,b)=>Number(b.state==='running')-Number(a.state==='running')).slice(0,12);
    const retained=new Set(candidates.map(key));
    for(const id of records.keys())if(!retained.has(id))records.delete(id);
    let next=0;
    await Promise.all(Array.from({length:2},async()=>{while(!disposed&&next<candidates.length)await read(candidates[next++]);}));
  }
  const controller={
    refresh(runs=[]){latest=runs;if(!pending&&!disposed)pending=(async()=>{let snapshot;do{snapshot=latest;await drain();}while(!disposed&&snapshot!==latest);})().finally(()=>{pending=null;});return pending;},
    runs(runs=[]){return runs.map(run=>{const saved=records.get(key(run));return saved?{...run,...(saved.taskViews?.length&&saved.detailSignature===signature(run)?{taskViews:saved.taskViews}:{}),messages:saved.messages||[],messageCount:saved.messageCount,messagesTruncated:saved.messagesTruncated}:run;});},
    eventPages(){return [...records.values()].filter(r=>r.runId).map(r=>({runId:r.runId,projectId:r.projectId,events:r.events||[]}));},
    dispose(){disposed=true;clearTimeout(retryTimer);clearInterval(refreshTimer);records.clear();},
  };
  // Messages have their own lifecycle and may change without a run event.
  const refreshTimer=setInterval(()=>{if(typeof document==='undefined'||document.visibilityState!=='hidden')controller.refresh(latest);},4000);
  return controller;
}
