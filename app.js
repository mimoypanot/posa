// app.js - Monster Theme rendering (original art) + same gameplay/netcode/controls
import { initFirebase, Net } from './net.js';
import { InputMux } from './ui.js';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const mini = document.getElementById('minimap');
const mctx = mini.getContext('2d');
const statusEl = document.getElementById('status');
const winEl = document.getElementById('win');

const cfg = {
  mapW: 2200, mapH: 1400,
  laneZ: 700, laneHalf: 70,
  hero: { hp:800, speed: 230, q:{dmg:90, speed: 700, range:900, cd:5.5}, e:{dist:260, cd:9}, a:{dmg:42, speed:760, range:620, cd:0.55}, radius: 18, reveal: 140 },
  creep: { hp:260, speed: 116, dmg:14, wave:3, interval:15, radius: 12, reveal: 100 },
  tower: { hp:900, range:280, dmg:20, rate:0.75, radius: 22, reveal: 220 },
  core: { hp:1600, radius: 34 },
  dtClamp: 1/20,
};

// Terrain (reuse simple lane + river), with organic "monster realm" colors
const terrain = {
  riverY: 700, riverH: 120,
  slowFactor: 0.85,
  walls: [
    [0,0, 2200,160],
    [0,1240, 2200,160],
    [0,0, 80,1400],
    [2120,0, 80,1400],
    [340,330, 220,280],
    [1640,330, 220,280],
    [340,820, 220,260],
    [1620,840, 220,240],
  ],
  bushes: [
    [600, 650, 90],
    [1600, 750, 90],
    [1100, 700, 100],
    [460, 980, 80],
    [1780, 420, 80],
  ]
};

function inRect(x,y, [rx,ry,rw,rh]){ return x>=rx && x<=rx+rw && y>=ry && y<=ry+rh }
function inAnyWall(x,y){ return terrain.walls.some(w => inRect(x,y,w)) }
function inBush(x,y){ return terrain.bushes.some(([bx,by,br]) => Math.hypot(x-bx, y-by) <= br) }
function inRiver(y){ return Math.abs(y - terrain.riverY) <= terrain.riverH/2 }

const camera = { x:0,y:0,w:1280,h:720, target:null,
  apply(){ ctx.save(); ctx.translate(-this.x, -this.y); },
  restore(){ ctx.restore() },
  update(dt){ if(!this.target) return; const tx=this.target.x-this.w/2, ty=this.target.z-this.h/2; this.x+= (tx-this.x)*Math.min(1,dt*4); this.y+= (ty-this.y)*Math.min(1,dt*4);
    this.x=Math.max(0,Math.min(cfg.mapW-this.w,this.x)); this.y=Math.max(0,Math.min(cfg.mapH-this.h,this.y)); }
};

function resize(){
  const dpr = Math.max(1, devicePixelRatio||1);
  canvas.width = Math.floor(innerWidth*dpr); canvas.height = Math.floor(innerHeight*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
addEventListener('resize', resize); resize();

// State
let units = new Map();
let time = 0, nextWave = 2, lastTowerFire = 0, over=false;
let meId = null, myTeam = 1;

function uid(p){ return p + Math.random().toString(36).slice(2,9) }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)) }
function dirNorm(dx, dz){ const l=Math.hypot(dx,dz)||1; return {x:dx/l, z:dz/l} }
function closestEnemy(from, range){
  let best=null, bestD=Infinity;
  units.forEach(u=>{
    if(u.team===from.team) return; if (u.hp<=0) return; if (u.type==='proj') return;
    const d = Math.hypot(u.x-from.x, u.z-from.z);
    if (d<range && d<bestD) { best=u; bestD=d; }
  });
  return best;
}
function nearestEnemy(from){ let best=null, bestD=Infinity; units.forEach(u=>{ if(u.team===from.team) return; if(u.hp<=0||u.type==='proj') return; const d=Math.hypot(u.x-from.x,u.z-from.z); if(d<bestD){best=u;bestD=d;} }); return best; }
function applyDamage(t, dmg){ t.hp = Math.max(0, t.hp - dmg) }
function clampHero(h){
  const nx = clamp(h.x, 0, cfg.mapW), nz = clamp(h.z, 0, cfg.mapH);
  if (!inAnyWall(nx, nz)){ h.x = nx; h.z = nz; }
}
function slowFactorAt(y){ return inRiver(y) ? terrain.slowFactor : 1 }

