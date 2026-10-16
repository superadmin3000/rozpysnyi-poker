const socket=io();let state=null,hand=[];
let lastTrickKey='';
let sfxMuted=false;
try{ sfxMuted=localStorage.getItem('rozpysnyi_sfx_mute')==='1'; }catch(e){}

/* ===== Звуки (Web Audio, без файлів) ===== */
let audioCtx=null;
function ensureAudio(){
  try{
    const AC=window.AudioContext||window.webkitAudioContext; if(!AC) return null;
    if(!audioCtx) audioCtx=new AC();
    if(audioCtx.state==='suspended') audioCtx.resume();
    return audioCtx;
  }catch(e){ return null; }
}
function tone({freq=440,freqEnd=null,type='sine',dur=.12,vol=.12,delay=0,attack=.008,curve='exp'}){
  if(sfxMuted) return;
  const ctx=ensureAudio(); if(!ctx) return;
  const t0=ctx.currentTime+delay;
  const osc=ctx.createOscillator();
  const gain=ctx.createGain();
  osc.type=type;
  osc.frequency.setValueAtTime(freq,t0);
  if(freqEnd!=null){
    if(curve==='lin') osc.frequency.linearRampToValueAtTime(freqEnd,t0+dur);
    else osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd,20),t0+dur);
  }
  gain.gain.setValueAtTime(.0001,t0);
  gain.gain.exponentialRampToValueAtTime(Math.max(vol,.001),t0+attack);
  gain.gain.exponentialRampToValueAtTime(.0001,t0+dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0); osc.stop(t0+dur+.02);
}
function noiseBurst({dur=.08,vol=.06,delay=0,bpFreq=1200,bpQ=1.2}){
  if(sfxMuted) return;
  const ctx=ensureAudio(); if(!ctx) return;
  const n=Math.floor(ctx.sampleRate*dur);
  const buf=ctx.createBuffer(1,n,ctx.sampleRate);
  const data=buf.getChannelData(0);
  for(let i=0;i<n;i++) data[i]=(Math.random()*2-1)*Math.pow(1-i/n,1.5);
  const src=ctx.createBufferSource();
  src.buffer=buf;
  const bp=ctx.createBiquadFilter();
  bp.type='bandpass'; bp.frequency.value=bpFreq; bp.Q.value=bpQ;
  const gain=ctx.createGain();
  const t0=ctx.currentTime+delay;
  gain.gain.setValueAtTime(vol,t0);
  gain.gain.exponentialRampToValueAtTime(.0001,t0+dur);
  src.connect(bp).connect(gain).connect(ctx.destination);
  src.start(t0); src.stop(t0+dur+.02);
}

const SFX={
  // М'який «клац» карти
  card(){
    noiseBurst({dur:.05,vol:.05,bpFreq:1800,bpQ:2});
    tone({freq:220,freqEnd:90,type:'triangle',dur:.09,vol:.1});
  },
  // Роздача — коротка серія легких кліків
  deal(count=5){
    const n=Math.min(count,8);
    for(let i=0;i<n;i++){
      const d=i*0.055;
      noiseBurst({dur:.035,vol:.035,delay:d,bpFreq:1600+i*80,bpQ:2});
      tone({freq:260+i*18,freqEnd:140,type:'triangle',dur:.06,vol:.05,delay:d});
    }
  },
  // Хтось забрав взятку — приємний акорд вгору
  trick(){
    tone({freq:330,type:'sine',dur:.14,vol:.08});
    tone({freq:415,type:'sine',dur:.16,vol:.07,delay:.04});
    tone({freq:523,type:'triangle',dur:.22,vol:.09,delay:.08});
    noiseBurst({dur:.06,vol:.03,delay:.02,bpFreq:900,bpQ:1});
  },
  // Замовлення
  bid(){
    tone({freq:480,freqEnd:520,type:'sine',dur:.08,vol:.07});
    tone({freq:620,type:'triangle',dur:.1,vol:.05,delay:.05});
  },
  // Ваш хід
  yourTurn(){
    tone({freq:520,type:'sine',dur:.1,vol:.06});
    tone({freq:660,type:'sine',dur:.12,vol:.07,delay:.07});
  },
  // Кінець раунду
  roundEnd(){
    [392,494,587].forEach((f,i)=>tone({freq:f,type:'triangle',dur:.2,vol:.08,delay:i*.09}));
  },
  // Кінець партії — фанфари перемоги
  gameEnd(){
    // Вступний акорд
    [523,659,784].forEach((f,i)=>tone({freq:f,type:'sine',dur:.28,vol:.1,delay:i*.05}));
    // Підйом
    [523,659,784,1046].forEach((f,i)=>tone({freq:f,type:'triangle',dur:.32,vol:.11,delay:.25+i*.12}));
    // Фінальний блиск
    tone({freq:1319,type:'sine',dur:.45,vol:.1,delay:.85});
    tone({freq:1568,type:'sine',dur:.5,vol:.08,delay:.95});
    noiseBurst({dur:.12,vol:.04,delay:.2,bpFreq:1200,bpQ:1});
    noiseBurst({dur:.15,vol:.035,delay:.9,bpFreq:2000,bpQ:1.5});
  },
  // Додаткові оплески / свято
  victory(){
    SFX.gameEnd();
    [784,988,1175,1568].forEach((f,i)=>tone({freq:f,type:'sine',dur:.2,vol:.07,delay:1.2+i*.08}));
  },
  // Кнопка / UI
  ui(){
    tone({freq:700,freqEnd:900,type:'sine',dur:.05,vol:.04});
  },
  // Джокер
  joker(){
    tone({freq:180,freqEnd:360,type:'sawtooth',dur:.12,vol:.05});
    tone({freq:540,freqEnd:280,type:'triangle',dur:.18,vol:.07,delay:.06});
  }
};
function cardSound(){ SFX.card(); }
function toggleSfx(){
  sfxMuted=!sfxMuted;
  try{ localStorage.setItem('rozpysnyi_sfx_mute',sfxMuted?'1':'0'); }catch(e){}
  updateSfxBtn();
  if(!sfxMuted) SFX.ui();
}
function updateSfxBtn(){
  const b=$('sfxBtn');
  if(b){ b.textContent=sfxMuted?'🔇':'🔊'; b.title=sfxMuted?'Увімкнути звук':'Вимкнути звук'; b.classList.toggle('muted',sfxMuted); }
}
// Розблокування AudioContext після першого кліку/тачу
['pointerdown','keydown'].forEach(ev=>document.addEventListener(ev,()=>ensureAudio(),{once:true,passive:true}));
const $=id=>document.getElementById(id);const red=c=>c.suit==='♥'||c.suit==='♦';
const SS_KEY='rozpysnyi_session';
// localStorage — щоб сесія переживала закриття браузера / перезавантаження телефону
function saveSession(code,token,name){
  try{
    const data={code,token,name:name||($('name')&&$('name').value)||''};
    localStorage.setItem(SS_KEY,JSON.stringify(data));
    sessionStorage.setItem(SS_KEY,JSON.stringify(data));
  }catch(e){}
}
function loadSession(){
  try{
    const a=localStorage.getItem(SS_KEY)||sessionStorage.getItem(SS_KEY);
    return a?JSON.parse(a):null;
  }catch(e){return null}
}
function clearSession(){
  try{localStorage.removeItem(SS_KEY);sessionStorage.removeItem(SS_KEY)}catch(e){}
}
$('create').onclick=()=>socket.emit('createRoom',{
  name:$('name').value,
  password:($('createPass')&&$('createPass').value)||''
},res=>{
  if(!res||!res.ok) return err(res&&res.error);
  if(res.name)$('name').value=res.name;
  saveSession(res.code,res.token,res.name); enter(res.code);
});
function doJoin(code, password){
  err('');
  const nm=($('name')&&$('name').value)||'';
  if(!String(nm).trim()){
    return err('Вкажіть ім’я — за ним можна повернутися в гру з іншого пристрою');
  }
  socket.emit('joinRoom',{
    name:nm,
    code:code,
    password: password!=null ? password : (($('joinPass')&&$('joinPass').value)||'')
  },res=>{
    if(!res||!res.ok){
      if(res&&res.needPassword){
        const pwd=prompt('Кімната захищена паролем. Введіть пароль:');
        if(pwd==null) return err(res.error||'Потрібен пароль');
        return doJoin(code, pwd);
      }
      return err(res&&res.error);
    }
    if(res.name)$('name').value=res.name;
    saveSession(res.code,res.token,res.name); enter(res.code);
  });
}
$('join').onclick=()=>doJoin($('code').value);
function err(x){const e=$('err'); if(e) e.textContent=x||''}
function enter(code){
  $('lobby').hidden=true;$('game').hidden=false;
  $('room').textContent='Кімната '+code;
}
function updateRoomLabel(){
  if(!state||!$('room')) return;
  const lock=state.hasPassword?'🔒 ':'';
  $('room').textContent=lock+'Кімната '+state.code;
}

