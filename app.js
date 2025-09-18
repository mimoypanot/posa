import { InputMux } from "./ui.js";
import { Net } from "./net.js";

const canvas=document.getElementById('canvas');
const ctx=canvas.getContext('2d');
const input=new InputMux(canvas);
const net=new Net();

let players=[
  {x:200,y:200,hp:100,color:'lime'},
  {x:600,y:400,hp:100,color:'crimson'}
];

function resize(){
  canvas.width=innerWidth;
  canvas.height=innerHeight;
}
addEventListener('resize',resize); resize();

document.getElementById('btnLocal').onclick=()=>{
  net.local=true;
};

document.getElementById('btnReset').onclick=()=>{
  players=[{x:200,y:200,hp:100,color:'lime'},{x:600,y:400,hp:100,color:'crimson'}];
};

function update(){
  const me=players[0];
  const {mx,mz,cast}=input.update();
  me.x+=mx*3; me.y+=mz*3;
  if(cast==='A'){
    players[1].hp=Math.max(0,players[1].hp-5);
  }
}

function render(){
  ctx.fillStyle='#1a1a24';
  ctx.fillRect(0,0,canvas.width,canvas.height);

  // Draw monsters
  for(const p of players){
    ctx.beginPath();
    ctx.arc(p.x,p.y,30,0,Math.PI*2);
    ctx.fillStyle=p.color;
    ctx.fill();

    // HP bar
    ctx.fillStyle='red';
    ctx.fillRect(p.x-30,p.y-45,60,6);
    ctx.fillStyle='lime';
    ctx.fillRect(p.x-30,p.y-45,60*(p.hp/100),6);
  }
}

function loop(){
  update();
  render();
  requestAnimationFrame(loop);
}
loop();