function make(type, team, x, z, hp, extra={}){
  const u = { id: uid(type+'-'), type, team, x, z, vx:0, vz:0, hp, maxHP:hp, ...extra };
  units.set(u.id, u); return u;
}
function reset(){
  units.clear(); over=false; winEl.style.display='none';
  make('tower',1, 520, cfg.laneZ, cfg.tower.hp);
  make('tower',2, cfg.mapW-520, cfg.laneZ, cfg.tower.hp);
  make('core', 1, 220, cfg.laneZ, cfg.core.hp);
  make('core', 2, cfg.mapW-220, cfg.laneZ, cfg.core.hp);
  const p1 = make('hero',1, 320, cfg.laneZ, cfg.hero.hp, {qReady:0,eReady:0,aReady:0});
  const p2 = make('hero',2, cfg.mapW-320, cfg.laneZ, cfg.hero.hp, {qReady:0,eReady:0,aReady:0});
  time=0; nextWave=2; lastTowerFire=0;
  return { p1, p2 };
}

function spawnWave(){
  for(let i=0;i<cfg.creep.wave;i++){
    make('creep',1, 420+i*16, cfg.laneZ, cfg.creep.hp);
    make('creep',2, cfg.mapW-420-i*16, cfg.laneZ, cfg.creep.hp);
  }
}

function castProjectile(h, aimDir, cfgSkill){
  const vx = aimDir.x * cfgSkill.speed;
  const vz = aimDir.z * cfgSkill.speed;
  make('proj', h.team, h.x, h.z, 1, {vx, vz, range: cfgSkill.range, dmg: cfgSkill.dmg, owner:h.id});
}
function castSkill(h, kind, aim){
  const now=time;
  if (kind==='Q'){
    if (now<(h.qReady||0)) return; h.qReady=now+cfg.hero.q.cd;
    castProjectile(h, aim, cfg.hero.q);
  } else if (kind==='E'){
    if (now<(h.eReady||0)) return; h.eReady=now+cfg.hero.e.cd;
    h.x += aim.x * cfg.hero.e.dist; h.z += aim.z * cfg.hero.e.dist; clampHero(h);
  } else if (kind==='A'){
    if (now<(h.aReady||0)) return; h.aReady=now+cfg.hero.a.cd;
    castProjectile(h, aim, cfg.hero.a);
  }
}
function heroByTeam(team){ let h=null; units.forEach(u=>{ if(u.type==='hero'&&u.team===team) h=u; }); return h; }
function computeAimDir(hero, input, pointerWorld){
  if (!hero) return {x:1, z:0};
  if (input.drag){ return dirNorm(input.drag.dx, input.drag.dy); }
  if (input.lockOn){ const t = nearestEnemy(hero); if (t){ return dirNorm(t.x-hero.x, t.z-hero.z); } }
  return dirNorm(pointerWorld.x - hero.x, pointerWorld.z - hero.z);
}

// Visibility: re-use bush logic
function isVisibleTo(u, viewerTeam){
  if (u.type==='proj') return true;
  if (u.team === viewerTeam) return true;
  const inB = inBush(u.x, u.z);
  if (!inB) return true;
  let revealed = false;
  units.forEach(a=>{
    if (revealed) return;
    if (a.team!==viewerTeam) return;
    const r = a.type==='hero' ? cfg.hero.reveal : a.type==='creep'? cfg.creep.reveal : a.type==='tower'? cfg.tower.reveal : 0;
    if (r>0 && Math.hypot(a.x-u.x, a.z-u.z) <= r) revealed = true;
  });
  return revealed;
}

// Net
const net = new Net();
let role = 'local'; // 'host'|'guest'|'local'
let firebaseFns = null;

