import * as THREE from './vendor/three.module.min.js';
import { buildSceneLayout } from './scene-layout.js';
import { createWorkstation, createControlCenter } from './scene-furniture.js';
import { createDepartmentIsland, createCentralIsland, createWalkway } from './scene-campus.js';

const esc = (value='') => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const palette = {blue:'#a9c8da',green:'#b9d0bf',pink:'#e1b8c6',purple:'#c8bfdc',amber:'#e3cfab',teal:'#a8cbc8',slate:'#c0c9ce'};
const activeStatus = agent => ['working','planning','running','checking'].includes(String(agent.status).toLowerCase());

function disposeTree(group) {
  const geometry=new Set(),materials=new Set(),textures=new Set();
  group.traverse(item=>{if(item.geometry)geometry.add(item.geometry);for(const mat of [].concat(item.material||[])){materials.add(mat);for(const value of Object.values(mat))if(value?.isTexture)textures.add(value);}});
  geometry.forEach(item=>{if(!item.userData.sharedFurniture)item.dispose();});materials.forEach(item=>{if(!item.userData.sharedFurniture)item.dispose();});textures.forEach(item=>{if(!item.userData.sharedFurniture)item.dispose();});
}

/** Real, roster-driven 3D scene. No furniture exists without its saved owner. */
export function createOfficeScene({element,onSelect=()=>{},onCamera=()=>{},onCreateDepartment=()=>{},layoutKey=null}) {
  element.replaceChildren();element.classList.add('dynamic-canvas');
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.setClearColor('#faf9f5');
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;
  renderer.domElement.className='office-webgl';renderer.domElement.setAttribute('aria-hidden','true');element.append(renderer.domElement);
  const overlay=document.createElement('div');overlay.className='scene-labels';element.append(overlay);
  const empty=document.createElement('div');empty.className='scene-empty';empty.innerHTML='<span class="scene-eyebrow">YOUR OFFICE STARTS HERE</span><h2>A place for your team.</h2><p>Create your first department. Its head and workers will appear here as you add them.</p><button type="button" class="add-agent-button">+ Create a department</button>';empty.querySelector('button').onclick=onCreateDepartment;element.append(empty);
  const scene=new THREE.Scene();scene.add(new THREE.HemisphereLight(0xffffff,0xc7cec3,1.8));
  const key=new THREE.DirectionalLight(0xfff1dd,2.1);key.position.set(-12,25,16);key.castShadow=true;
  key.shadow.mapSize.set(2048,2048);key.shadow.camera.near=.1;key.shadow.camera.far=180;key.shadow.normalBias=.035;key.shadow.bias=-.00012;key.shadow.radius=4;scene.add(key);scene.add(key.target);
  const fill=new THREE.DirectionalLight(0xd5e7ff,1.1);fill.position.set(12,10,-10);scene.add(fill);
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(2000,2000),new THREE.ShadowMaterial({color:0x778277,opacity:.11}));ground.rotation.x=-Math.PI/2;ground.position.y=-.14;ground.receiveShadow=true;scene.add(ground);
  const camera=new THREE.OrthographicCamera(-10,10,10,-10,.1,2000);
  const direction=new THREE.Vector3(1,1,1).normalize();
  let content=new THREE.Group();scene.add(content);let connections=new THREE.Group();scene.add(connections);
  let layout=buildSceneLayout(),data={departments:[],agents:[]},labels=[],pickables=[],selected={type:'office'},showConnections=false;
  let rememberedLayout=null;
  if(layoutKey)try{
    const rows=JSON.parse(localStorage.getItem('workforce.campus.v1:'+layoutKey)||'null');
    const seen=new Set();
    if(Array.isArray(rows)&&rows.length<1000&&rows.every(row=>{
      const p=row?.campusSlot,key=p&&`${p.x},${p.z}`;
      if(typeof row?.id!=='string'||!p||![p.x,p.z].every(v=>Number.isInteger(v)&&Math.abs(v)<1000)||(!p.x&&!p.z)||seen.has(key))return false;
      seen.add(key);return true;
    }))rememberedLayout={departments:rows};
  }catch{}
  const target=new THREE.Vector3(0,0,0),desiredTarget=new THREE.Vector3(0,0,0);
  let span=14,desiredSpan=14,fitSpan=14,width=1,height=1,frame=0,closed=false,hasData=false,drag=null,moved=false,renderDirty=true;
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2(),projected=new THREE.Vector3();
  const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)');
  const roomGroups=new Map(),agentGroups=new Map();

  function cameraUpdate() {
    camera.position.copy(target).addScaledVector(direction,150);camera.lookAt(target);
    const aspect=width/height;camera.left=-span*aspect/2;camera.right=span*aspect/2;camera.top=span/2;camera.bottom=-span/2;camera.updateProjectionMatrix();camera.updateMatrixWorld();
  }
  function fitBounds(bounds,instant=false) {
    desiredTarget.set((bounds.minX+bounds.maxX)/2,.7,(bounds.minZ+bounds.maxZ)/2);
    cameraUpdate();const right=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0),up=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,1);
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    const floors=bounds===layout.bounds?[layout.center.worldBounds,...layout.departments.map(room=>room.worldBounds)]:[bounds];
    for(const floor of floors)for(const x of [floor.minX,floor.maxX])for(const z of [floor.minZ,floor.maxZ])for(const y of [0,3.2]){const p=new THREE.Vector3(x,y,z).sub(desiredTarget);const sx=p.dot(right),sy=p.dot(up);minX=Math.min(minX,sx);maxX=Math.max(maxX,sx);minY=Math.min(minY,sy);maxY=Math.max(maxY,sy);}
    desiredTarget.addScaledVector(right,(minX+maxX)/2).addScaledVector(up,(minY+maxY)/2);
    desiredSpan=Math.max(10,(maxY-minY)*1.35,(maxX-minX)/(width/height)*1.3);
    // Leave a clear lower area for the first-department invitation.
    if(!layout.departments.length){desiredSpan=Math.max(17,desiredSpan);desiredTarget.y=-3;}
    if(instant){span=desiredSpan;target.copy(desiredTarget);}
  }
  function fit(instant=false) {selected={type:'office'};fitBounds(layout.bounds,instant);fitSpan=desiredSpan;updateSelected();}
  function label(position,type,id,title,detail,head=false) {
    const button=document.createElement('button');button.type='button';button.className=`scene-label scene-label-${type}${head?' scene-head':''}`;
    button.dataset.sceneType=type;button.dataset.sceneId=id;button.setAttribute('aria-label',`${title}. ${detail}. Select ${type==='control'?'Control center':type}`);
    button.innerHTML=`${(type==='employee'||type==='department')?'<span class="scene-status-dot"></span>':''}<span><strong>${esc(title)}</strong><small>${esc(detail)}</small></span>`;
    const leader=document.createElement('span');leader.className='scene-label-leader';leader.setAttribute('aria-hidden','true');leader.hidden=true;
    button.addEventListener('click',()=>choose({type:type==='employee'?'employee':type,id}));overlay.append(leader,button);
    labels.push({element:button,leader,position,type,id,head});return button;
  }
  function mark(group,selection) {group.traverse(object=>{if(object.isMesh){object.userData.officeSelection=selection;pickables.push(object);}});}
  function worldPosition(room,x,z,y=.35) {return new THREE.Vector3(room.x+x,y,room.z+z);}
  function route(from,to,color,dashed=false) {
    const middle=from.clone().lerp(to,.5);middle.y=1.2;
    const points=new THREE.QuadraticBezierCurve3(from,middle,to).getPoints(28);
    const material=dashed?new THREE.LineDashedMaterial({color,dashSize:.22,gapSize:.13,transparent:true,opacity:.65}):new THREE.LineBasicMaterial({color,transparent:true,opacity:.55});
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),material);line.computeLineDistances();connections.add(line);
  }
  function updateSelected() {
    renderDirty=true;
    labels.forEach(item=>item.element.classList.toggle('selected',selected.id===item.id&&selected.type===item.type));
    roomGroups.forEach((group,id)=>{group.userData.border.visible=selected.type==='department'&&selected.id===id;});
  }
  function select(next,{notify=false}={}) {
    selected={...next};
    if(next.type==='office')fit();
    else if(next.type==='department') {const room=layout.departments.find(d=>d.id===next.id);if(room)fitBounds(room.worldBounds);}
    else if(next.type==='employee') {const group=agentGroups.get(next.id);if(group){group.getWorldPosition(desiredTarget);desiredTarget.y=1;desiredSpan=8.2;}}
    else if(next.type==='control'){desiredTarget.set(0,.7,0);desiredSpan=11;}
    updateSelected();if(notify)onSelect(next);
  }
  function choose(next) {select(next,{notify:true});}
  function setData(next) {
    const prior=selected;data={departments:next.departments||[],agents:next.agents||[]};layout=buildSceneLayout({...data,previousLayout:layout.departments.length?layout:rememberedLayout});
    if(layoutKey&&layout.departments.length)try{
      rememberedLayout={departments:layout.departments.map(({id,campusSlot})=>({id,campusSlot}))};
      localStorage.setItem('workforce.campus.v1:'+layoutKey,JSON.stringify(rememberedLayout.departments));
    }catch{}
    scene.remove(content,connections);disposeTree(content);disposeTree(connections);content=new THREE.Group();connections=new THREE.Group();scene.add(content,connections);connections.visible=showConnections;
    overlay.replaceChildren();labels=[];pickables=[];roomGroups.clear();agentGroups.clear();
    for(const path of layout.paths||[]){
      const direction=new THREE.Vector2(path.to.x-path.from.x,path.to.z-path.from.z).normalize();
      // Bridge decks tuck under beveled/notched edges so no visible gaps remain.
      const from={x:path.from.x-direction.x*1.5,z:path.from.z-direction.y*1.5};
      const to={x:path.to.x+direction.x*.55,z:path.to.z+direction.y*.55};
      content.add(createWalkway(from,to,path.width));
    }
    const central=new THREE.Group();central.add(createCentralIsland());const command=createControlCenter();command.position.y=.36;command.rotation.y=Math.PI/4;central.add(command);mark(central,{type:'control',id:'control'});content.add(central);
    label(new THREE.Vector3(0,3.4,0),'control','control','CONTROL CENTER','Orchestrator · your workspace');
    const byAgent=new Map(data.agents.map(a=>[a.id,a]));
    for(const room of layout.departments) {
      const department=data.departments.find(d=>d.id===room.id);const color=department.color?.startsWith('#')?department.color:(palette[department.color]||'#b8cdd3');
      const group=new THREE.Group();group.position.set(room.x,0,room.z);group.rotation.y=room.floorRotationY??0;content.add(group);roomGroups.set(room.id,group);
      const floor=createDepartmentIsland(room.width,room.depth,color);mark(floor,{type:'department',id:room.id});group.add(floor);
      const border=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(room.width+.15,.42,room.depth+.15)),new THREE.LineBasicMaterial({color:'#527d68',transparent:true,opacity:.75}));border.position.y=.2;group.add(border);group.userData.border=border;
      const headSeat=room.seats.find(s=>s.role==='head');
      for(const seat of room.seats) {
        const agent=byAgent.get(seat.agentId);const workstation=createWorkstation({agent,color,index:room.seats.indexOf(seat),head:seat.role==='head'});
        workstation.position.set(seat.x,.35,seat.z);workstation.rotation.y=seat.rotationY??room.rotationY;group.add(workstation);agentGroups.set(agent.id,workstation);mark(workstation,{type:'employee',id:agent.id});
        const at=worldPosition(room,seat.x+Math.sin(seat.rotationY??room.rotationY)*.75,seat.z+Math.cos(seat.rotationY??room.rotationY)*.75,2.35);
        const nameplate=label(at,'employee',agent.id,agent.name,seat.role==='head'?'Department head':agent.statusLabel||'Worker',seat.role==='head');
        nameplate.classList.toggle('is-working',activeStatus(agent));
        if(headSeat&&seat!==headSeat)route(worldPosition(room,headSeat.x,headSeat.z,.8),worldPosition(room,seat.x,seat.z,.8),'#719c88',true);
      }
      const count=room.seats.filter(s=>s.role!=='head').length;
      const roomLabel=label(worldPosition(room,-room.width/2+.3,-room.depth/2+.3,1.7),'department',room.id,department.name,`${headSeat?'1 head':'No head'} · ${count} ${count===1?'worker':'workers'}`);
      roomLabel.dataset.count=String(room.seats.length);roomLabel.style.setProperty('--department-color',color);
      const to=headSeat?worldPosition(room,headSeat.x,headSeat.z,.7):new THREE.Vector3(room.x,.7,room.z);
      route(new THREE.Vector3(0,.7,0),to,'#638773',true);
    }
    empty.hidden=layout.departments.length>0;
    const extent=Math.max(layout.bounds.width,layout.bounds.depth,16)*.8;key.shadow.camera.left=-extent;key.shadow.camera.right=extent;key.shadow.camera.top=extent;key.shadow.camera.bottom=-extent;key.shadow.camera.updateProjectionMatrix();
    key.position.set(layout.bounds.centerX-12,35,layout.bounds.centerZ+16);key.target.position.set(layout.bounds.centerX,0,layout.bounds.centerZ);
    content.updateMatrixWorld(true);
    if(!hasData||prior.type==='office'){fit(!hasData);hasData=true;}else select(prior);
  }
  function resize() {renderDirty=true;width=Math.max(1,element.clientWidth);height=Math.max(1,element.clientHeight);renderer.setSize(width,height);if(selected.type==='office')fit(true);cameraUpdate();}
  const observer=new ResizeObserver(resize);observer.observe(element);
  const down=event=>{if(event.target!==renderer.domElement)return;drag={x:event.clientX,y:event.clientY,target:desiredTarget.clone()};moved=false;renderer.domElement.setPointerCapture(event.pointerId);};
  const move=event=>{
    if(drag){const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>5)moved=true;const right=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0);const up=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,1);right.y=0;up.y=0;desiredTarget.copy(drag.target).addScaledVector(right,-dx*span/height).addScaledVector(up,dy*span/height);}
    else{const box=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-box.left)/box.width*2-1,-(event.clientY-box.top)/box.height*2+1);raycaster.setFromCamera(pointer,camera);renderer.domElement.style.cursor=raycaster.intersectObjects(pickables,false).length?'pointer':'grab';}
  };
  const up=event=>{if(!drag)return;drag=null;if(moved)return;const box=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-box.left)/box.width*2-1,-(event.clientY-box.top)/box.height*2+1);raycaster.setFromCamera(pointer,camera);const hit=raycaster.intersectObjects(pickables,false)[0];if(hit?.object.userData.officeSelection)choose(hit.object.userData.officeSelection);};
  const wheel=event=>{event.preventDefault();desiredSpan=THREE.MathUtils.clamp(desiredSpan*Math.exp(event.deltaY*.0012),4,Math.max(250,fitSpan*4));};
  const keyboard=event=>{if(event.target!==element)return;if(['+','=','-','0','Home','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();if(event.key==='0'||event.key==='Home')choose({type:'office'});else if(event.key==='+'||event.key==='=')zoomBy(1.2);else if(event.key==='-')zoomBy(1/1.2);else{const right=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0),up=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,1);right.y=up.y=0;desiredTarget.addScaledVector(event.key.includes('Left')||event.key.includes('Right')?right:up,(event.key==='ArrowLeft'||event.key==='ArrowDown'?-1:1)*span*.06);}}};
  renderer.domElement.addEventListener('pointerdown',down);renderer.domElement.addEventListener('pointermove',move);renderer.domElement.addEventListener('pointerup',up);renderer.domElement.addEventListener('pointercancel',()=>{drag=null;});renderer.domElement.addEventListener('wheel',wheel,{passive:false});element.addEventListener('keydown',keyboard);
  function zoomBy(factor){desiredSpan=THREE.MathUtils.clamp(desiredSpan/factor,4,Math.max(250,fitSpan*4));}
  function animate(){if(closed)return;frame=requestAnimationFrame(animate);if(!renderDirty&&target.distanceToSquared(desiredTarget)<1e-8&&Math.abs(span-desiredSpan)<.0001)return;const t=reduceMotion.matches?1:.18;target.lerp(desiredTarget,t);span=THREE.MathUtils.lerp(span,desiredSpan,t);cameraUpdate();
    const visibleLabels=[];
    for(const item of labels){projected.copy(item.position).project(camera);const x=(projected.x*.5+.5)*width,y=(-projected.y*.5+.5)*height;
      const roomView=selected.type==='department'&&data.agents.find(a=>a.id===item.id)?.departmentId===selected.id;
      const visible=item.type!=='employee'||roomView||selected.id===item.id||(width>700&&(data.agents.length<=12||item.head||fitSpan/span>1.5));
      item.element.hidden=!visible||projected.z>1||projected.z< -1||x< -50||x>width+50||y< -50||y>height+50;
      item.leader.hidden=true;
      if(!item.element.hidden)visibleLabels.push({...item,anchorX:x,anchorY:y});
    }
    // Place labels in a stable priority order. The scene anchor never changes;
    // only the screen-space button moves, with a leader back to that anchor.
    const priority=item=>selected.id===item.id?0:item.type==='control'?1:item.type==='department'?2:item.head?3:4;
    visibleLabels.sort((a,b)=>priority(a)-priority(b)||a.id.localeCompare(b.id));
    const placed=[],gap=6,left=8,right=Math.max(8,width-8),top=64,bottom=Math.max(100,height-94);
    const clamp=(value,min,max)=>Math.max(min,Math.min(Math.max(min,max),value));
    for(const item of visibleLabels){
      const w=Math.min(item.element.offsetWidth,width-16),h=item.element.offsetHeight;
      const originX=clamp(item.anchorX-w/2,left,right-w),originY=clamp(item.anchorY-h,top,bottom-h);
      const xs=new Set([originX,left,right-w]),ys=new Set([originY,top,bottom-h]);
      for(const box of placed){xs.add(clamp(box.x-w-gap,left,right-w));xs.add(clamp(box.x+box.w+gap,left,right-w));ys.add(clamp(box.y-h-gap,top,bottom-h));ys.add(clamp(box.y+box.h+gap,top,bottom-h));}
      let best=null,bestScore=Infinity;
      for(const y of ys)for(const x of xs){const score=(x-originX)**2+(y-originY)**2;
        if(score>=bestScore||placed.some(box=>x<box.x+box.w+gap&&x+w+gap>box.x&&y<box.y+box.h+gap&&y+h+gap>box.y))continue;
        best={x,y,w,h};bestScore=score;
      }
      if(!best){item.element.hidden=true;continue;}
      placed.push(best);item.element.style.transform=`translate(${best.x.toFixed(1)}px,${best.y.toFixed(1)}px)`;
      const endX=clamp(item.anchorX,best.x,best.x+w),endY=clamp(item.anchorY,best.y,best.y+h);
      const dx=endX-item.anchorX,dy=endY-item.anchorY,length=Math.hypot(dx,dy);
      if(length>8){item.leader.hidden=false;item.leader.style.width=`${length.toFixed(1)}px`;item.leader.style.transform=`translate(${item.anchorX.toFixed(1)}px,${item.anchorY.toFixed(1)}px) rotate(${Math.atan2(dy,dx)}rad)`;}
    }
    renderer.render(scene,camera);renderDirty=false;onCamera({zoom:fitSpan/span,span});
  }
  resize();setData(data);animate();
  const api={setData,select,fit,zoomBy,setConnections(value){renderDirty=true;showConnections=value;connections.visible=value;},getSnapshot(){return {departmentCount:layout.departments.length,agentCount:data.agents.length,workstationCount:agentGroups.size,avatarCount:agentGroups.size,coordinatorCount:1,walkwayCount:(layout.paths||[]).length,paths:layout.paths||[],departments:layout.departments.map(room=>({...room,seatCount:room.seats.length})),bounds:layout.bounds,selected,zoom:fitSpan/span,renderer:'three-webgl',canvas:{width,height}};},destroy(){closed=true;cancelAnimationFrame(frame);observer.disconnect();element.removeEventListener('keydown',keyboard);disposeTree(content);disposeTree(connections);renderer.dispose();element.replaceChildren();}};
  return api;
}
