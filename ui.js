// ui.js – handles input (keyboard + mobile joystick/buttons)

export class InputMux {
  constructor(canvas) {
    this.mx = 0; this.mz = 0;
    this.cast = null;
    this.canvas = canvas;
    this.keys = new Set();
    this._setupKeyboard();
    this._setupMobile();
  }

  _setupKeyboard() {
    addEventListener('keydown', e => this.keys.add(e.key));
    addEventListener('keyup', e => this.keys.delete(e.key));
  }

  _setupMobile() {
    const stick = document.getElementById('stick');
    const knob = document.getElementById('knob');
    const bA = document.getElementById('btnAttack');
    const bQ = document.getElementById('btnQ');
    const bE = document.getElementById('btnE');

    let active = false, base={x:0,y:0};
    function pt(ev){ const t = ev.touches?ev.touches[0]:ev; return {x:t.clientX,y:t.clientY} }

    // Joystick
    stick.addEventListener('touchstart', ev=>{
      active = true;
      const r=stick.getBoundingClientRect();
      base={x:r.left+r.width/2,y:r.top+r.height/2};
    });
    stick.addEventListener('touchmove', ev=>{
      if(!active) return;
      const p=pt(ev);
      const dx=p.x-base.x, dy=p.y-base.y, max=50;
      const nx=Math.max(-max,Math.min(max,dx));
      const ny=Math.max(-max,Math.min(max,dy));
      knob.style.transform=`translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
      this.mx=nx/max; this.mz=-ny/max;
    });
    stick.addEventListener('touchend', ev=>{
      active=false; knob.style.transform='translate(-50%,-50%)';
      this.mx=0; this.mz=0;
    });

    // Buttons
    bA.addEventListener('touchend',()=>{this.cast='A';});
    bQ.addEventListener('touchend',()=>{this.cast='Q';});
    bE.addEventListener('touchend',()=>{this.cast='E';});
  }

  update() {
    // keyboard movement
    const h=(this.keys.has('d')||this.keys.has('ArrowRight')?1:0)-(this.keys.has('a')||this.keys.has('ArrowLeft')?1:0);
    const v=(this.keys.has('s')||this.keys.has('ArrowDown')?1:0)-(this.keys.has('w')||this.keys.has('ArrowUp')?1:0);

    let mx=Math.abs(h)>=Math.abs(this.mx)?h:this.mx;
    let mz=Math.abs(v)>=Math.abs(this.mz)?v:this.mz;
    const l=Math.hypot(mx,mz)||1; mx/=l; mz/=l;

    let cast=this.cast; this.cast=null;
    if(!cast){
      if(this.keys.has(' ')){cast='A'; this.keys.delete(' ');}
      if(this.keys.has('q')||this.keys.has('Q')){cast='Q'; this.keys.delete('q'); this.keys.delete('Q');}
      if(this.keys.has('e')||this.keys.has('E')){cast='E'; this.keys.delete('e'); this.keys.delete('E');}
    }
    return {mx,mz,cast};
  }
}