const btnHost = document.getElementById('btnHost');
const btnJoin = document.getElementById('btnJoin');
const btnLocal = document.getElementById('btnLocal');
const btnReset = document.getElementById('btnReset');
const btnWave = document.getElementById('btnWave');
const roomInput = document.getElementById('room');

btnLocal.onclick = ()=>{ role='local'; statusEl.textContent='Local mode'; initLocal(); }
btnWave.onclick = ()=>{ if(role==='host' || role==='local') spawnWave(); }
btnReset.onclick = ()=>{ if(role==='host' || role==='local') { initLocal(); } }

btnHost.onclick = async ()=>{
  try{
    await ensureFirebase();
    const code = (roomInput.value||'room1').toLowerCase();
    const { p1 } = initLocal(); myTeam = 1; role='host'; meId = p1.id; camera.target = heroByTeam(1);
    statusEl.textContent = 'Hosting… ' + code;
    await net.host(code, firebaseFns);
  }catch(e){ console.error(e); alert(e.message||e); }
};
btnJoin.onclick = async ()=>{
  try{
    await ensureFirebase();
    const code = (roomInput.value||'room1').toLowerCase();
    role='guest'; units.clear(); statusEl.textContent = 'Joining… ' + code; myTeam = 2;
    await net.join(code, firebaseFns);
  }catch(e){ console.error(e); alert(e.message||e); }
};

async function ensureFirebase(){
  if (firebaseFns) return;
  const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    databaseURL: "https://YOUR_PROJECT-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "YOUR_PROJECT",
    storageBucket: "YOUR_PROJECT.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
  };
  firebaseFns = await initFirebase(firebaseConfig);
}

net.onOpen = ()=>{ statusEl.textContent = (role==='host'?'Hosting':'Connected') + ' ✔'; }
net.onClose = ()=>{ statusEl.textContent = 'Disconnected'; }
net.onMessage = (data)=>{
  try{
    const msg = typeof data==='string'? JSON.parse(data) : data;
    if (msg.type==='input' && role==='host'){
      const h = heroByTeam(2); if (!h) return;
      const len = Math.hypot(msg.mx, msg.mz)||1; h.vx=(msg.mx/len)*cfg.hero.speed*slowFactorAt(h.z); h.vz=(msg.mz/len)*cfg.hero.speed*slowFactorAt(h.z);
      if (msg.cast){ const aim = dirNorm(msg.ax, msg.az); castSkill(h, msg.cast, aim); }
    } else if (msg.type==='state' && role==='guest'){
      units = new Map(); for (const u of msg.units) units.set(u.id, u);
      if (!camera.target) camera.target = heroByTeam(myTeam);
    }
  }catch(e){ console.warn('msg parse', e) }
};

function initLocal(){
  const { p1 } = reset();
  camera.target = p1;
  meId = p1.id; myTeam = 1; role = (role==='local'? 'local': role);
  return { p1 };
}

// Input handling
const im = new InputMux(canvas);
let mouseWorld = { x:0, z:0 };
canvas.addEventListener('pointermove', (e)=>{
  const rect = canvas.getBoundingClientRect();
  mouseWorld = { x: e.clientX - rect.left + camera.x, z: e.clientY - rect.top + camera.y };
});