/* ===== Список кімнат ===== */
let roomListCache=[];
function renderRoomList(list){
  roomListCache=Array.isArray(list)?list:[];
  const el=$('roomList'); if(!el) return;
  if(!roomListCache.length){
    el.innerHTML='<div class="room-list-empty">Немає активних кімнат — створіть першу</div>';
    return;
  }
  el.innerHTML=roomListCache.map(r=>{
    const lock=r.hasPassword?'🔒 ':'';
    const offline=(r.offlineNames&&r.offlineNames.length)?` · офлайн: ${r.offlineNames.map(esc).join(', ')}`:'';
    const busy=!r.joinable;
    let status;
    if(r.phase==='lobby') status=`${r.players}/4`;
    else status=`${esc(r.phaseLabel||'Гра')}${r.online!=null?` · ${r.online} онлайн`:''}`;
    const names=r.host?esc(r.host):'';
    const disabled=busy?'disabled':'';
    const cls=busy?'room-row busy':'room-row';
    const goLabel = r.phase!=='lobby' && r.offlineNames&&r.offlineNames.length
      ? 'Повернутися →'
      : (busy?'—':'Увійти →');
    return `<button type="button" class="${cls}" data-code="${esc(r.code)}" data-lock="${r.hasPassword?1:0}" ${disabled}>
      <span class="room-code">${lock}${esc(r.code)}</span>
      <span class="room-meta">${names} · ${status}${offline}</span>
      <span class="room-go">${goLabel}</span>
    </button>`;
  }).join('');
  el.querySelectorAll('.room-row:not([disabled])').forEach(btn=>{
    btn.onclick=()=>{
      const code=btn.dataset.code;
      const needsLock=btn.dataset.lock==='1';
      if(needsLock){
        const pwd=prompt('Пароль кімнати '+code+':');
        if(pwd==null) return;
        doJoin(code, pwd);
      } else {
        doJoin(code, '');
      }
    };
  });
}
socket.on('roomList', list=> renderRoomList(list));
if($('refreshRooms')) $('refreshRooms').onclick=()=>socket.emit('listRooms', res=>{
  if(res&&res.rooms) renderRoomList(res.rooms);
  else socket.emit('listRooms');
});
let prevState=null;
let dealAnimToken=0;
let handAnimPending=false;

