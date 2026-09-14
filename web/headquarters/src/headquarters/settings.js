import {escape, icon} from './ui.js';

const KEY='workforce-preferences-v1';
const defaults=Object.freeze({theme:'system',density:'comfortable',sendShortcut:'enter',autoHandoff:true});
const options={theme:['system','light','dark'],density:['comfortable','compact'],sendShortcut:['enter','mod-enter']};
function validate(value={}){return {...Object.fromEntries(Object.entries(options).map(([key,values])=>[key,values.includes(value[key])?value[key]:defaults[key]])),autoHandoff:typeof value.autoHandoff==='boolean'?value.autoHandoff:defaults.autoHandoff};}
function read(){try{return validate(JSON.parse(localStorage.getItem(KEY)||'{}'));}catch{return {...defaults};}}
let preferences=read();
const systemTheme=window.matchMedia('(prefers-color-scheme: dark)');
export function getSettings(){return {...preferences};}
export function applySettings(){document.documentElement.dataset.theme=preferences.theme==='system'?(systemTheme.matches?'dark':'light'):preferences.theme;document.documentElement.dataset.density=preferences.density;document.documentElement.style.colorScheme=document.documentElement.dataset.theme;}
export function updateSettings(patch){const next=validate({...preferences,...patch});localStorage.setItem(KEY,JSON.stringify(next));preferences=next;applySettings();window.dispatchEvent(new CustomEvent('workforce:preferences',{detail:getSettings()}));return getSettings();}
systemTheme.addEventListener('change',applySettings);
window.addEventListener('storage',event=>{if(event.key===KEY){preferences=read();applySettings();window.dispatchEvent(new CustomEvent('workforce:preferences',{detail:getSettings()}));}});
applySettings();

function choices(key,values){return `<div class="settings-options" role="group" aria-label="${escape(key)}">${values.map(([value,label,graphic])=>`<button type="button" class="settings-choice ${preferences[key]===value?'selected':''}" data-preference="${key}" data-value="${value}" aria-pressed="${preferences[key]===value}">${graphic?icon(graphic):''}<span>${label}</span>${preferences[key]===value?icon('check'):''}</button>`).join('')}</div>`;}
export function renderSettings({connected,streaming}={}){return `<div class="settings-page">
  <header class="live-page-header"><div><p class="eyebrow">WORKSPACE PREFERENCES</p><h1>Settings</h1><p>Make Workforce feel at home on your computer.</p></div><span class="settings-saved">${icon('check')}Saved on this browser</span></header>
  <section class="settings-section"><header>${icon('palette')}<div><h2>Appearance</h2><p>A clear workspace, in any light.</p></div></header>
    <div class="settings-row"><div><h3>Theme</h3><p>Use a light canvas, navy dark mode, or follow your system.</p></div>${choices('theme',[['light','Light','sun'],['dark','Dark','moon'],['system','System','monitor']])}</div>
    <div class="settings-theme-preview" aria-hidden="true"><div class="settings-mini-sidebar"></div><div class="settings-mini-content"><i></i><i></i><div><span></span><span></span><span></span></div></div><div class="settings-mini-chat"><i></i><i></i><span></span></div></div>
    <div class="settings-row"><div><h3>Interface density</h3><p>Adjust space around lists and controls.</p></div>${choices('density',[['comfortable','Comfortable'],['compact','Compact']])}</div>
  </section>
  <section class="settings-section"><header>${icon('panel')}<div><h2>Conversation</h2><p>Small preferences for your everyday flow.</p></div></header>
    <div class="settings-row"><div><h3>Send a message</h3><p>Shift + Enter always adds a new line.</p></div>${choices('sendShortcut',[['enter','Enter'],['mod-enter','⌘ / Ctrl + Enter']])}</div>
    <div class="settings-row"><div><h3>Automatic team selection</h3><p>Control Center selects available specialists and delegates authorized work across your projects.</p></div><span class="settings-automatic">${icon('check')}Automatic</span></div>
  </section>
  <section class="settings-section"><header>${icon('connect')}<div><h2>Your harness</h2><p>Connected runtimes and company behavior.</p></div></header>
    <div class="settings-row"><div><h3>Runtime connection</h3><p>${connected?'Connected to your local coordinator.':'The local coordinator is unavailable.'} ${streaming?'Live event stream connected.':'Events refresh with your workspace.'}</p></div><span class="status ${connected?'completed':'blocked'}"><i class="dot"></i>${connected?'Connected':'Offline'}</span></div>
    <div class="settings-row"><div><h3>MCP connections</h3><p>Connect Codex or Claude and send plans directly to your workforce.</p></div><button class="secondary" data-nav="connections">Open connections ${icon('arrow')}</button></div>
    <div class="settings-row"><div><h3>Models & installations</h3><p>Discover the models available in each locally installed runtime.</p></div><button class="secondary" data-nav="runtimes">Manage runtimes ${icon('arrow')}</button></div>
    <div class="settings-row"><div><h3>Control Center</h3><p>Configure orchestration, instructions, internal repair limits, and routing.</p></div><button class="secondary" data-manage-control>Configure ${icon('arrow')}</button></div>
  </section>
  <p class="settings-footnote">Appearance and conversation preferences are stored in this browser. Company configuration is saved by your local harness.</p>
</div>`;}