// Main loop
let last = performance.now(); let accum = 0; const netTick = 1/12;
function frame(nowMs){
  requestAnimationFrame(frame);
  const now = nowMs/1000; let dt = Math.min(cfg.dtClamp, now - (last/1000)); last = nowMs;
  if (over) dt=0;

  const st = im.update();
  const myHero = heroByTeam(role==='guest'?2:1);
  const aimDir = (function(){
    if (!myHero) return {x:1,z:0};
    if (st.drag) return dirNorm(st.drag.dx, st.drag.dy);
    if (st.lockOn){ const t = nearestEnemy(myHero); if (t) return dirNorm(t.x-myHero.x, t.z-myHero.z) }
    return dirNorm(mouseWorld.x - myHero.x, mouseWorld.z - myHero.z);
  })();

  if (role==='host' || role==='local'){
    const h = heroByTeam(1);
    if (h){
      const sp = cfg.hero.speed * slowFactorAt(h.z);
      const len = Math.hypot(st.mx, st.mz)||1; h.vx=(st.mx/len)*sp; h.vz=(st.mz/len)*sp;
      if (st.cast){ castSkill(h, st.cast, aimDir); }
    }
  } else if (role==='guest'){
    net.send({ type:'input', mx:st.mx, mz:st.mz, cast:st.cast||undefined, ax: aimDir.x, az: aimDir.z, lock: st.lockOn?1:0 });
  }

  if (role==='host' || role==='local'){
    simulate(dt);
    accum += dt;
    if (role==='host' && accum>=netTick){ accum=0; net.send({ type:'state', t:time, units:Array.from(units.values()) }); }
  }

  render();
}
requestAnimationFrame(frame);

function simulate(dt){
  time += dt;
  // heroes movement
  units.forEach(u=>{ if(u.type==='hero'){ u.x += u.vx*dt; u.z += u.vz*dt; clampHero(u); } });
  // waves
  nextWave -= dt; if (nextWave<=0){ nextWave = cfg.creep.interval; spawnWave(); }
  // projectiles
  const del=[];
  units.forEach(u=>{
    if (u.type==='proj'){
      u.x += u.vx*dt; u.z += u.vz*dt; u.range -= Math.hypot(u.vx*dt, u.vz*dt);
      if (u.range<=0 || u.x<0||u.x>cfg.mapW||u.z<0||u.z>cfg.mapH){ del.push(u.id); return; }
      let hit=null; units.forEach(t=>{
        if (hit) return; if (t.team===u.team) return; if (t.type==='proj'||t.hp<=0) return;
        const r = t.type==='tower'?cfg.tower.radius : t.type==='core'?cfg.core.radius : cfg.hero.radius;
        if (Math.hypot(t.x-u.x, t.z-u.z) < r) hit=t;
      });
      if (hit){ applyDamage(hit, u.dmg); del.push(u.id); }
    }
  });
  del.forEach(id=>units.delete(id));
  // creeps march & river slow
  units.forEach(u=>{
    if (u.type==='creep'){
      const dir = (u.team===1)? 1 : -1;
      const sp = cfg.creep.speed * slowFactorAt(u.z);
      u.x += dir * sp * dt;
      const t = closestEnemy(u, 22); if (t) applyDamage(t, cfg.creep.dmg);
    }
  });
  // towers
  lastTowerFire += dt; if (lastTowerFire >= cfg.tower.rate){
    lastTowerFire = 0;
    units.forEach(t=>{
      if (t.type==='tower'){
        const target = closestEnemy(t, cfg.tower.range);
        if (target) applyDamage(target, cfg.tower.dmg);
      }
    });
  }
  // win
  let c1=null, c2=null; units.forEach(u=>{ if(u.type==='core'&&u.team===1) c1=u; if(u.type==='core'&&u.team===2) c2=u; });
  if (!over && c1 && c1.hp<=0){ over=true; winEl.style.display='block'; winEl.textContent='Monsters (Team 2) Triumph!' }
  if (!over && c2 && c2.hp<=0){ over=true; winEl.style.display='block'; winEl.textContent='Monsters (Team 1) Triumph!' }
  // camera
  if (!camera.target){ camera.target = heroByTeam(role==='guest'?2:1) }
  camera.update(dt);
}

