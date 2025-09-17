// net.js - WebRTC networking with Firebase RTDB signaling (DataChannel 'game')
let firebaseApp = null, db = null;
let imported = false;

export async function initFirebase(config){
  if (imported) return;
  imported = true;
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js');
  const { getDatabase, ref, onValue, set, push, get } = await import('https://www.gstatic.com/firebasejs/10.12.4/firebase-database.js');
  firebaseApp = initializeApp(config);
  db = getDatabase(firebaseApp);
  return { ref, onValue, set, push, get };
}

export class Net {
  constructor(){
    this.pc = null; this.channel = null; this.role='none'; this.room=null;
    this.onOpen=()=>{}; this.onClose=()=>{}; this.onMessage=(_)=>{};
    this.fns=null;
  }
  async _pc(){
    this.pc = new RTCPeerConnection({ iceServers:[{urls:['stun:stun.l.google.com:19302']}] });
    this.pc.onconnectionstatechange = () => {
      if (['disconnected','failed','closed'].includes(this.pc.connectionState)) this.onClose();
    };
    this.pc.onicecandidate = async (ev) => {
      if (!this.room || !db || !ev.candidate) return;
      const path = this.role==='host' ? `rooms/${this.room}/callerCandidates` : `rooms/${this.room}/calleeCandidates`;
      await this.fns.push(this.fns.ref(db, path), ev.candidate.toJSON());
    };
  }
  _wireChannel(ch){
    this.channel = ch;
    ch.onopen = ()=>this.onOpen();
    ch.onclose = ()=>this.onClose();
    ch.onmessage = (ev)=> this.onMessage(ev.data);
  }
  async host(room, fns){
    this.fns = fns; this.role='host'; this.room=room; await this._pc();
    const ch = this.pc.createDataChannel('game', { ordered:true }); this._wireChannel(ch);
    const offer = await this.pc.createOffer(); await this.pc.setLocalDescription(offer);
    await fns.set(fns.ref(db, `rooms/${room}`), { offer });
    fns.onValue(fns.ref(db, `rooms/${room}/answer`), async (snap)=>{
      const ans = snap.val(); if (ans && ans.type) await this.pc.setRemoteDescription(new RTCSessionDescription(ans));
    });
    fns.onValue(fns.ref(db, `rooms/${room}/calleeCandidates`), (snap)=>{
      snap.forEach(c=>{ const v=c.val(); if(v&&v.candidate) this.pc.addIceCandidate(new RTCIceCandidate(v)); });
    });
  }
  async join(room, fns){
    this.fns = fns; this.role='guest'; this.room=room; await this._pc();
    this.pc.ondatachannel = (ev)=>{ if(ev.channel.label==='game') this._wireChannel(ev.channel); };
    const snap = await fns.get(fns.ref(db, `rooms/${room}`)); const data = snap.val();
    if (!data || !data.offer) throw new Error('No offer found. Ask host to create room first.');
    await this.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const ans = await this.pc.createAnswer(); await this.pc.setLocalDescription(ans);
    await fns.set(fns.ref(db, `rooms/${room}/answer`), ans);
    fns.onValue(fns.ref(db, `rooms/${room}/callerCandidates`), (snap)=>{
      snap.forEach(c=>{ const v=c.val(); if(v&&v.candidate) this.pc.addIceCandidate(new RTCIceCandidate(v)); });
    });
  }
  send(obj){
    if (this.channel && this.channel.readyState==='open'){
      this.channel.send(typeof obj==='string' ? obj : JSON.stringify(obj));
    }
  }
}
