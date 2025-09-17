// app.js - Game loop + rendering + ML-style controls + WebRTC + lock/auto-aim + cooldowns + minimap
import { initFirebase, Net } from './net.js';
import { InputMux } from './ui.js';

const canvas = document.getElementById('canvas');
const mini = document.getElementById('minimap');
const ctx = canvas.getContext('2d');
const mctx = mini.getContext('2d');
const statusEl = document.getElementById('status');
const winEl = document.getElementById('win');

const cfg = {
  mapW: 2000, mapH: 1200, laneZ: 600, laneHalf: 60,
  hero: { hp:700, speed: 220, q:{dmg:80, speed: 640, range:900, cd:6}, e:{dist:220, cd:10}, a:{dmg:40, speed:700, range:600, cd:0.6}, radius: 14 },
  creep: { hp:220, speed: 120, dmg:12, wave:3, interval:15, radius: 10 },
  tower: { hp:900, range:260, dmg:18, rate:0.75, radius: 18 },
  core: { hp:1500, radius: 26 },
  dtClamp: 1/20,
};

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

// Game state
let units = new Map();
let time = 0, nextWave = 2, lastTowerFire = 0, over=false;
let meId = null, myTeam = 1;

// helpers
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
function nearestEnemy(from){ // no range limit
  let best=null, bestD=Infinity;
  units.forEach(u=>{
    if(u.team===from.team) return; if (u.hp<=0) return; if (u.type==='proj') return;
    const d = Math.hypot(u.x-from.x, u.z-from.z);
    if (d<bestD) { best=u; bestD=d; }
  });
  return best;
}
function applyDamage(t, dmg){ t.hp = Math.max(0, t.hp - dmg) }
function clampHero(h){ h.x=clamp(h.x,0,cfg.mapW); h.z=clamp(h.z,cfg.laneZ-cfg.laneHalf,cfg.laneZ+cfg.laneHalf); }

function make(type, team, x, z, hp, extra={}){
  const u = { id: uid(type+'-'), type, team, x, z, vx:0, vz:0, hp, maxHP:hp, ...extra };
  units.set(u.id, u); return u;
}
function reset(){
  units.clear(); over=false; winEl.style.display='none';
  make('tower',1, 600, cfg.laneZ, cfg.tower.hp);
  make('tower',2, cfg.mapW-600, cfg.laneZ, cfg.tower.hp);
  make('core', 1, 220, cfg.laneZ, cfg.core.hp);
  make('core', 2, cfg.mapW-220, cfg.laneZ, cfg.core.hp);
  const p1 = make('hero',1, 300, cfg.laneZ, cfg.hero.hp, {qReady:0,eReady:0,aReady:0});
  const p2 = make('hero',2, cfg.mapW-300, cfg.laneZ, cfg.hero.hp, {qReady:0,eReady:0,aReady:0});
  time=0; nextWave=2; lastTowerFire=0;
  return { p1, p2 };
}

function spawnWave(){
  for(let i=0;i<cfg.creep.wave;i++){
    make('creep',1, 360+i*16, cfg.laneZ, cfg.creep.hp);
    make('creep',2, cfg.mapW-360-i*16, cfg.laneZ, cfg.creep.hp);
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

// Choose aim direction: drag > lock target > pointer
function computeAimDir(hero, input, pointerWorld){
  if (!hero) return {x:1, z:0};
  if (input.drag){ return dirNorm(input.drag.dx, input.drag.dy); }
  if (input.lockOn){
    const t = nearestEnemy(hero);
    if (t){ return dirNorm(t.x-hero.x, t.z-hero.z); }
  }
  return dirNorm(pointerWorld.x - hero.x, pointerWorld.z - hero.z);
}

// Net
const net = new Net();
let role = 'local'; // 'host'|'guest'|'local'
let firebaseFns = null;

// UI buttons
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
    const { p1 } = initLocal(); // host simulates
    myTeam = 1; role='host'; meId = p1.id; camera.target = heroByTeam(1);
    statusEl.textContent = 'Hosting… ' + code;
    await net.host(code, firebaseFns);
  }catch(e){ console.error(e); alert(e.message||e); }
};