// ---- Monster Theme Rendering Helpers ----
function drawBlob(x,y,r, body, outline){
  const k = 0.55;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.bezierCurveTo(x + k*r, y - r, x + r, y - k*r, x + r, y);
  ctx.bezierCurveTo(x + r, y + k*r, x + k*r, y + r, x, y + r);
  ctx.bezierCurveTo(x - k*r, y + r, x - r, y + k*r, x - r, y);
  ctx.bezierCurveTo(x - r, y - k*r, x - k*r, y - r, x, y - r);
  ctx.fillStyle = body; ctx.fill();
  if (outline){ ctx.lineWidth = 3; ctx.strokeStyle = outline; ctx.stroke(); }

  // glossy highlight
  const grad = ctx.createRadialGradient(x - r*0.3, y - r*0.4, 2, x - r*0.3, y - r*0.4, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(x - r*0.25, y - r*0.35, r*0.7, 0, Math.PI*2); ctx.fill();
}

function drawEye(x,y, size){
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x,y,size,0,Math.PI*2); ctx.fill();
  ctx.fillStyle = '#111827'; ctx.beginPath(); ctx.arc(x+size*0.2,y,size*0.55,0,Math.PI*2); ctx.fill();
}

function drawHorns(x,y,r, color){
  ctx.fillStyle = color;
  ctx.beginPath(); // left horn
  ctx.moveTo(x - r*0.6, y - r*0.5);
  ctx.lineTo(x - r*0.2, y - r*1.1);
  ctx.lineTo(x - r*0.05, y - r*0.4);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); // right horn
  ctx.moveTo(x + r*0.6, y - r*0.5);
  ctx.lineTo(x + r*0.2, y - r*1.1);
  ctx.lineTo(x + r*0.05, y - r*0.4);
  ctx.closePath(); ctx.fill();
}

function drawTotem(x,y,r, team){
  // tower totem
  ctx.save();
  ctx.translate(x,y);
  ctx.fillStyle = team===1? '#2bd4bd' : '#ff7aa2';
  ctx.strokeStyle = '#0e1726';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-r*0.8, r);
  ctx.lineTo(-r*0.5, -r*0.2);
  ctx.lineTo(r*0.5, -r*0.2);
  ctx.lineTo(r*0.8, r);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // glowing eye
  drawEye(0, -r*0.4, r*0.22);
  ctx.restore();
}

