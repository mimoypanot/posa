// ui.js - ML-style controls (polished UI): joystick + skill pad + cooldown wedges + lock toggle
export class InputMux {
  constructor(canvas){
    this.mx = 0; this.mz = 0;
    this.cast = null;     // 'A'|'Q'|'E' on release
    this.drag = null;     // {type:'A'|'Q'|'E', dx, dy}
    this.pointer = { x:0, y:0 };
    this.lockOn = false;  // aim assist / target lock
    this.canvas = canvas;
    this.keys = new Set();
    this._setupKeyboard();
    this._setupMobile();
  }

  _setupKeyboard(){
    addEventListener('keydown', e=>{ this.keys.add(e.key) });
    addEventListener('keyup', e=>{ this.keys.delete(e.key) });
    this.canvas.addEventListener('pointermove', ev=>{
      const r = this.canvas.getBoundingClientRect();
      this.pointer = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    });
  }

  _setupMobile(){
    const stick = document.getElementById('stick');
    const knob = document.getElementById('knob');
    const aimLine = document.getElementById('aimLine');
    const bA = document.getElementById('btnAttack');
    const bQ = document.getElementById('btnQ');
    const bE = document.getElementById('btnE');
    const bLock = document.getElementById('btnLock');

    let active = false, base={x:0,y:0};
    function pt(ev){ const t = ev.touches ? ev.touches[0] : ev; return {x:t.clientX,y:t.clientY} }
    function clamp(v,a,b){ return Math.max(a, Math.min(b, v)) }

    // Joystick
    stick.addEventListener('touchstart', ev=>{
      active = true; const r = stick.getBoundingClientRect(); base = { x:r.left+r.width/2, y:r.top+r.height/2 };
    }, {passive:true});
    stick.addEventListener('touchmove', ev=>{
      if(!active) return; const p = pt(ev);
      const dx = p.x - base.x, dy = p.y - base.y; const max=60;
      const nx = clamp(dx, -max, max), ny = clamp(dy, -max, max);
      knob.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
      this.mx = nx/max; this.mz = -ny/max;
    }, {passive:true});
    stick.addEventListener('touchend', ev=>{
      active = false; knob.style.transform = 'translate(-50%,-50%)'; this.mx=0; this.mz=0;
    }, {passive:true});

    // Skill drag helper
    const bindDrag = (el, type)=>{
      let start=null;
      const onStart = ev=>{
        start = pt(ev); this.drag = { type, dx:0, dy:0 };
        aimLine.style.display='block'; positionAim(start.x, start.y, 0, 0);
      };
      const onMove = ev=>{
        if (!start) return; const p = pt(ev);
        const dx = p.x - start.x, dy = p.y - start.y;
        this.drag = { type, dx, dy };
        positionAim(start.x, start.y, dx, dy);
      };
      const onEnd = ev=>{
        if (this.drag && this.drag.type===type){ this.cast = type; if (navigator.vibrate) navigator.vibrate(12); }
        start = null; this.drag = null; aimLine.style.display='none';
      };
      el.addEventListener('touchstart', onStart, {passive:true});
      el.addEventListener('touchmove', onMove, {passive:true});
      el.addEventListener('touchend', onEnd, {passive:true});
    };

    const positionAim = (sx, sy, dx, dy)=>{
      const length = Math.min(220, Math.hypot(dx, dy));
      const angle = Math.atan2(dy, dx);
      aimLine.style.left = sx+'px'; aimLine.style.top = sy+'px';
      aimLine.style.width = length+'px';
      aimLine.style.transform = `translateX(12px) rotate(${angle}rad)`;
      aimLine.style.display = 'block';
    };

    bindDrag(bA, 'A');
    bindDrag(bQ, 'Q');
    bindDrag(bE, 'E');

    // Lock toggle
    bLock.addEventListener('click', ()=>{
      this.lockOn = !this.lockOn;
      bLock.classList.toggle('on', this.lockOn);
      bLock.textContent = this.lockOn ? 'LOCK ✓' : 'LOCK';
      if (navigator.vibrate) navigator.vibrate(8);
    });
  }

  // Cooldown overlay updates from app
  setCooldowns(rem){ // {A:seconds, Q:seconds, E:seconds}
    const dur = { A:0.6, Q:6, E:10 }; // defaults; just for % display
    const cds = { A:rem.A||0, Q:rem.Q||0, E:rem.E||0 };
    const el = (id)=>document.getElementById(id);
    const set = (key, seconds)=>{
      el('cd'+key).textContent = seconds>0 ? seconds.toFixed(1) : '';
      el('btn'+(key==='A'?'Attack':key)).classList.toggle('locked', seconds>0);
      const pct = Math.max(0, Math.min(1, seconds / (dur[key]||1)));
      el('w'+key).style.setProperty('--deg', f'{int(pct*360)}deg');
      // Also set background directly for better browser support
      el('w'+key).style.background = `conic-gradient(rgba(0,0,0,.55) ${pct*360}deg, transparent 0)`;
    };
    set('A', cds.A); set('Q', cds.Q); set('E', cds.E);
  }

  update(){
    // Keyboard fallback
    const h = (this.keys.has('d')||this.keys.has('D')||this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('a')||this.keys.has('A')||this.keys.has('ArrowLeft') ? 1 : 0);
    const v = (this.keys.has('s')||this.keys.has('S')||this.keys.has('ArrowDown') ? 1 : 0) - (this.keys.has('w')||this.keys.has('W')||this.keys.has('ArrowUp') ? 1 : 0);
    // Normalize + blend with joystick
    let mx = Math.abs(h) >= Math.abs(this.mx) ? h : this.mx;
    let mz = Math.abs(v) >= Math.abs(this.mz) ? v : this.mz;
    const l = Math.hypot(mx, mz) || 1; mx/=l; mz/=l;

    // Skills via keyboard
    let cast = this.cast;
    if (!cast){
      if (this.keys.has(' ')){ cast='A'; this.keys.delete(' '); }
      else if (this.keys.has('q')||this.keys.has('Q')){ cast='Q'; this.keys.delete('q'); this.keys.delete('Q'); }
      else if (this.keys.has('e')||this.keys.has('E')){ cast='E'; this.keys.delete('e'); this.keys.delete('E'); }
      if (cast && navigator.vibrate) navigator.vibrate(12);
    }

    const drag = this.drag; // may be null
    const pointer = this.pointer;

    // Reset one-shot cast after returning
    this.cast = null;

    return { mx, mz, cast, drag, pointer, lockOn: this.lockOn };
  }
}
