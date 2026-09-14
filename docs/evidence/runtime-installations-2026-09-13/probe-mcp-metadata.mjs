import { CodexRpcClient } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/src/adapters/codex/rpc.ts';
import { createCoordinationBridge } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/src/coordination/index.ts';
import { openStateStore } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/src/storage/db.ts';
import { createStatePaths } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/src/storage/paths.ts';
import { seedAttempt, seedRun, seedTask } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/tests/coordination/helpers.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const results=[];
for (const [label, executablePath] of [['homebrew','/opt/homebrew/bin/codex'], ['desktop','/Applications/ChatGPT.app/Contents/Resources/codex']]) {
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'wf-mcp-audit-')));
 const cwd=path.join(root,'repo'); mkdirSync(cwd);writeFileSync(path.join(cwd,'README.md'),'# owned MCP metadata fixture\n');
 execFileSync('git',['init','-q'],{cwd});execFileSync('git',['add','.'],{cwd});execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=fixture','commit','-qm','fixture'],{cwd});
 const stateDir=path.join(root,'state'); const paths=createStatePaths(stateDir);const store=openStateStore(paths,{mode:'mutating'});
 const run=seedRun(store.db); const task=seedTask(store.db,run.id); const attempt=seedAttempt(store.db,task.id);
 const bridge=await createCoordinationBridge({stateRoot:stateDir,runId:run.id,db:store.db}); const attached=bridge.mcpConfigFor(attempt.id);
 const clean=(text)=>String(text).replaceAll(attached.token,'<redacted-owned-bridge-token>');
 const result={label,executablePath,version:execFileSync(executablePath,['--version'],{encoding:'utf8'}).trim(),bridge:{serverName:attached.serverName,socketPath:attached.socketPath,socketBytes:Buffer.byteLength(attached.socketPath),command:attached.command,args:attached.args,envKeys:Object.keys(attached.env)},statuses:[],notifications:[],stderr:[]};
 const rpc=new CodexRpcClient({executablePath,args:['app-server','--stdio',...attached.codexArgs],cwd,requestTimeoutMs:12000,stopTimeoutMs:1000,onRaw(record){
  if(record.dir==='stderr'){if(/workforce|mcp|bridge|ECONN|ENOENT|SyntaxError|ERR_/i.test(record.line)&&result.stderr.length<40)result.stderr.push(clean(record.line));return;}
  if(record.dir!=='in')return;
  try{const frame=JSON.parse(record.line);if(!frame.method)return;const p=frame.params;if(p?.name===attached.serverName&&/mcp/i.test(frame.method))result.notifications.push({method:frame.method,params:JSON.parse(clean(JSON.stringify(p)))});else if(frame.method==='codex/event'&&/mcp/i.test(p?.msg?.type||'')&&JSON.stringify(p).includes(attached.serverName))result.notifications.push({method:frame.method,params:JSON.parse(clean(JSON.stringify(p)))});}catch{}
 }});
 async function inventory(stage,threadId){let cursor;for(let page=0;page<10;page++){const params={limit:100,...(threadId?{threadId}:{}),...(cursor?{cursor}:{})};const response=await rpc.request('mcpServerStatus/list',params,12000);for(const server of response.data??[]){if(server.name!==attached.serverName)continue;result.statuses.push({stage,request:params,name:server.name,authStatus:server.authStatus,runtimeStatus:server.runtimeStatus??null,toolsError:server.toolsError?clean(server.toolsError):null,toolNames:Object.keys(server.tools??{}),serverInfo:server.serverInfo?{name:server.serverInfo.name,version:server.serverInfo.version}:null});}if(!response.nextCursor)break;cursor=response.nextCursor;}}
 try{rpc.start();await rpc.initialize('workforce','0.1.0',12000);await inventory('before-thread');const thread=await rpc.request('thread/start',{cwd,sandbox:'workspace-write',approvalPolicy:'never',developerInstructions:'Metadata conformance fixture. No model turn will be started.',model:'gpt-5.6-sol'},12000);result.thread={id:thread.thread?.id,sandbox:thread.sandbox,approvalPolicy:thread.approvalPolicy};await inventory('after-thread',thread.thread?.id);await new Promise(resolve=>setTimeout(resolve,500));await inventory('after-startup',thread.thread?.id);result.storedMessages=bridge.messages().length;}
 catch(error){result.error=clean(error.message);}
 finally{result.stop=await rpc.stop();await bridge.close();store.close();rmSync(root,{recursive:true,force:true});}
 results.push(result);console.log(JSON.stringify(result,null,2));
}
const evidence={checkedAt:new Date().toISOString(),method:'Native initialize/thread-start/mcpServerStatus-list comparison with real owned coordination bridge and exact injected argv; no turn/start, no tool calls, no user configuration or credential reads.',results};
writeFileSync('/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/docs/evidence/runtime-installations-2026-09-13/codex-mcp-metadata-comparison.json',JSON.stringify(evidence,null,2)+'\n');