function drawCoreCrystal(x,y,r, team){
  const base = team===1? '#6ee7b7' : '#fca5a5';
  drawBlob(x,y,r, base, '#0e1726');
  // crystal facets
  ctx.save(); ctx.translate(x,y); ctx.rotate(0.2);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath(); ctx.moveTo(-r*0.1,-r*0.8); ctx.lineTo(r*0.2, -r*0.2); ctx.lineTo(-r*0.2, r*0.3); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function renderTerrain(){
  // dark base
  ctx.fillStyle = '#0c1320'; ctx.fillRect(0,0,cfg.mapW,cfg.mapH);
  // organic lane
  ctx.fillStyle = '#172335'; ctx.fillRect(0, cfg.laneZ - 50, cfg.mapW, 100);
  // slime river
  ctx.fillStyle = '#0c3a3a'; ctx.fillRect(0, terrain.riverY - terrain.riverH/2, cfg.mapW, terrain.riverH);
  // jagged walls
  ctx.fillStyle = '#0b1a1e';
  terrain.walls.forEach(([x,y,w,h])=>{ ctx.fillRect(x,y,w,h); });
  // bush patches as glowing moss
  terrain.bushes.forEach(([x,y,r])=>{
    const g = ctx.createRadialGradient(x,y,0,x,y,r);
    g.addColorStop(0, 'rgba(60,200,120,0.5)');
    g.addColorStop(1, 'rgba(60,200,120,0.0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(40,140,90,0.6)'; ctx.beginPath(); ctx.arc(x,y,r*0.7,0,Math.PI*2); ctx.fill();
  });
}

function render(){
  resize();
  ctx.clearRect(0,0,innerWidth,innerHeight);
  camera.w = innerWidth; camera.h = innerHeight;

  camera.apply();
  renderTerrain();

  const viewerTeam = (role==='guest') ? 2 : 1;

  // cores & towers
  units.forEach(u=>{ if(u.type==='core') drawCoreCrystal(u.x,u.z,cfg.core.radius, u.team); });
  units.forEach(u=>{ if(u.type==='tower') drawTotem(u.x,u.z,cfg.tower.radius, u.team); });

  // creeps & heroes with monster shapes
  units.forEach(u=>{
    if (u.type==='creep' || u.type==='hero'){
      const visible = isVisibleTo(u, viewerTeam);
      if (!visible) return;
      if (u.type==='hero'){
        const body = u.team===1 ? '#76e4f7' : '#f7a636';
        drawBlob(u.x,u.z,cfg.hero.radius, body, '#0e1726');
        drawHorns(u.x,u.z,cfg.hero.radius, u.team===1? '#bff4ff' : '#ffe1a8');
        drawEye(u.x - 5, u.z - 4, 3.3);
        drawEye(u.x + 6, u.z - 2, 3.3);
      } else {
        const body = u.team===1 ? '#22c7b7' : '#f87e9b';
        drawBlob(u.x,u.z,cfg.creep.radius, body, '#0e1726');
        drawEye(u.x + 2, u.z - 1, 2.2);
      }
    }
  });

  // projectiles as slime globs
  units.forEach(u=>{
    if(u.type==='proj'){
      drawBlob(u.x,u.z,6, '#e2d66b', '#b09d2e');
    }
  });

  // health bars
  units.forEach(u=>{
    if (u.type==='proj') return;
    const visible = (u.type==='creep'||u.type==='hero') ? isVisibleTo(u, viewerTeam) : true;
    if (!visible) return;
    const maxR=40, ratio=u.hp/u.maxHP;
    if (ratio<1){
      ctx.fillStyle = '#0b1220'; ctx.fillRect(u.x-maxR/2, u.z-30, maxR, 7);
      ctx.fillStyle = ratio>0.5?'#72e07a':ratio>0.2?'#f5b54b':'#ef5a5a';
      ctx.fillRect(u.x-maxR/2, u.z-30, Math.max(0,maxR*ratio), 7);
    }
  });

  camera.restore();
  renderMinimap(viewerTeam);
}

function renderMinimap(viewerTeam){
  const w = mini.width = 200;
  const h = mini.height = 120;
  mctx.clearRect(0,0,w,h);
  const sx = w/cfg.mapW, sz = h/cfg.mapH;

  // base
  mctx.fillStyle = 'rgba(255,255,255,0.06)'; mctx.fillRect(0,0,w,h);
  // river & lane
  mctx.fillStyle = 'rgba(20,140,140,0.35)'; mctx.fillRect(0,(terrain.riverY- terrain.riverH/2)*sz, w, terrain.riverH*sz);
  mctx.fillStyle = 'rgba(255,255,255,0.12)'; mctx.fillRect(0,(cfg.laneZ-50)*sz, w, 100*sz);
  // walls
  mctx.fillStyle = 'rgba(0,0,0,0.35)'; terrain.walls.forEach(([x,y,W,H])=> mctx.fillRect(x*sx,y*sz,W*sx,H*sz));
  // bushes
  mctx.fillStyle = 'rgba(40,160,100,0.6)'; terrain.bushes.forEach(([x,y,r])=>{ mctx.beginPath(); mctx.arc(x*sx, y*sz, r*sx, 0, Math.PI*2); mctx.fill(); });
  // entities (respect stealth)
  units.forEach(u=>{
    let vis = true;
    if ((u.type==='hero'||u.type==='creep')){ vis = isVisibleTo(u, viewerTeam); }
    if (!vis) return;
    let color = '#fff', r=3;
    if (u.type==='hero'){ color = (u.team===1?'#76e4f7':'#f7a636'); r=3.8; }
    else if (u.type==='creep'){ color = (u.team===1?'#22c7b7':'#f87e9b'); r=2.6; }
    else if (u.type==='tower'){ color = (u.team===1?'#2bd4bd':'#ff7aa2'); r=3.2; }
    else if (u.type==='core'){ color = (u.team===1?'#6ee7b7':'#fca5a5'); r=4.2; }
    else if (u.type==='proj'){ color = '#e2d66b'; r=2.2; }
    mctx.beginPath(); mctx.arc(u.x*sx, u.z*sz, r, 0, Math.PI*2); mctx.fillStyle=color; mctx.fill();
  });
}