socket.on('removedFromRoom',msg=>{
  clearSession();
  alert(msg&&msg.reason?msg.reason:'Вас видалено з кімнати.');
  location.reload();
});
socket.on('state',s=>{
  const key=(s.trick||[]).map(x=>x.player+':'+(x.card&&x.card.id||x.card&&x.card.rank+x.card.suit||'J')).join('|');
  const prev=state;
  const prevLen=(prev&&prev.trick)?prev.trick.length:0;
  const newLen=(s.trick||[]).length;

  // Нова карта у взятці — звук + анімація ходу
  if(prev && key && key!==lastTrickKey && newLen>prevLen){
    const added=s.trick[s.trick.length-1];
    if(added&&added.card&&added.card.joker) SFX.joker();
    else SFX.card();
    if(added) animatePlayCard(added.player, added.card);
  }
  // Взятку забрано (trick очистився після 4 карт)
  if(prev && prevLen===4 && newLen===0 && typeof s.winner==='number'){
    SFX.trick();
    animateTakeTrick(prev.trick, s.winner);
  }
  // Початок роздачі / новий раунд з картами
  if(prev && (
    (prev.phase!=='playing' && prev.phase!=='bidding' && (s.phase==='playing'||s.phase==='bidding')) ||
    (prev.roundIndex!==s.roundIndex && (s.phase==='playing'||s.phase==='bidding'))
  )){
    handAnimPending=true;
  }
  // Замовлення зроблено
  if(prev && (s.phase==='bidding'||s.phase==='prebid'||s.phase==='playing')){
    const prevBids=(prev.players||[]).map(p=>p.bid).join(',');
    const newBids=(s.players||[]).map(p=>p.bid).join(',');
    if(prevBids!==newBids && newBids.split(',').filter(x=>x!=='').length>prevBids.split(',').filter(x=>x!=='').length){
      SFX.bid();
    }
  }
  // Фази
  if(prev && prev.phase!==s.phase){
    if(s.phase==='roundEnd') SFX.roundEnd();
    else if(s.phase==='gameEnd'){
      SFX.victory();
      showVictoryOverlay(s);
    }
  }
  // Ваш хід
  if(prev){
    const myId=socket.id;
    const prevTurn=prev.players&&prev.players[prev.turn]&&prev.players[prev.turn].id===myId;
    const nowTurn=s.players&&s.players[s.turn]&&s.players[s.turn].id===myId;
    if(!prevTurn && nowTurn && ['bidding','prebid','playing'].includes(s.phase)){
      SFX.yourTurn();
    }
  }

  prevState=prev;
  state=s; lastTrickKey=key;
  render();
});
socket.on('hand',h=>{
  const suitOrder={'♠':0,'♥':1,'♦':2,'♣':3};
  const prevCount=hand.length;
  hand=(h||[]).slice().sort((a,b)=>{
    if(a.joker&&b.joker)return 0; if(a.joker)return 1; if(b.joker)return -1;
    const sa=suitOrder[a.suit]??9, sb=suitOrder[b.suit]??9;
    if(sa!==sb)return sa-sb;
    return rankValue(a.rank)-rankValue(b.rank);
  });
  // Роздача: рука з'явилась / значно виросла
  if(handAnimPending || (prevCount===0 && hand.length>0) || hand.length>prevCount+1){
    handAnimPending=false;
    SFX.deal(hand.length);
    renderHand(true);
  } else {
    renderHand(false);
  }
});
// Авто-перепідключення: токен (той самий пристрій) або нік+код
(function tryReconnect(){
  const s=loadSession();
  if(!s||!s.code) return;
  if(s.name && $('name')) $('name').value=s.name;
  const payload={code:s.code,token:s.token||null,name:s.name||($('name')&&$('name').value)||''};
  socket.emit('reconnectRoom',payload,res=>{
    if(res&&res.ok){
      if(res.name)$('name').value=res.name;
      saveSession(res.code,res.token,res.name);
      enter(res.code);
    } else if(res&&res.needPassword){
      // пароль потрібен — залишаємо в лобі, код підставляємо
      if($('code')) $('code').value=s.code;
      err('Кімната з паролем — введіть пароль і увійдіть зі своїм ніком');
    } else {
      // сесія протухла, але нік лишаємо для ручного входу
      clearSession();
      if(s.name && $('name')) $('name').value=s.name;
      if(s.code && $('code')) $('code').value=s.code;
    }
  });
})();
function roundWatermarkLabel(r){
  if(!r) return '';
  const mode=r.mode||'normal';
  if(mode==='gold') return 'Золото';
  if(mode==='misere') return 'Мізер';
  if(mode==='dark') return 'Темна';
  if(mode==='notrump') return 'Без козиря';
  // Звичайні раунди 1–9 — лише номер
  const n=String(r.name||'').match(/^\d+/);
  if(n) return n[0];
  return String(r.name||'');
}
function render(){
 if(!state)return;
 const r=state.round;
 $('round').textContent=`Раунд ${r.name}`;
 const wm=$('roundWatermark');
 const wmIn=$('roundWatermarkInner')||wm;
 if(wm){
   const label=roundWatermarkLabel(r);
   const show=label && state.phase && state.phase!=='lobby';
   if(show){
     const unit=label + '     ';
     const line=unit.repeat(24);
     const html=Array.from({length:16},()=>`<span class="wm-line">${line}</span>`).join('');
     if(wmIn && wmIn!==wm) wmIn.innerHTML=html;
     else wm.innerHTML=`<div class="wm-inner">${html}</div>`;
   } else {
     if(wmIn && wmIn!==wm) wmIn.innerHTML='';
     else wm.innerHTML='';
   }
   wm.hidden=!show;
   wm.dataset.mode=(r&&r.mode)||'normal';
 }
 updateRoomLabel();
 (function renderTrump(){
   const el=$('trump'); if(!el) return;
   const tc=state.trumpCard;
   // Підсумок замовлень: перебір / недобір (після того, як усі зробили ставку)
   // Перебір = сума замовлень > кількості взяток у раунді; Недобір = сума < кількості взяток
   let bidSummary='';
   const allBid=state.players && state.players.length===4 && state.players.every(p=>p.bid!==null && p.bid!==undefined);
   const showBidSummary=allBid && state.round && ['playing','roundEnd'].includes(state.phase)
     && state.round.mode!=='gold' && state.round.mode!=='misere';
   if(showBidSummary){
     // Кількість взяток у раунді = карт у роздачі кожному
     // (p.tricks — це виграні взятки, НЕ зіграні карти; не плутати)
     let n=Number(state.round && state.round.cards)||0;
     if(!n){
       // запасний варіант: карт на руці + уже завершені взятки (+1 якщо гравець уже походив у поточній)
       const done=state.players.reduce((s,p)=>s+(Number(p.tricks)||0),0);
       for(let i=0;i<state.players.length;i++){
         const p=state.players[i];
         const inCur=(state.trick||[]).some(t=>t.player===i)?1:0;
         n=Math.max(n, (Number(p.cards)||0)+done+inCur);
       }
     }
     const sum=state.players.reduce((s,p)=>s+(Number(p.bid)||0),0);
     // Недобір: замовлено БІЛЬШЕ ніж взяток (хтось недобере)
     // Перебір: замовлено МЕНШЕ ніж взяток (хтось перебере)
     const diff=sum-n;
     if(diff>0) bidSummary=`<div class="bid-summary under">Недобір ${diff}</div>`;
     else if(diff<0) bidSummary=`<div class="bid-summary over">Перебір ${-diff}</div>`;
     else bidSummary=`<div class="bid-summary even">Рівно ${n}</div>`;
   }
   let body='';
   if(r && r.mode==='notrump'){
     body=`<div class="trump-badge trump-none"><span class="trump-badge-title">БЕЗ КОЗИРЯ</span></div>`;
   } else if(tc && !tc.joker && state.trump){
     const isRed=tc.suit==='♥'||tc.suit==='♦';
     body=`<div class="trump-badge" title="Козирна карта (не хід)">
       <span class="trump-badge-title">КОЗИР</span>
       <span class="trump-badge-card ${isRed?'red':''}"><b>${esc(tc.rank)}</b>${tc.suit}</span>
     </div>`;
   } else if(tc && tc.joker){
     body=`<div class="trump-badge trump-none" title="Відкрився джокер">
       <span class="trump-badge-title">БЕЗ КОЗИРЯ</span>
       <span class="trump-badge-card">🃏</span>
     </div>`;
   } else if(state.trump){
     const isRed=state.trump==='♥'||state.trump==='♦';
     body=`<div class="trump-badge" title="Козир">
       <span class="trump-badge-title">КОЗИР</span>
       <span class="trump-badge-card ${isRed?'red':''}">${state.trump}</span>
     </div>`;
   } else {
     body=`<div class="trump-badge trump-none"><span class="trump-badge-title">БЕЗ КОЗИРЯ</span></div>`;
   }
   el.innerHTML=bidSummary+body;
 })();
 // Розсадка: поточний гравець завжди знизу (seat-bottom = player1)
 const myIndex=state.players.findIndex(p=>p.id===socket.id);
 const seatBase = myIndex>=0 ? myIndex : 0;
 for(let s=1;s<=4;s++){ const el=$(`player${s}`); if(el) el.innerHTML=''; }
 state.players.forEach((p,i)=>{
   const visual = (i - seatBase + 4) % 4; // 0=низ, 1=ліво, 2=верх, 3=право
   const el=$(`player${visual+1}`);
   if(el) el.innerHTML=playerHTML(p,i);
 });
 renderTrick();
 const me=state.players.find(p=>p.id===socket.id);const myTurn=state.turn===myIndex;
 let info='';
 if(state.phase==='lobby')info=`Очікуємо 4 гравців (${state.players.length}/4)`;
 else if(state.phase==='prebid')info=myTurn?'Темна: ваше замовлення до роздачі':'Темна: замовлення '+esc(state.players[state.turn]?.name||'');
 else if(state.phase==='bidding')info=myTurn?'Ваш хід — зробіть замовлення':'Хід: '+esc(state.players[state.turn]?.name||'');
 else if(state.phase==='playing')info=myTurn?'Ваш хід — виберіть карту':'Хід: '+esc(state.players[state.turn]?.name||'');
 else if(state.phase==='roundEnd')info='Раунд завершено';
 else if(state.phase==='gameEnd'){
   const sorted=[...state.players].sort((a,b)=>b.score-a.score);
   const top=sorted[0];
   const second=sorted[1];
   if(top){
     const gap=second!=null?(top.score-second.score):0;
     info=`🏆 Вітаємо, ${top.name}! Перемога з ${top.score} очками`+(gap>0?` (+${gap})`:'')+' 🎉';
   } else info='Партію завершено';
 }
 if(isSpectator() && state.phase!=='gameEnd'){
   info = (info?info+' · ':'') + '👁 Спостерігач';
 }
 $('info').textContent=info;
 renderActions(me,myTurn);renderHand();renderScore();
 const logEl=$('log');
 if(logEl){
   logEl.innerHTML=(state.log||[]).map(esc).join('<br>');
   logEl.scrollTop=logEl.scrollHeight;
 }
}
function phaseText(p){return({lobby:'Лобі',prebid:'Замовлення',bidding:'Замовлення',playing:'Гра',roundEnd:'Підсумок',gameEnd:'Фініш'})[p]||p}
function playerHTML(p,i){
  const inVoice=state.voiceOn&&state.voiceOn.some(v=>v.id===p.id);
  const isTurn=state.turn===i&&['bidding','prebid','playing'].includes(state.phase);
  const isDealer=i===state.dealer && state.phase!=='lobby';
  const offline=p.connected===false;
  const isHost=(state.hostId||state.players[0]?.id)===socket.id;
  let controls='';
  if(state.phase==='lobby'&&isHost&&p.id!==socket.id&&!p.bot)
    controls+=`<button class="danger mini-action" onclick="kickPlayer(${JSON.stringify(p.id)})">Викинути</button>`;
  const cards=p.cards??0;
  const bid=p.bid!==null&&p.bid!==undefined?p.bid:'—';
  const tricks=p.tricks??0;
  const jokers=p.jokers||0;
  const score=p.score??0;
  // 1) карти + джокери  2) замовлення + взятки  3) очки
  return `<div class="player-card ${isTurn?'active':''} ${isDealer?'is-dealer':''} ${offline?'offline':''}">
    <div class="player-name">${esc(p.name)}${p.bot?' 🤖':''}${inVoice?' 🎤':''}${offline?' · 📴':''}</div>
    <div class="player-stats">
      <div class="ps-row ps-bidline" title="Замовлено · Взято">
        <span class="ps-item"><span class="ps-label">зам.</span> <b>${bid}</b></span>
        <span class="ps-sep">/</span>
        <span class="ps-item"><span class="ps-label">вз.</span> <b>${tricks}</b></span>
      </div>
      <div class="ps-row" title="Джокери за гру">
        <span class="ps-item"><span class="ps-label">🃏</span> <b>${jokers}</b></span>
      </div>
      <div class="ps-row ps-score" title="Очки">
        <span class="ps-item"><span class="ps-label">очки</span> <b>${score}</b></span>
      </div>
    </div>
    ${controls?`<div class="player-controls">${controls}</div>`:''}
  </div>`;
}
function isSpectator(){
  if(!state) return false;
  if(state.spectator) return true;
  return !!(state.spectators&&state.spectators.some(s=>s.id===socket.id));
}
function updateTopbarExtras(){
  const kickBtn=$('kickVoteBtn');
  if(kickBtn){
    const show=!isSpectator() && ['prebid','bidding','playing','roundEnd'].includes(state&&state.phase);
    kickBtn.hidden=!show;
  }
  const badge=$('spectatorBadge');
  if(badge){
    badge.hidden=!isSpectator();
    if(isSpectator()){
      const myVoice=typeof voiceEnabled!=='undefined' && voiceEnabled;
      badge.textContent=myVoice?'👁 SuperAdmin 🎤':'👁 SuperAdmin';
    }
  }
}
function showVictoryOverlay(s){
  document.querySelectorAll('.victory-overlay').forEach(n=>n.remove());
  const players=(s&&s.players)||[];
  const sorted=[...players].sort((a,b)=>b.score-a.score);
  const top=sorted[0];
  if(!top) return;
  const second=sorted[1];
  const gap=second!=null?(top.score-second.score):0;
  const podium=sorted.slice(0,3).map((p,i)=>{
    const medal=['🥇','🥈','🥉'][i];
    return `<div class="victory-row">${medal} <b>${esc(p.name)}</b> — ${p.score}</div>`;
  }).join('');
  const ov=document.createElement('div');
  ov.className='victory-overlay modal';
  ov.innerHTML=`<div class="modalbox victory-box">
    <div class="victory-confetti" aria-hidden="true">🎉✨🏆✨🎉</div>
    <h2>Перемога!</h2>
    <p class="victory-name">🏆 ${esc(top.name)}</p>
    <p class="victory-score">${top.score} очок${gap>0?` · +${gap} до 2 місця`:''}</p>
    <div class="victory-podium">${podium}</div>
    <button type="button" class="primary-btn victory-close">Чудово!</button>
  </div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.querySelector('.victory-close').onclick=close;
  ov.onclick=e=>{ if(e.target===ov) close(); };
  setTimeout(close, 12000);
}
function renderActions(me,myTurn){
 let a='';
 updateTopbarExtras();
 if(isSpectator()){
   a+='<div class="spectator-hint">👁 Режим спостерігача (SuperAdmin) — ви бачите гру, але не берете участі</div>';
   $('actions').innerHTML=a;
   return;
 }
 const isHost=(state.hostId||state.players[0]?.id)===socket.id;
 if(state.phase==='lobby'&&isHost){
   // Головна кнопка — завжди зверху, добре видно на телефоні
   if(state.players.length===4){
     a+='<button class="primary-btn start-game-btn" type="button" onclick="start()">▶ Почати гру</button>';
   } else {
     a+=`<div class="lobby-wait-hint muted">Очікуємо гравців: ${state.players.length}/4 — потім з’явиться «Почати гру»</div>`;
   }
   if(state.players.length<4) a+='<button class="secondary" onclick="addBot()">+ Додати бота</button> ';
   a+=`<button class="secondary" onclick="setRoomPass()">${state.hasPassword?'🔓 Змінити пароль':'🔒 Пароль кімнати'}</button> `;
   const diff=state.botDifficulty||'medium';
   a+=`<div class="diff-picker"><span>Складність ботів:</span>
     <button type="button" class="secondary ${diff==='easy'?'diff-on':''}" onclick="setBotDiff('easy')">Легка</button>
     <button type="button" class="secondary ${diff==='medium'?'diff-on':''}" onclick="setBotDiff('medium')">Середня</button>
     <button type="button" class="secondary ${diff==='hard'?'diff-on':''}" onclick="setBotDiff('hard')">Складна</button>
   </div>`;
 }
 if(state.phase==='lobby'&&!isHost){
   const labels={easy:'Легка',medium:'Середня',hard:'Складна'};
   a+=`<div class="diff-picker muted">Боти: ${labels[state.botDifficulty||'medium']}</div>`;
   a+=`<div class="lobby-wait-hint muted">Очікуємо господаря… (${state.players.length}/4)</div>`;
 }
 // Статус голосування (кнопка — у шапці біля 🔊🎤🔄)
 if(['prebid','bidding','playing','roundEnd'].includes(state.phase)){
   const kv=state.kickVotes||{};
   const active=Object.entries(kv).filter(([,arr])=>arr&&arr.length);
   if(active.length){
     const humans=state.players.filter(p=>!p.bot).length;
     const needed=Math.floor(Math.max(1,humans-1)/2)+1;
     a+='<div class="kick-vote-status muted">'+active.map(([id,arr])=>{
       const pl=state.players.find(p=>p.id===id);
       return `проти ${esc(pl?pl.name:id)}: ${arr.length}/${needed}`;
     }).join(' · ')+'</div>';
   }
 }
 if((state.phase==='bidding'||state.phase==='prebid')&&myTurn && !isSpectator()){
   const n=state.round.cards;
   const othersSum=state.players.reduce((s,p)=>s+(p.bid??0),0);
   const isLast=state.players.filter(p=>p.bid!==null).length===3;
   const sumForbidden=isLast ? n - othersSum : null;
   const mePlayer=state.players.find(p=>p.id===socket.id);
   const blockZero=(mePlayer&&(mePlayer.zeroBidStreak||0)>=2);
   a+=`<div class="bid">${Array.from({length:n+1},(_,i)=>{
     let disabled=false, title='';
     if(sumForbidden!==null && i===sumForbidden){ disabled=true; title='Сума не може = '+n; }
     if(i===0 && blockZero){ disabled=true; title='Не можна замовляти 0 три рази підряд'; }
     return `<button onclick="bid(${i})" ${disabled?'disabled title="'+title+'"':''} style="${disabled?'opacity:.4;cursor:not-allowed':''}">${i}</button>`;
   }).join('')}</div>`;
 }
 if(state.phase==='roundEnd'&&isHost) a+='<button class="primary-btn" onclick="nextRound()">Наступний раунд</button>';
 if(state.phase==='gameEnd'&&isHost) a+='<button class="primary-btn" onclick="newGame()">Почати гру по новій</button> ';
 // «Вийти з кімнати» — лише в шапці (🚪), ніколи в #actions
 $('actions').innerHTML=a;
 // Порожня панель дій не займає місце і не перекриває модалки
 const bar=document.querySelector('.actions-bar');
 if(bar){
   const empty=!String(a||'').trim();
   bar.classList.toggle('is-empty', empty);
   bar.hidden=empty;
 }
 // Меню господаря — у шапці, не на столі
 const hostWrap=$('hostMenuWrap');
 if(hostWrap){
   hostWrap.hidden=!(isHost && state.phase!=='lobby');
 }
}
function closeHostMenu(){
  const m=$('hostMenu'); if(m) m.hidden=true;
}
document.addEventListener('click',(e)=>{
  const wrap=$('hostMenuWrap'); const menu=$('hostMenu'); const btn=$('hostMenuBtn');
  if(!wrap||!menu||!btn) return;
  if(btn.contains(e.target)){ menu.hidden=!menu.hidden; return; }
  if(!menu.hidden && !menu.contains(e.target)) menu.hidden=true;
});
function renderTrick(){
  const el=$('trick');
  if(!el||!state) return;
  // Якщо взятка очищена — прибираємо «привидів» анімації
  if(!state.trick.length) clearFxLayer(true);
  // На столі максимум 4 карти (захист від застарілого/битого стану)
  const shown=(state.trick||[]).slice(0,4);
  const prevIds=new Set([...el.querySelectorAll('.played')].map(n=>n.dataset.cid));
  el.innerHTML=shown.map((x,i)=>{
    const cid=x.card&&x.card.id?x.card.id:(x.card.rank+x.card.suit);
    const isNew=!prevIds.has(cid) && prevIds.size>0;
    const short=(state.players[x.player]?.name||'').slice(0,10);
    return `<div class="played ${isNew?'card-land':''}" data-cid="${esc(cid)}" style="--i:${i}">
      <div class="card ${red(x.card)?'red':''} ${x.card.joker?'joker':''}">${cardText(x.card)}</div>
      <small class="played-name">${esc(short)}</small>
    </div>`;
  }).join('');
  renderLastTrick();
}
function renderLastTrick(){
  const bar=$('lastTrickBar');
  const box=$('lastTrick');
  const winEl=$('lastTrickWinner');
  if(!bar||!box||!state) return;
  const lt=state.lastTrick||[];
  if(!lt.length || (state.phase!=='playing' && state.phase!=='roundEnd')){
    bar.hidden=true;
    box.innerHTML='';
    return;
  }
  bar.hidden=false;
  const wIdx=typeof state.lastTrickWinner==='number'?state.lastTrickWinner:lt.find(x=>x.winner)?.player;
  const wName=(typeof wIdx==='number' && state.players[wIdx])?state.players[wIdx].name:'';
  if(winEl) winEl.textContent=wName?`· забрав ${wName}`:'';
  box.innerHTML=lt.map(x=>{
    const short=(state.players[x.player]?.name||'').slice(0,8);
    const win=x.winner||x.player===wIdx;
    return `<div class="last-played ${win?'is-winner':''}">
      <div class="card mini ${red(x.card)?'red':''} ${x.card.joker?'joker':''}">${cardText(x.card)}</div>
      <small>${esc(short)}</small>
    </div>`;
  }).join('');
}

function renderHand(dealAnimate){
 if(!state)return;
 const handEl=$('hand');
 if(!handEl) return;
 if(isSpectator()){
   handEl.classList.remove('hand-fan');
   handEl.innerHTML='<div class="spectator-hand-msg">👁 Спостереження — карт на руці немає</div>';
   if($('handHint')) $('handHint').textContent='SuperAdmin';
   return;
 }
 const myTurn=state.turn===state.players.findIndex(p=>p.id===socket.id);
 const legal=state.phase==='playing'&&myTurn?legalIds():new Set();
 const token=++dealAnimToken;
 const n=hand.length;
 // Віяло: кут і зсув від центру
 const maxSpread = n<=3 ? 10 : n<=5 ? 14 : n<=7 ? 18 : 22; // градуси від краю до краю
 handEl.classList.toggle('hand-fan', n>0);
 handEl.innerHTML=hand.map((c,i)=>{
   const t = n<=1 ? 0 : (i/(n-1) - 0.5); // -0.5 … +0.5
   const angle = (t * maxSpread).toFixed(2);
   const y = (Math.abs(t) * (n<=4 ? 6 : 10)).toFixed(1); // краї трохи нижче
   const z = i + 1;
   const deal = dealAnimate ? `--deal-i:${i};` : '';
   return `<div class="card hand-card ${red(c)?'red':''} ${c.joker?'joker':''} ${!legal.has(c.id)?'disabled':''} ${dealAnimate?'deal-in':''}"
        style="${deal}--fan-angle:${angle}deg;--fan-y:${y}px;z-index:${z}"
        onclick='play(${JSON.stringify(c.id)})'>${cardText(c)}</div>`;
 }).join('');
 $('handHint').textContent=state.phase==='playing'&&myTurn?'Ваш хід':'';
 if(dealAnimate){
   animateDealBurst(hand.length);
   setTimeout(()=>{
     if(token!==dealAnimToken) return;
     document.querySelectorAll('#hand .deal-in').forEach(el=>el.classList.remove('deal-in'));
   }, 900);
 }
}

/* ===== Анімації ===== */
function seatEl(playerIndex){
  // DOM: player1=низ, player2=ліво, player3=верх, player4=право
  // Відносні місця: поточний гравець завжди знизу
  const myIndex=state&&state.players?state.players.findIndex(p=>p.id===socket.id):-1;
  const base=myIndex>=0?myIndex:0;
  const visual=(playerIndex-base+4)%4;
  return $(`player${visual+1}`);
}
function feltRect(){
  const felt=document.querySelector('.felt');
  return felt?felt.getBoundingClientRect():null;
}
function fxLayer(){ return $('fxLayer'); }
function clearFxLayer(soft){
  const layer=fxLayer();
  if(!layer) return;
  if(soft){
    // залишаємо короткі анімації забору взятки, але прибираємо «залиплі»
    [...layer.querySelectorAll('.fx-card')].forEach(n=>{
      if(!n.dataset.keep) n.remove();
    });
  } else {
    layer.innerHTML='';
  }
}
function removeFxSoon(fx, ms){
  if(!fx) return;
  setTimeout(()=>{
    try{
      fx.classList.add('fx-fade');
      setTimeout(()=>{ if(fx.parentNode) fx.remove(); }, 180);
    }catch(e){ try{ fx.remove(); }catch(_){} }
  }, ms);
}

function makeFxCard(card){
  const d=document.createElement('div');
  d.className=`card fx-card ${red(card)?'red':''} ${card.joker?'joker':''}`;
  d.innerHTML=cardText(card);
  d.setAttribute('aria-hidden','true');
  return d;
}

/** Карта летить з місця гравця в центр (хід). */
function animatePlayCard(playerIndex, card){
  const layer=fxLayer();
  const felt=feltRect();
  const seat=seatEl(playerIndex);
  if(!layer||!felt||!seat) return;
  // не копіюємо купу привидів
  if(layer.querySelectorAll('.fx-card').length>6) clearFxLayer();
  const sr=seat.getBoundingClientRect();
  const fx=makeFxCard(card);
  const startX=sr.left+sr.width/2-felt.left-28;
  const startY=sr.top+sr.height/2-felt.top-40;
  const endX=felt.width/2-28+(Math.random()*12-6);
  const endY=felt.height*0.42-20+(Math.random()*8-4);
  fx.style.left=startX+'px';
  fx.style.top=startY+'px';
  fx.style.opacity='0.95';
  layer.appendChild(fx);
  requestAnimationFrame(()=>{
    fx.style.transition='transform .32s cubic-bezier(.2,.8,.2,1), opacity .32s ease';
    fx.style.transform=`translate(${endX-startX}px, ${endY-startY}px) scale(1.02)`;
  });
  removeFxSoon(fx, 320);
}

/** Усі карти взятки летять до переможця. */
function animateTakeTrick(trick, winnerIndex){
  const layer=fxLayer();
  const felt=feltRect();
  const seat=seatEl(winnerIndex);
  if(!layer||!felt||!seat||!trick||!trick.length) return;
  clearFxLayer(); // чистий шар перед забором
  const sr=seat.getBoundingClientRect();
  const endX=sr.left+sr.width/2-felt.left-28;
  const endY=sr.top+sr.height/2-felt.top-40;
  const centerX=felt.width/2-28;
  const centerY=felt.height*0.42-20;
  seat.classList.add('winner-flash');
  setTimeout(()=>seat.classList.remove('winner-flash'), 700);

  trick.forEach((x,i)=>{
    const fx=makeFxCard(x.card);
    fx.dataset.keep='1';
    const ox=(i-1.5)*18;
    fx.style.left=(centerX+ox)+'px';
    fx.style.top=centerY+'px';
    fx.style.zIndex=String(10+i);
    layer.appendChild(fx);
    setTimeout(()=>{
      fx.style.transition=`transform .4s cubic-bezier(.25,.8,.25,1) ${i*35}ms, opacity .4s ease ${i*35}ms`;
      fx.style.transform=`translate(${endX-(centerX+ox)}px, ${endY-centerY}px) scale(.5) rotate(${(i-1.5)*10}deg)`;
      fx.style.opacity='0';
    }, 20);
    setTimeout(()=>{ if(fx.parentNode) fx.remove(); }, 520+i*35);
  });
  // гарантоване очищення
  setTimeout(()=>clearFxLayer(), 900);
}

/** Невеликий «віяло» карт з центру при роздачі. */
function animateDealBurst(count){
  const layer=fxLayer();
  const felt=feltRect();
  if(!layer||!felt||!count) return;
  const n=Math.min(count, 8);
  for(let i=0;i<n;i++){
    const fx=document.createElement('div');
    fx.className='card fx-card fx-back';
    fx.textContent='🂠';
    const cx=felt.width/2-28, cy=felt.height/2-40;
    fx.style.left=cx+'px';
    fx.style.top=cy+'px';
    layer.appendChild(fx);
    const ang=(-60+i*(120/Math.max(n-1,1)))*Math.PI/180;
    const dist=90+Math.random()*30;
    const dx=Math.cos(ang)*dist, dy=Math.sin(ang)*dist;
    setTimeout(()=>{
      fx.style.transition='transform .5s cubic-bezier(.2,.7,.2,1), opacity .5s ease';
      fx.style.transform=`translate(${dx}px, ${dy}px) rotate(${ang*40}deg) scale(.7)`;
      fx.style.opacity='0';
    }, 20+i*45);
    setTimeout(()=>fx.remove(), 600+i*45);
  }
}
function legalIds(){
 const jokers=hand.filter(c=>c.joker).map(c=>c.id);
 if(state.trick.length===0)return new Set(hand.map(c=>c.id));
 const lead=state.trick[0].card;
 if(lead.joker&&lead.status?.type==='trumpHigh'){
   const tr=hand.filter(c=>!c.joker&&state.trump&&c.suit===state.trump);
   if(tr.length){const mx=Math.max(...tr.map(c=>rankValue(c.rank)));return new Set(tr.filter(c=>rankValue(c.rank)===mx).map(c=>c.id).concat(jokers))}
   return new Set(hand.map(c=>c.id));
 }
 if(lead.joker&&lead.status?.type==='suit'){
   const suit=lead.status.suit;
   const same=hand.filter(c=>!c.joker&&c.suit===suit);
   if(same.length){
     const mx=Math.max(...same.map(c=>rankValue(c.rank)));
     return new Set(same.filter(c=>rankValue(c.rank)===mx).map(c=>c.id).concat(jokers));
   }
   const tr=hand.filter(c=>!c.joker&&state.trump&&c.suit===state.trump);
   if(tr.length)return new Set(tr.map(c=>c.id).concat(jokers));
   return new Set(hand.map(c=>c.id));
 }
 // «Віддати джокер»: масть будь-якого номіналу; якщо її немає — обов’язковий козир.
 if(lead.joker&&(lead.status?.type==='give'||lead.status?.type==='giveSuit')&&lead.status?.suit){
   const suit=lead.status.suit;
   const same=hand.filter(c=>!c.joker&&c.suit===suit);
   if(same.length)return new Set(same.map(c=>c.id).concat(jokers));
   const tr=hand.filter(c=>!c.joker&&state.trump&&c.suit===state.trump);
   if(tr.length)return new Set(tr.map(c=>c.id).concat(jokers));
   return new Set(hand.map(c=>c.id));
 }
 // «Віддати джокер» без масті (старі партії) — будь-яка карта
 if(lead.joker)return new Set(hand.map(c=>c.id));
 const same=hand.filter(c=>!c.joker&&c.suit===lead.suit);
 if(same.length)return new Set(same.map(c=>c.id).concat(jokers));
 // Немає масті заходу → зобов’язаний бити козирем, якщо є
 const tr=hand.filter(c=>!c.joker&&state.trump&&c.suit===state.trump);
 if(tr.length)return new Set(tr.map(c=>c.id).concat(jokers));
 return new Set(hand.map(c=>c.id));
}
function rankValue(r){return ['6','7','8','9','10','J','Q','K','A'].indexOf(r)}
function suitHtml(suit){
  if(!suit) return '';
  const cls = (suit==='♥'||suit==='♦') ? 'suit-red' : 'suit-black';
  return `<span class="${cls}">${suit}</span>`;
}
function cardText(c){
  if(!c.joker) return `${c.rank}${suitHtml(c.suit)}`;
  const s=c.status;
  if(s?.type==='trumpHigh') return '🃏<span class="joker-badge">♛</span>';
  if(s?.type==='suit') return `🃏<span class="joker-badge">↑</span>${suitHtml(s.suit)}`;
  if(s?.type==='take') return '🃏<span class="joker-badge">↑</span>';
  if(s?.type==='give'||s?.type==='giveSuit') return s.suit?`🃏<span class="joker-badge">↓</span>${suitHtml(s.suit)}`:'🃏<span class="joker-badge">↓</span>';
  if(s?.type==='asSuit') return `🃏${suitHtml(s.suit)}`;
  if(s?.type==='asCard') return `🃏${s.rank}${suitHtml(s.suit)}`;
  return '🃏';
}
function kickPlayer(targetId){
  if(!confirm('Викинути цього гравця з кімнати до початку гри?')) return;
  socket.emit('kickPlayer',{targetId},res=>{if(!res||!res.ok) alert(res&&res.error?res.error:'Не вдалося викинути гравця');});
}
function openKickVoteModal(){
  if(!state) return;
  const me=socket.id;
  const candidates=state.players.filter(p=>!p.bot && p.id!==me);
  if(!candidates.length){
    alert('Немає кандидатів для голосування.');
    return;
  }
  // Закрити попереднє модальне, якщо є
  document.querySelectorAll('.modal.kick-vote-modal').forEach(n=>n.remove());
  const kv=state.kickVotes||{};
  const humans=state.players.filter(p=>!p.bot).length;
  const needed=Math.floor(Math.max(1,humans-1)/2)+1;
  const m=document.createElement('div');
  m.className='modal kick-vote-modal';
  m.innerHTML=`<div class="modalbox">
    <h2>Мінус ПІДАР</h2>
    <p>Оберіть гравця. Для заміни ботом потрібна більшість голосів інших гравців (зараз ${needed}).</p>
    <div class="kick-candidate-list">
      ${candidates.map(p=>{
        const votes=(kv[p.id]||[]).length;
        const offline=p.connected===false?' · 📴':'';
        return `<button type="button" class="danger kick-cand" data-id="${esc(p.id)}" data-name="${esc(p.name)}">
          ${esc(p.name)}${offline}${votes?` · голосів: ${votes}/${needed}`:''}
        </button>`;
      }).join('')}
    </div>
    <button type="button" class="modal-cancel secondary">Скасувати</button>
  </div>`;
  document.body.appendChild(m);
  m.querySelector('.modal-cancel').onclick=()=>m.remove();
  m.onclick=e=>{ if(e.target===m) m.remove(); };
  m.querySelectorAll('.kick-cand').forEach(btn=>{
    btn.onclick=()=>{
      const targetId=btn.dataset.id;
      const name=btn.dataset.name;
      if(!confirm(`Віддати голос «Мінус ПІДАР» проти «${name}»?\nПотрібно ${needed} голос(ів) для заміни ботом.`)) return;
      m.remove();
      socket.emit('voteKick',{targetId},res=>{
        if(!res||!res.ok){
          alert(res&&res.error?res.error:'Не вдалося зарахувати голос');
          return;
        }
        if(res.removed) alert(`«${name}» замінено ботом після голосування.`);
        else alert(`Голос зараховано: ${res.votes}/${res.needed}.`);
      });
    };
  });
}
function voteKick(targetId,name){
  // сумісність зі старими викликами
  openKickVoteModal();
}
function bid(v){socket.emit('bid',{value:v})};
function start(){socket.emit('startGame')};
function nextRound(){socket.emit('startNextRound')};
function addBot(){socket.emit('addBot')};
function setBotDiff(level){socket.emit('setBotDifficulty',{level});}
function setRoomPass(){
  const cur=state&&state.hasPassword?'(зараз є пароль) ':'';
  const pwd=prompt(cur+'Новий пароль кімнати (порожньо = без пароля):');
  if(pwd==null) return;
  socket.emit('setRoomPassword',{password:pwd},res=>{
    if(!res||!res.ok) alert(res&&res.error?res.error:'Не вдалося змінити пароль');
  });
}
function newGame(){
  if(!confirm('Почати гру по новій? Поточний рахунок буде скинуто.')) return;
  socket.emit('newGame');
}
function endGame(){
  if(!confirm('Завершити поточну партію?')) return;
  socket.emit('endGame');
}
function leaveGame(){
  if(!confirm('Вийти з кімнати?')) return;
  socket.emit('leaveGame');
  clearSession();
  location.reload();
}
function reloadGame(){
  location.reload();
}
// Після згортання телефону сокет інколи «зависає» — перепідключаємо
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    try{
      if(socket && !socket.connected) socket.connect();
      else if(socket && socket.connected) socket.emit('requestHand');
    }catch(e){}
  }
});
window.addEventListener('pageshow',(ev)=>{
  if(ev.persisted){
    try{ if(socket && !socket.connected) socket.connect(); }catch(e){}
  }
});
function play(id){
 const c=hand.find(x=>x.id===id);if(!c)return;if(!legalIds().has(id))return;
 if(c.joker)return jokerDialog();
 cardSound();
 socket.emit('play',{cardId:id});
}
function closeModal(m){ if(m&&m.parentNode) m.remove(); }
function suitPickerHtml(){
  return `<div class="suit-picker">
    <button type="button" class="suit-btn suit-black" data-suit="♠">♠</button>
    <button type="button" class="suit-btn suit-red" data-suit="♥">♥</button>
    <button type="button" class="suit-btn suit-red" data-suit="♦">♦</button>
    <button type="button" class="suit-btn suit-black" data-suit="♣">♣</button>
  </div>`;
}
function rankPickerHtml(){
  return `<div class="rank-picker">
    ${['6','7','8','9','10','J','Q','K','A'].map(r=>`<button type="button" class="rank-btn" data-rank="${r}">${r}</button>`).join('')}
  </div>`;
}
function jokerDialog(){
  const isLead=!state.trick.length;
  const hasTrump=!!state.trump;
  let opts='';
  if(isLead){
    if(hasTrump) opts+='<button data-t="trumpHigh">По старших козирях</button>';
    opts+='<button data-t="suit">По старших (масть)</button>';
    opts+='<button data-t="give">Віддати джокер</button>';
  } else {
    opts+='<button data-t="take">Забрати взятку</button>';
    opts+='<button data-t="give">Віддати джокер</button>';
    opts+='<button data-t="asSuit">Скинути як масть</button>';
    opts+='<button data-t="asCard">Скинути як карту</button>';
  }
  const m=document.createElement('div');m.className='modal';
  m.innerHTML=`<div class="modalbox"><h2>Джокер</h2><p>${isLead?'Заявіть, як ходите джокером:':'Джокер можна класти завжди — оберіть дію:'}</p><div class="joker-options">${opts}</div><div class="joker-extra"></div><button type="button" class="modal-cancel">Скасувати</button></div>`;
  document.body.appendChild(m);
  const extra=m.querySelector('.joker-extra');
  m.querySelector('.modal-cancel').onclick=()=>closeModal(m);
  m.onclick=e=>{
    if(e.target===m) closeModal(m);
    const t=e.target.dataset.t; if(!t) return;
    // Дії без додаткового вибору (give з заходу — НІ, потрібна масть)
    if(t==='trumpHigh'||t==='take'||(t==='give'&&!isLead)){
      cardSound();
      socket.emit('play',{cardId:'JOKER',status:{type:t}});
      closeModal(m);
      return;
    }
    // Захід «Віддати джокер» — обов’язково вказати масть
    if(t==='give'&&isLead){
      extra.innerHTML=`<p class="picker-title">За яку масть віддаєте (масть обов’язкова; якщо її немає — козир, а якщо немає й козиря — будь-яка карта):</p>${suitPickerHtml()}`;
      extra.querySelectorAll('.suit-btn').forEach(btn=>{
        btn.onclick=()=>{
          cardSound();
          socket.emit('play',{cardId:'JOKER',status:{type:'give',suit:btn.dataset.suit}});
          closeModal(m);
        };
      });
      return;
    }
    // Вибір масті
    if(t==='suit'||t==='asSuit'){
      const title = t==='suit' ? 'Оберіть масть (постаршій):' : 'Оберіть масть:';
      extra.innerHTML=`<p class="picker-title">${title}</p>${suitPickerHtml()}`;
      extra.querySelectorAll('.suit-btn').forEach(btn=>{
        btn.onclick=()=>{
          const suit=btn.dataset.suit;
          const type = t==='suit'?'suit':'asSuit';
          cardSound();
          socket.emit('play',{cardId:'JOKER',status:{type,suit}});
          closeModal(m);
        };
      });
      return;
    }
    // Вибір карти (ранг + масть)
    if(t==='asCard'){
      let chosenRank=null;
      extra.innerHTML=`<p class="picker-title">Оберіть ранг:</p>${rankPickerHtml()}<div class="suit-step" style="display:none"><p class="picker-title">Оберіть масть:</p>${suitPickerHtml()}</div>`;
      extra.querySelectorAll('.rank-btn').forEach(btn=>{
        btn.onclick=()=>{
          chosenRank=btn.dataset.rank;
          extra.querySelectorAll('.rank-btn').forEach(b=>b.classList.remove('selected'));
          btn.classList.add('selected');
          extra.querySelector('.suit-step').style.display='block';
        };
      });
      extra.querySelectorAll('.suit-btn').forEach(btn=>{
        btn.onclick=()=>{
          if(!chosenRank) return;
          cardSound();
          socket.emit('play',{cardId:'JOKER',status:{type:'asCard',rank:chosenRank,suit:btn.dataset.suit}});
          closeModal(m);
        };
      });
    }
  };
}
function renderScore(){
 const hist=state.scoreHistory||[];
 let h='<div class="score-scroll"><table class="score-table"><thead><tr><th>Раунд</th>'+state.players.map(p=>`<th>${esc(p.name)}</th>`).join('')+'</tr></thead><tbody>';
 hist.forEach(row=>{
   h+=`<tr><td>${esc(row.round)}</td>`+row.scores.map(x=>{
     const deltaCls=x.delta>0?'pos':x.delta<0?'neg':'';
     const deltaTxt=(x.delta>0?'+':'')+x.delta;
     // Замовлення / взятки (для Золотої/Мізера bid може бути null)
     let order='';
     if(x.bid!=null){
       const ok=x.bid===x.tricks;
       order=`<div class="score-order ${ok?'order-ok':'order-miss'}" title="Замовлено / взято">${x.bid}→${x.tricks??0}</div>`;
     } else if(x.tricks!=null){
       order=`<div class="score-order" title="Взято">${x.tricks} вз.</div>`;
     }
     return `<td class="${deltaCls}"><div class="score-delta">${deltaTxt}</div>${order}</td>`;
   }).join('')+'</tr>';
 });
 h+='<tr class="total"><td>Разом</td>'+state.players.map(p=>`<td>${p.score}</td>`).join('')+'</tr>';
 h+='<tr class="jokers-row"><td>🃏 Джокери</td>'+state.players.map(p=>`<td>${p.jokers||0}</td>`).join('')+'</tr>';
 h+='</tbody></table></div>';
 $('score').innerHTML=h;
}
function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}



// ========== EMOJI REACTIONS ==========
const EMOJI_SET=[
  '😀','😂','🤣','😊','😍','🤩','😎','🤔','😏','🙄',
  '😴','😮','😱','😢','😭','😡','🤬','🤡','👻','💀',
  '👍','👎','👏','🙏','💪','✌️','🤞','👋','👀','❤️',
  '🔥','⭐','🎉','💯','🃏','♠️','♥️','♦️','♣️','🍺',
  '☕','🍕','🏆','🎯','💣','🚀','✨','😈','🥳','😇'
];
let emojiPickerOpen=false;
let lastEmojiSent=0;
const recentLocalEmoji=new Set(); // щоб не дублювати локальний показ після broadcast

function openEmojiPicker(){
  if(emojiPickerOpen){ closeEmojiPicker(); return; }
  closeEmojiPicker(); // прибрати будь-які «привиди»
  const m=document.createElement('div');
  m.className='modal emoji-picker-modal';
  m.setAttribute('role','dialog');
  m.innerHTML=`<div class="modalbox emoji-picker-box">
    <h2>Реакція</h2>
    <div class="emoji-grid">${EMOJI_SET.map(e=>`<button type="button" class="emoji-pick" data-emoji="${e}">${e}</button>`).join('')}</div>
    <button type="button" class="modal-cancel secondary">Скасувати</button>
  </div>`;
  document.body.appendChild(m);
  document.body.classList.add('emoji-picker-open');
  emojiPickerOpen=true;
  const close=()=>closeEmojiPicker();
  m.querySelector('.modal-cancel').onclick=close;
  m.addEventListener('click',e=>{ if(e.target===m) close(); });
  m.querySelectorAll('.emoji-pick').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.preventDefault();
      e.stopPropagation();
      const emoji=btn.getAttribute('data-emoji');
      closeEmojiPicker();
      sendEmojiReaction(emoji);
    });
  });
}
function closeEmojiPicker(){
  document.querySelectorAll('.modal.emoji-picker-modal').forEach(n=>n.remove());
  document.body.classList.remove('emoji-picker-open');
  emojiPickerOpen=false;
}
function sendEmojiReaction(emoji){
  if(!emoji || !socket) return;
  const now=Date.now();
  if(now-lastEmojiSent<800) return;
  lastEmojiSent=now;
  const key=socket.id+'|'+emoji+'|'+Math.floor(now/500);
  recentLocalEmoji.add(key);
  setTimeout(()=>recentLocalEmoji.delete(key), 1200);
  socket.emit('emojiReaction',{emoji});
  const myIndex=state&&state.players?state.players.findIndex(p=>p.id===socket.id):-1;
  showEmojiOnPlayer(myIndex>=0?myIndex:null, emoji, socket.id);
}
function showEmojiOnPlayer(playerIndex, emoji, playerId){
  let seat=null;
  if(typeof playerIndex==='number' && playerIndex>=0) seat=seatEl(playerIndex);
  if(!seat && playerId && state&&state.players){
    const idx=state.players.findIndex(p=>p.id===playerId);
    if(idx>=0) seat=seatEl(idx);
  }
  const anchor=seat || document.querySelector('.felt') || document.body;
  const rect=anchor.getBoundingClientRect();
  const x=rect.left + rect.width/2;
  const y=rect.top + Math.max(12, rect.height*0.15);
  // 1 головний + 2 маленькі «іскри» збоку для жвавості
  const parts=[
    {dx:0, dy:0, scale:1, delay:0},
    {dx:-28, dy:6, scale:0.55, delay:80},
    {dx:28, dy:10, scale:0.5, delay:140}
  ];
  parts.forEach((p,i)=>{
    const bubble=document.createElement('div');
    bubble.className='emoji-reaction-float'+(i>0?' emoji-reaction-side':'');
    bubble.textContent=emoji;
    bubble.setAttribute('aria-hidden','true');
    bubble.style.left=(x+p.dx)+'px';
    bubble.style.top=(y+p.dy)+'px';
    bubble.style.setProperty('--side-scale', String(p.scale));
    document.body.appendChild(bubble);
    setTimeout(()=>{
      void bubble.offsetWidth;
      bubble.classList.add('emoji-reaction-play');
    }, p.delay);
    setTimeout(()=>{ if(bubble.parentNode) bubble.remove(); }, 3200+p.delay);
  });
}
socket.on('emojiReaction',({emoji,playerIndex,playerId})=>{
  if(!emoji) return;
  // не дублювати, якщо щойно показали локально
  if(playerId && playerId===socket.id){
    const key=playerId+'|'+emoji+'|'+Math.floor(Date.now()/500);
    if(recentLocalEmoji.has(key) || [...recentLocalEmoji].some(k=>k.startsWith(playerId+'|'+emoji))) return;
  }
  showEmojiOnPlayer(
    typeof playerIndex==='number'?playerIndex:null,
    emoji,
    playerId
  );
});

// ========== VOICE CHAT (WebRTC mesh) ==========
// Mesh 1:1 між усіма з увімкненим мікрофоном.
// Тільки сторона з меншим socket.id надсилає offer (без glare).
// STUN + кілька TURN для мобільних мереж.
let localStream=null;
let voiceEnabled=false;
let voiceConnectTimer=null;
let voiceHealthTimer=null;
const peers=new Map(); // peerId -> {pc, pendingIce, restartAttempts}
const pendingSignals=[];
let lastVoicePeerKey='';

const ICE={
  iceServers:[
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'},
    {urls:'stun:stun2.l.google.com:19302'},
    {urls:'stun:stun3.l.google.com:19302'},
    {urls:'stun:stun4.l.google.com:19302'},
    {urls:'stun:stun.cloudflare.com:3478'},
    // Metered free open relay (UDP/TCP/TLS)
    {
      urls:[
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443'
      ],
      username:'openrelayproject',
      credential:'openrelayproject'
    },
    {
      urls:[
        'turn:a.relay.metered.ca:80',
        'turn:a.relay.metered.ca:443',
        'turn:a.relay.metered.ca:443?transport=tcp',
        'turns:a.relay.metered.ca:443',
        'turn:b.relay.metered.ca:80',
        'turn:b.relay.metered.ca:443?transport=tcp'
      ],
      username:'openrelayproject',
      credential:'openrelayproject'
    },
    {
      urls:[
        'turn:relay1.expressturn.com:3478',
        'turn:relay1.expressturn.com:3478?transport=tcp',
        'turns:relay1.expressturn.com:443'
      ],
      username:'efree',
      credential:'efree'
    }
  ],
  iceCandidatePoolSize:4,
  iceTransportPolicy:'all',
  bundlePolicy:'max-bundle',
  rtcpMuxPolicy:'require'
};

function updateVoiceUI(){
  const btn=$('voiceBtn');
  const st=$('voiceStatus');
  if(!btn) return;
  btn.classList.toggle('on',voiceEnabled);
  btn.textContent=voiceEnabled?'🎤 Увімкнено':'🎤';
  const others=(state&&state.voiceOn)?state.voiceOn.filter(v=>v.id!==socket.id):[];
  if(st){
    if(!voiceEnabled) st.textContent='';
    else if(!others.length) st.textContent='Чекаємо інших…';
    else {
      const live=[...peers.entries()].filter(([id,e])=>isPeerLive(e)).length;
      st.textContent='🔊 '+others.map(v=>v.name).join(', ')+` · ${live}/${others.length}`;
    }
  }
}
function isPeerLive(entry){
  if(!entry||!entry.pc) return false;
  const cs=entry.pc.connectionState;
  const ice=entry.pc.iceConnectionState;
  return cs==='connected'||ice==='connected'||ice==='completed';
}
function getMediaStream(constraints){
  if(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia==='function'){
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  const legacy=navigator.getUserMedia||navigator.webkitGetUserMedia||navigator.mozGetUserMedia||navigator.msGetUserMedia;
  if(legacy) return new Promise((resolve,reject)=>legacy.call(navigator,constraints,resolve,reject));
  return Promise.reject(new Error('NO_MEDIA_DEVICES'));
}
function clearAllPeers(){
  for(const [id,entry] of peers){
    try{ entry.pc.close(); }catch(e){}
    removeRemoteAudio(id);
  }
  peers.clear();
  lastVoicePeerKey='';
}
function scheduleConnectAll(){
  if(voiceConnectTimer) clearTimeout(voiceConnectTimer);
  voiceConnectTimer=setTimeout(()=>{
    voiceConnectTimer=null;
    connectAllVoicePeers();
  }, 200);
}
function voicePeerKey(){
  const list=(state&&state.voiceOn)||[];
  return list.map(v=>v.id).filter(Boolean).sort().join('|');
}
function connectAllVoicePeers(){
  if(!voiceEnabled || !localStream || !state) return;
  const list=(state.voiceOn||[]).filter(v=>v && v.id && v.id!==socket.id);
  const alive=new Set(list.map(v=>v.id));
  for(const id of [...peers.keys()]){
    if(!alive.has(id)){
      const entry=peers.get(id);
      try{ entry.pc.close(); }catch(e){}
      peers.delete(id);
      removeRemoteAudio(id);
    }
  }
  for(const v of list) ensurePeer(v.id);
  lastVoicePeerKey=voicePeerKey();
  updateVoiceUI();
}
function startVoiceHealth(){
  stopVoiceHealth();
  voiceHealthTimer=setInterval(()=>{
    if(!voiceEnabled || !localStream) return;
    const list=(state&&state.voiceOn)||[];
    for(const v of list){
      if(!v.id || v.id===socket.id) continue;
      const entry=peers.get(v.id);
      if(!entry){ ensurePeer(v.id); continue; }
      const cs=entry.pc.connectionState;
      const ice=entry.pc.iceConnectionState;
      if(cs==='failed' || ice==='failed'){
        if((entry.restartAttempts||0)<5){
          entry.restartAttempts=(entry.restartAttempts||0)+1;
          recreatePeer(v.id);
        }
      } else if(cs==='disconnected' || ice==='disconnected'){
        // коротка пауза — спробуємо ICE restart лише з боку offerer
        if(String(socket.id)<String(v.id) && (entry.restartAttempts||0)<5){
          entry.restartAttempts=(entry.restartAttempts||0)+1;
          restartIce(v.id).catch(()=>{});
        }
      } else if(cs==='connected' || ice==='connected' || ice==='completed'){
        entry.restartAttempts=0;
      }
    }
    document.querySelectorAll('#remoteAudios audio, audio[id^="audio-"]').forEach(a=>{
      if(a.paused) a.play().catch(()=>{});
    });
    updateVoiceUI();
  }, 3500);
}
function stopVoiceHealth(){
  if(voiceHealthTimer){ clearInterval(voiceHealthTimer); voiceHealthTimer=null; }
}

async function enableVoice(){
  const isSecure=window.isSecureContext===true || location.protocol==='https:' ||
    location.hostname==='localhost' || location.hostname==='127.0.0.1' || location.hostname==='[::1]';
  if(!isSecure){
    alert('Мікрофон потребує HTTPS.\nВідкрийте гру через https://…\nЗараз: '+location.origin);
    return;
  }
  try{
    if(localStream){
      localStream.getTracks().forEach(t=>t.stop());
      localStream=null;
    }
    localStream=await getMediaStream({
      audio:{
        echoCancellation:true,
        noiseSuppression:true,
        autoGainControl:true,
        channelCount:1
      },
      video:false
    });
    try{
      const silent=new Audio();
      silent.src='data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      await silent.play().catch(()=>{});
    }catch(e){}

    voiceEnabled=true;
    socket.emit('voiceToggle',{on:true});
    const queued=pendingSignals.splice(0, pendingSignals.length);
    connectAllVoicePeers();
    socket.emit('voiceSync');
    for(const sig of queued){
      try{ await handleRtcSignal(sig.from, sig.data); }catch(e){}
    }
    startVoiceHealth();
    updateVoiceUI();
  }catch(e){
    let msg=e&&e.message?String(e.message):String(e);
    if(e.name==='NotAllowedError'||e.name==='PermissionDeniedError'){
      msg='Доступ до мікрофона заборонено.\nУ налаштуваннях браузера дозвольте мікрофон для цього сайту.';
    } else if(e.name==='NotFoundError'||e.name==='DevicesNotFoundError'){
      msg='Мікрофон не знайдено.';
    } else if(msg==='NO_MEDIA_DEVICES'||/mediaDevices|getUserMedia/i.test(msg)){
      msg='Браузер блокує мікрофон. Потрібен HTTPS.\nАдреса: '+location.origin;
    }
    alert('Не вдалося увімкнути мікрофон:\n'+msg);
    voiceEnabled=false;
    updateVoiceUI();
  }
}
function disableVoice(){
  voiceEnabled=false;
  stopVoiceHealth();
  try{ socket.emit('voiceToggle',{on:false}); }catch(e){}
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  clearAllPeers();
  pendingSignals.length=0;
  updateVoiceUI();
}
if($('voiceBtn')) $('voiceBtn').onclick=()=>{ if(voiceEnabled) disableVoice(); else enableVoice(); };

async function flushIce(peerId){
  const entry=peers.get(peerId);
  if(!entry||!entry.pc.remoteDescription) return;
  const q=entry.pendingIce.splice(0, entry.pendingIce.length);
  for(const c of q){
    try{ await entry.pc.addIceCandidate(c); }catch(e){}
  }
}
function removeRemoteAudio(peerId){
  const a=document.getElementById('audio-'+peerId);
  if(a){
    try{ a.srcObject=null; }catch(e){}
    a.remove();
  }
}
function attachRemoteTrack(peerId, e){
  const stream=e.streams&&e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
  let audio=document.getElementById('audio-'+peerId);
  if(!audio){
    audio=document.createElement('audio');
    audio.id='audio-'+peerId;
    audio.autoplay=true;
    audio.playsInline=true;
    audio.setAttribute('playsinline','');
    audio.setAttribute('webkit-playsinline','');
    audio.controls=false;
    audio.volume=1.0;
    audio.muted=false;
    const box=$('remoteAudios');
    if(box) box.appendChild(audio);
    else document.body.appendChild(audio);
  }
  audio.srcObject=stream;
  audio.muted=false;
  const tryPlay=()=>audio.play().catch(()=>{});
  tryPlay();
  setTimeout(tryPlay, 150);
  setTimeout(tryPlay, 600);
  setTimeout(tryPlay, 1500);
  e.track.onunmute=tryPlay;
}

function recreatePeer(peerId){
  const old=peers.get(peerId);
  if(old){
    try{ old.pc.close(); }catch(e){}
    peers.delete(peerId);
  }
  removeRemoteAudio(peerId);
  ensurePeer(peerId);
}

function ensurePeer(peerId){
  if(!peerId || peerId===socket.id || !voiceEnabled || !localStream) return null;
  if(peers.has(peerId)) return peers.get(peerId).pc;

  const iAmOfferer = String(socket.id) < String(peerId);
  const pc=new RTCPeerConnection(ICE);
  const entry={pc, pendingIce:[], restartAttempts:0, iAmOfferer};
  peers.set(peerId, entry);

  // Локальний мікрофон
  for(const t of localStream.getTracks()){
    try{ pc.addTrack(t, localStream); }catch(err){}
  }

  pc.onicecandidate=e=>{
    // null candidate = end-of-candidates — теж надсилаємо
    socket.emit('rtcSignal',{to:peerId,data:{type:'ice',candidate:e.candidate||null}});
  };

  pc.ontrack=e=> attachRemoteTrack(peerId, e);

  pc.onconnectionstatechange=()=>{
    updateVoiceUI();
    const st=pc.connectionState;
    if(st==='failed'){
      if((entry.restartAttempts||0)<4){
        entry.restartAttempts=(entry.restartAttempts||0)+1;
        setTimeout(()=>recreatePeer(peerId), 500+Math.random()*700);
      }
    }
    if(st==='closed'){
      peers.delete(peerId);
      removeRemoteAudio(peerId);
      updateVoiceUI();
    }
  };

  pc.oniceconnectionstatechange=()=>{
    updateVoiceUI();
  };

  // Лише offerer створює offer (немає зіткнення offer/offer)
  if(iAmOfferer){
    (async ()=>{
      try{
        const offer=await pc.createOffer({offerToReceiveAudio:true, offerToReceiveVideo:false});
        await pc.setLocalDescription(offer);
        socket.emit('rtcSignal',{to:peerId,data:{type:'offer',sdp:pc.localDescription}});
      }catch(err){
        console.error('voice offer',err);
      }
    })();
  }

  return pc;
}

async function restartIce(peerId){
  const entry=peers.get(peerId);
  if(!entry||!voiceEnabled||!entry.iAmOfferer) return;
  const pc=entry.pc;
  try{
    const offer=await pc.createOffer({iceRestart:true, offerToReceiveAudio:true});
    await pc.setLocalDescription(offer);
    socket.emit('rtcSignal',{to:peerId,data:{type:'offer',sdp:pc.localDescription}});
  }catch(e){
    console.error('ice restart',e);
  }
}

async function handleRtcSignal(from, data){
  if(!data || from===socket.id) return;
  if(!voiceEnabled || !localStream){
    pendingSignals.push({from,data});
    if(pendingSignals.length>50) pendingSignals.splice(0, pendingSignals.length-50);
    return;
  }

  let entry=peers.get(from);
  if(!entry){
    ensurePeer(from);
    entry=peers.get(from);
  }
  if(!entry) return;
  const pc=entry.pc;

  try{
    if(data.type==='offer'){
      // Answerer завжди приймає offer
      if(pc.signalingState!=='stable' && pc.signalingState!=='have-remote-offer'){
        // якщо ми offerer і вже маємо local offer — це несподівано; пересоздаємо як answerer path
        try{ await pc.setLocalDescription({type:'rollback'}); }catch(e){}
      }
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await flushIce(from);
      const answer=await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('rtcSignal',{to:from,data:{type:'answer',sdp:pc.localDescription}});
    } else if(data.type==='answer'){
      if(pc.signalingState==='have-local-offer'){
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await flushIce(from);
      }
    } else if(data.type==='ice'){
      const cand=data.candidate;
      if(!pc.remoteDescription){
        if(cand) entry.pendingIce.push(cand);
      } else {
        try{
          await pc.addIceCandidate(cand ? new RTCIceCandidate(cand) : null);
        }catch(e){
          console.warn('ice add',e);
        }
      }
    }
  }catch(err){
    console.error('handleRtcSignal', err);
    // якщо signaling зламався — повне пересоздання
    if((entry.restartAttempts||0)<4){
      entry.restartAttempts=(entry.restartAttempts||0)+1;
      setTimeout(()=>recreatePeer(from), 400);
    }
  }
}

socket.on('voicePeer',({id,on,name})=>{
  if(id===socket.id) return;
  if(on && voiceEnabled){
    ensurePeer(id);
  } else if(!on){
    const entry=peers.get(id);
    if(entry){ try{entry.pc.close()}catch(e){} peers.delete(id); }
    removeRemoteAudio(id);
  }
  updateVoiceUI();
});

socket.on('voiceSync',({list})=>{
  if(!voiceEnabled || !Array.isArray(list)) return;
  // оновити локальне уявлення хто в ефірі (на випадок, якщо state ще старий)
  if(state){
    const mine=state.voiceOn||[];
    const map=new Map(mine.map(v=>[v.id,v]));
    for(const v of list) if(v&&v.id) map.set(v.id,{id:v.id,name:v.name});
    // не затираємо повністю — connectAll бере state.voiceOn
  }
  for(const v of list){
    if(v.id && v.id!==socket.id) ensurePeer(v.id);
  }
  updateVoiceUI();
});

socket.on('rtcSignal',async ({from,data})=>{
  try{ await handleRtcSignal(from, data); }
  catch(e){ console.error('rtc signal',e); }
});

// Стан кімнати: підключаємо peer лише коли змінився склад voiceOn
const _voicePrevRender=render;
render=function(){
  _voicePrevRender();
  updateVoiceUI();
  if(voiceEnabled){
    const key=voicePeerKey();
    if(key!==lastVoicePeerKey) scheduleConnectAll();
  }
};

socket.on('connect',()=>{
  if(!voiceEnabled || !localStream) return;
  clearAllPeers();
  socket.emit('voiceToggle',{on:true});
  setTimeout(()=>{
    connectAllVoicePeers();
    socket.emit('voiceSync');
  }, 400);
});

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState!=='visible' || !voiceEnabled) return;
  document.querySelectorAll('#remoteAudios audio, audio[id^="audio-"]').forEach(a=>{
    try{ a.play().catch(()=>{}); }catch(e){}
  });
  scheduleConnectAll();
});
