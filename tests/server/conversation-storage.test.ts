import {describe,expect,it} from 'vitest';
const modulePath='../../web/headquarters/src/headquarters/conversation-storage.js';
const {createConversationStorage}=await import(modulePath);
const baseline=()=>({version:3,layoutVersion:5,activeId:'draft',threads:[{id:'draft',title:'New conversation',draft:'',attachments:[] as Array<Record<string,unknown>>,messages:[{id:'answer',role:'assistant',text:'Working',request:{id:'request',state:'running',receivedAt:'2026-09-14T10:00:00Z'}}]}],feedDraft:{id:'feed',draft:'',attachments:[] as Array<Record<string,unknown>>,messages:[]}});
function storage(){let value=JSON.stringify(baseline());return {read:()=>JSON.parse(value),write:(next:unknown)=>{value=JSON.stringify(next);}};}

describe('conversation draft storage across tabs',()=>{
 it('a stale peer saving unchanged draft fields cannot erase ready attachments or text',()=>{
  const shared=storage(),first=shared.read(),stale=shared.read();
  const owner=createConversationStorage({...shared,initial:first}),peer=createConversationStorage({...shared,initial:stale});
  first.threads[0].attachments=Array.from({length:7},(_,index)=>({key:`file-${index}`,id:`attachment-${index}`,name:`Screenshot ${index}.png`,status:'ready'}));
  first.threads[0].draft='Keep these screenshots with my unsent task.';
  owner.save(first);
  stale.chatWidth=440;
  const adopted=peer.save(stale);
  expect(shared.read().threads[0].attachments).toHaveLength(7);
  expect(shared.read().threads[0].draft).toBe(first.threads[0].draft);
  expect(adopted.threads[0]).toBe(stale.threads[0]);
  expect(adopted.threads[0].attachments).toHaveLength(7);
  peer.save(adopted);expect(shared.read().threads[0].attachments).toHaveLength(7);
 });
 it('keeps fresh local unsent edits while merging independent history and newer request receipts',()=>{
  const shared=storage(),local=shared.read(),remote=shared.read();
  const owner=createConversationStorage({...shared,initial:local}),peer=createConversationStorage({...shared,initial:remote});
  remote.threads[0].messages[0]={...remote.threads[0].messages[0],text:'Reviewed result',request:{...remote.threads[0].messages[0].request,state:'ended',endedAt:'2026-09-14T10:05:00Z'}};
  remote.threads.push({id:'other',draft:'Another task',messages:[],attachments:[]});
  peer.save(remote);
  local.threads[0].draft='Fresh local task';local.threads[0].attachments=[{key:'new',id:'new-file',status:'ready'}];
  const originalMessage=local.threads[0].messages[0],adopted=owner.save(local);
  const draft=adopted.threads.find((thread:{id:string})=>thread.id==='draft');
  expect(draft.draft).toBe('Fresh local task');expect(draft.attachments).toHaveLength(1);
  expect(adopted.threads.some((thread:{id:string})=>thread.id==='other')).toBe(true);
  expect(draft.messages[0]).toBe(originalMessage);
  expect(originalMessage.request.state).toBe('ended');expect(originalMessage.text).toBe('Reviewed result');
 });
 it('preserves pending upload references and explicit local file removal across peer saves',()=>{
  const shared=storage(),local=shared.read(),remote=shared.read();
  const owner=createConversationStorage({...shared,initial:local}),peer=createConversationStorage({...shared,initial:remote});
  const row={key:'upload',status:'uploading'};
  local.feedDraft.attachments.push(row);
  let adopted=owner.save(local);expect(adopted.feedDraft).toBe(local.feedDraft);expect(adopted.feedDraft.attachments[0]).toBe(row);
  peer.save(remote);
  Object.assign(row,{status:'ready',id:'uploaded'});adopted=owner.save(adopted);
  expect(shared.read().feedDraft.attachments[0].id).toBe('uploaded');
  adopted.feedDraft.attachments=[];owner.save(adopted);
  expect(shared.read().feedDraft.attachments).toEqual([]);
 });
 it('merges appended messages by identity without duplicating or regressing newer receipts',()=>{
  const shared=storage(),local=shared.read(),remote=shared.read();
  const owner=createConversationStorage({...shared,initial:local}),peer=createConversationStorage({...shared,initial:remote});
  remote.threads[0].messages[0].request={...remote.threads[0].messages[0].request,state:'ended',endedAt:'2026-09-14T10:05:00Z'};
  remote.threads[0].messages[0].text='Final answer';remote.threads[0].messages.push({id:'remote-message',text:'Remote history'});peer.save(remote);
  local.threads[0].messages[0].text='Older progress update';local.threads[0].messages.push({id:'local-message',text:'Local history'});
  owner.save(local);
  const messages=shared.read().threads[0].messages;
  expect(messages.map((message:{id:string})=>message.id)).toEqual(['answer','remote-message','local-message']);
  expect(messages[0].text).toBe('Final answer');expect(messages[0].request.state).toBe('ended');
 });
});