btnJoin.onclick = async ()=>{
  try{
    await ensureFirebase();
    const code = (roomInput.value||'room1').toLowerCase();
    role='guest'; units.clear(); statusEl.textContent = 'Joining… ' + code;
    myTeam = 2;
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
      const len = Math.hypot(msg.mx, msg.mz)||1; h.vx=(msg.mx/len)*cfg.hero.speed; h.vz=(msg.mz/len)*cfg.hero.speed;
      if (msg.cast){
        const aim = dirNorm(msg.ax, msg.az);
        castSkill(h, msg.cast, aim);
      }
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
  const aimDir = computeAimDir(myHero, st, mouseWorld);

  if (role==='host' || role==='local'){
    const h = heroByTeam(1);
    if (h){
      const len = Math.hypot(st.mx, st.mz)||1; h.vx=(st.mx/len)*cfg.hero.speed; h.vz=(st.mz/len)*cfg.hero.speed;
      if (st.cast){ castSkill(h, st.cast, aimDir); }
    }
  } else if (role==='guest'){
    net.send({ type:'input', mx:st.mx, mz:st.mz, cast:st.cast||undefined, ax: aimDir.x, az: aimDir.z, lock: st.lockOn?1:0 });
  }

  // simulate + snapshots
  if (role==='host' || role==='local'){
    simulate(dt);
    accum += dt;
    if (role==='host' && accum>=netTick){ accum=0; net.send({ type:'state', t:time, units:Array.from(units.values()) }); }
  }

  // cooldown overlays (from team1 hero locally / from myHero if guest)
  const cdH = heroByTeam(role==='guest'?2:1) || myHero;
  if (cdH){
    const rem = {
      A: Math.max(0, (cdH.aReady||0) - time),
      Q: Math.max(0, (cdH.qReady||0) - time),
      E: Math.max(0, (cdH.eReady||0) - time),
    };
    im.setCooldowns(rem);
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
  // creeps
  units.forEach(u=>{
    if (u.type==='creep'){
      const dir = (u.team===1)? 1 : -1;
      u.x += dir * cfg.creep.speed * dt;
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
  if (!over && c1 && c1.hp<=0){ over=true; winEl.style.display='block'; winEl.textContent='Team 2 Wins!' }
  if (!over && c2 && c2.hp<=0){ over=true; winEl.style.display='block'; winEl.textContent='Team 1 Wins!' }
  // camera
  if (!camera.target){ camera.target = heroByTeam(role==='guest'?2:1) }
  camera.update(dt);
}

function drawRect(x,y,w,h,c){ ctx.fillStyle=c; ctx.fillRect(x,y,w,h) }
function drawCircle(x,y,r, fill, lw=0, stroke=null){ ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fillStyle=fill; ctx.fill(); if (lw>0){ ctx.lineWidth=lw; ctx.strokeStyle=stroke||'#fff'; ctx.stroke(); } }

function render(){
  resize();
  ctx.clearRect(0,0,innerWidth,innerHeight);
  camera.w = innerWidth; camera.h = innerHeight;

  camera.apply();
  drawRect(0,0,cfg.mapW,cfg.mapH,'#0f172a');
  drawRect(0,cfg.laneZ-40,cfg.mapW,80,'#1f2937');

  units.forEach(u=>{ if(u.type==='core') drawCircle(u.x,u.z,cfg.core.radius, u.team===1?'#7dd3fc':'#fca5a5',3,'#fff'); });
  units.forEach(u=>{ if(u.type==='tower') drawCircle(u.x,u.z,cfg.tower.radius, u.team===1?'#38bdf8':'#f87171',2,'#e5e7eb'); });
  units.forEach(u=>{ if(u.type==='creep') drawCircle(u.x,u.z,cfg.creep.radius, u.team===1?'#22d3ee':'#fb7185'); });
  units.forEach(u=>{ if(u.type==='hero') drawCircle(u.x,u.z,cfg.hero.radius, u.team===1?'#60a5fa':'#f59e0b',3,'#111827'); });
  units.forEach(u=>{ if(u.type==='proj') drawCircle(u.x,u.z,6,'#eab308'); });

  // HP bars
  units.forEach(u=>{
    if (u.type==='proj') return;
    const maxR=36, ratio=u.hp/u.maxHP;
    if (ratio<1){
      drawRect(u.x-maxR/2, u.z-28, maxR, 6, '#111827');
      drawRect(u.x-maxR/2, u.z-28, Math.max(0,maxR*ratio), 6, ratio>0.5?'#22c55e':ratio>0.2?'#f59e0b':'#ef4444');
    }
  });

  camera.restore();

  // Minimap
  renderMinimap();
}

function renderMinimap(){
  const w = mini.width = 180;
  const h = mini.height = 108;
  mctx.clearRect(0,0,w,h);
  // background and lane
  mctx.fillStyle = 'rgba(255,255,255,0.06)'; mctx.fillRect(0,0,w,h);
  mctx.fillStyle = 'rgba(255,255,255,0.12)';
  const laneY = (cfg.laneZ/cfg.mapH)*h;
  mctx.fillRect(0,laneY-3,w,6);
  // scale positions
  const sx = w/cfg.mapW, sz = h/cfg.mapH;
  // draw entities
  units.forEach(u=>{
    let color = '#fff', r=3;
    if (u.type==='hero'){ color = (u.team===1?'#60a5fa':'#f59e0b'); r=3.5; }
    else if (u.type==='creep'){ color = (u.team===1?'#22d3ee':'#fb7185'); r=2.5; }
    else if (u.type==='tower'){ color = (u.team===1?'#38bdf8':'#f87171'); r=3; }
    else if (u.type==='core'){ color = (u.team===1?'#7dd3fc':'#fca5a5'); r=4; }
    else if (u.type==='proj'){ color = '#eab308'; r=2; }
    mctx.beginPath(); mctx.arc(u.x*sx, u.z*sz, r, 0, Math.PI*2); mctx.fillStyle=color; mctx.fill();
  });
}
