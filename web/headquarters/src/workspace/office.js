import { departments, employees } from './model.js';
import { icon, esc } from './ui.js';

const positions = {research:[10,8],engineering:[90,8],design:[0,42],marketing:[100,43],operations:[10,78],support:[90,79]};
export function renderOffice({selected, paused, onSelect, onPause, zoom=1, onZoom}) {
  const el = document.createElement('section'); el.className = 'office-panel panel'; el.setAttribute('aria-label','Interactive office');
  el.innerHTML = `<header class="panel-heading"><div><h2>The office</h2><p>6 departments · 25 AI employees</p></div><div class="office-activity"><span class="demo-indicator"><i></i>Demo activity</span><button class="icon-button pause-button" aria-label="${paused?'Play':'Pause'} demo animation" title="${paused?'Play':'Pause'} demo animation">${icon(paused?'play':'pause',16)}</button></div></header>
    <div class="office-stage ${paused?'paused':''}"><div class="office-world">
      <img class="office-art" src="/assets/office-clean.png" draggable="false" alt="Six pastel 3D office islands with stationary seated AI employees, connected to Atlas at the central desk." />
      <svg class="office-routes" viewBox="0 0 1402 1122" aria-hidden="true"><path class="route" d="M714 580 Q740 400 1030 265"/><path class="route route-two" d="M260 580 Q420 465 714 580"/><circle class="packet" r="5"><animateMotion dur="4s" repeatCount="indefinite" path="M714 580 Q740 400 1030 265"/></circle><circle class="packet packet-two" r="4"><animateMotion dur="5.4s" repeatCount="indefinite" path="M260 580 Q420 465 714 580"/></circle></svg>
      ${employees.map(e=>`<button class="desk-target ${selected?.id===e.id?'chosen':''}" data-employee="${e.id}" style="left:${e.x/1402*100}%;top:${e.y/1122*100+5}%" aria-label="Inspect ${esc(e.name)}, ${esc(e.role)}" title="${esc(e.name)} · ${esc(e.role)}"><span>${esc(e.name)}</span></button>`).join('')}
      ${departments.map(d=>`<button class="department-tag ${selected?.id===d.id?'selected':''}" data-department="${d.id}" style="left:${positions[d.id][0]}%;top:${positions[d.id][1]}%;--department:${d.color}" aria-label="Open ${esc(d.name)} department"><strong><i></i>${esc(d.name)}</strong><small>1 head · 3 specialists</small></button>`).join('')}
      <button class="coordinator-tag ${selected?.type==='coordinator'?'selected':''}" aria-label="Inspect Atlas, company orchestrator"><strong><i></i>Atlas</strong><small>Company orchestrator</small></button>
    </div></div>
    <footer class="office-footer"><div class="legend"><span><i class="working"></i>Working</span><span><i class="review"></i>In review</span><span><i class="idle"></i>Available</span></div><div class="zoom-controls"><button class="icon-button" data-zoom="out" aria-label="Zoom out">${icon('minus',15)}</button><output aria-label="Office zoom">100%</output><button class="icon-button" data-zoom="in" aria-label="Zoom in">${icon('plus',15)}</button><button class="icon-button fit-button" data-zoom="fit" aria-label="Fit office">${icon('fit',16)}</button></div></footer>`;
  el.querySelectorAll('[data-department]').forEach(b=>b.onclick=()=>onSelect('department',b.dataset.department));
  el.querySelectorAll('[data-employee]').forEach(b=>b.onclick=()=>onSelect('employee',b.dataset.employee));
  el.querySelector('.coordinator-tag').onclick=()=>onSelect('coordinator','control');
  el.querySelector('.pause-button').onclick=onPause;
  el.querySelector('.office-world').style.transform=`scale(${zoom})`;
  el.querySelector('output').value=`${Math.round(zoom*100)}%`;
  el.querySelectorAll('[data-zoom]').forEach(b=>b.onclick=()=>{
    zoom = b.dataset.zoom==='fit'?1:Math.max(.8,Math.min(1.6,zoom+(b.dataset.zoom==='in'?.15:-.15)));
    el.querySelector('.office-world').style.transform=`scale(${zoom})`;
    el.querySelector('output').value=`${Math.round(zoom*100)}%`;
    onZoom?.(zoom);
  });
  if(paused || matchMedia('(prefers-reduced-motion: reduce)').matches) el.querySelector('.office-routes').pauseAnimations();
  return el;
}
