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
  // Кінець партії — коротка «перемога»
  gameEnd(){
    [523,659,784,1046].forEach((f,i)=>tone({freq:f,type:'sine',dur:.22,vol:.09,delay:i*.11}));
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
function saveSession(code,token){try{sessionStorage.setItem(SS_KEY,JSON.stringify({code,token}))}catch(e){}}
function loadSession(){try{return JSON.parse(sessionStorage.getItem(SS_KEY)||'null')}catch(e){return null}}
function clearSession(){try{sessionStorage.removeItem(SS_KEY)}catch(e){}}
$('create').onclick=()=>socket.emit('createRoom',{name:$('name').value},res=>{
  if(!res.ok) return err(res.error);
  saveSession(res.code,res.token); enter(res.code);
});
$('join').onclick=()=>socket.emit('joinRoom',{name:$('name').value,code:$('code').value},res=>{
  if(!res.ok) return err(res.error);
  saveSession(res.code,res.token); enter(res.code);
});
function err(x){$('err').textContent=x||''}
function enter(code){$('lobby').hidden=true;$('game').hidden=false;$('room').textContent='Кімната '+code}
let prevState=null;
let dealAnimToken=0;
let handAnimPending=false;

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
    else if(s.phase==='gameEnd') SFX.gameEnd();
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
  state=s; lastTrickKey=key; render();
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
// Авто-перепідключення після оновлення / закриття вкладки
(function tryReconnect(){
  const s=loadSession();
  if(!s||!s.code||!s.token) return;
  socket.emit('reconnectRoom',{code:s.code,token:s.token},res=>{
    if(res&&res.ok){enter(res.code); if(res.name)$('name').value=res.name;}
    else clearSession();
  });
})();
function render(){
 if(!state)return;
 const r=state.round;
 $('round').textContent=`Раунд ${r.name}`;
 (function renderTrump(){
   const el=$('trump'); if(!el) return;
   const tc=state.trumpCard;
   if(tc && !tc.joker && state.trump){
     const isRed=tc.suit==='♥'||tc.suit==='♦';
     el.innerHTML=`<div class="trump-badge" title="Козирна карта (не хід)">
       <span class="trump-badge-title">КОЗИР</span>
       <span class="trump-badge-card ${isRed?'red':''}"><b>${esc(tc.rank)}</b>${tc.suit}</span>
     </div>`;
   } else if(tc && tc.joker){
     el.innerHTML=`<div class="trump-badge trump-none" title="Відкрився джокер">
       <span class="trump-badge-title">БЕЗ КОЗИРЯ</span>
       <span class="trump-badge-card">🃏</span>
     </div>`;
   } else if(state.trump){
     const isRed=state.trump==='♥'||state.trump==='♦';
     el.innerHTML=`<div class="trump-badge" title="Козир">
       <span class="trump-badge-title">КОЗИР</span>
       <span class="trump-badge-card ${isRed?'red':''}">${state.trump}</span>
     </div>`;
   } else {
     el.innerHTML=`<div class="trump-badge trump-none"><span class="trump-badge-title">БЕЗ КОЗИРЯ</span></div>`;
   }
 })();
 state.players.forEach((p,i)=>{const el=$(`player${i+1}`);el.innerHTML=playerHTML(p,i);});
 renderTrick();
 const me=state.players.find(p=>p.id===socket.id);const myIndex=state.players.findIndex(p=>p.id===socket.id);const myTurn=state.turn===myIndex;
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
  const bidLine=p.bid!==null?` · зам.<b>${p.bid}</b>`:'';
  return `<div class="player-card ${isTurn?'active':''} ${isDealer?'is-dealer':''}">
    <div class="player-name">${esc(p.name)}${p.bot?' 🤖':''}${inVoice?' 🎤':''}</div>
    <div class="player-meta">${p.cards}карт · ${p.tricks}вз.${bidLine}</div>
    <div class="player-meta">очки <b>${p.score}</b>${(p.jokers||0)>0?` · 🃏${p.jokers}`:''}</div>
  </div>`;
}
function renderActions(me,myTurn){
 let a='';
 const isHost=state.players[0]?.id===socket.id;
 if(state.phase==='lobby'&&isHost){
   if(state.players.length<4) a+='<button class="secondary" onclick="addBot()">+ Додати бота</button> ';
   if(!state.publicUrl) a+='<button class="secondary" onclick="shareLink()">🌐 Публічне посилання</button> ';
   else a+='<button class="secondary" onclick="copyPublicUrl()">📋 Копіювати</button> <button class="secondary" onclick="closeLink()">✖ Тунель</button> ';
   const diff=state.botDifficulty||'medium';
   a+=`<div class="diff-picker"><span>Складність ботів:</span>
     <button type="button" class="secondary ${diff==='easy'?'diff-on':''}" onclick="setBotDiff('easy')">Легка</button>
     <button type="button" class="secondary ${diff==='medium'?'diff-on':''}" onclick="setBotDiff('medium')">Середня</button>
     <button type="button" class="secondary ${diff==='hard'?'diff-on':''}" onclick="setBotDiff('hard')">Складна</button>
   </div>`;
   if(state.players.length===4) a+='<button onclick="start()">Почати гру</button>';
 }
 if(state.phase==='lobby'&&!isHost){
   const labels={easy:'Легка',medium:'Середня',hard:'Складна'};
   a+=`<div class="diff-picker muted">Боти: ${labels[state.botDifficulty||'medium']}</div>`;
 }
 if((state.phase==='bidding'||state.phase==='prebid')&&myTurn){
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
 if(state.phase==='gameEnd'){
   if(isHost) a+='<button class="primary-btn" onclick="newGame()">Почати гру по новій</button> ';
   a+='<button class="secondary" onclick="leaveGame()">Вийти з гри</button>';
 }
 if(state.publicUrl && state.phase==='lobby'){
   a+=`<div class="public-url">🌐 <a href="${esc(state.publicUrl)}" target="_blank" rel="noopener">${esc(state.publicUrl)}</a></div>`;
 }
 $('actions').innerHTML=a;
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
function shareLink(){
  const btn=document.querySelector('#actions');
  if(btn) btn.insertAdjacentHTML('beforeend','<div class="public-url">Відкриваємо тунель…</div>');
  socket.emit('createTunnel',res=>{
    if(!res||!res.ok){ alert(res&&res.error?res.error:'Не вдалося створити посилання'); return; }
    try{ navigator.clipboard.writeText(res.url); }catch(e){}
    alert('Публічне посилання скопійовано:\n'+res.url+'\n\nНадішли його друзям — заходити можна з інтернету без пробросу порту.');
  });
}
function copyPublicUrl(){
  if(!state||!state.publicUrl) return;
  try{ navigator.clipboard.writeText(state.publicUrl); alert('Скопійовано:\n'+state.publicUrl); }
  catch(e){ prompt('Скопіюйте посилання:', state.publicUrl); }
}
function closeLink(){ socket.emit('closeTunnel',()=>{}); }

function renderTrick(){
  const el=$('trick');
  if(!el||!state) return;
  const prevIds=new Set([...el.querySelectorAll('.played')].map(n=>n.dataset.cid));
  el.innerHTML=state.trick.map((x,i)=>{
    const cid=x.card&&x.card.id?x.card.id:(x.card.rank+x.card.suit);
    const isNew=!prevIds.has(cid) && prevIds.size>0;
    return `<div class="played ${isNew?'card-land':''}" data-cid="${esc(cid)}" style="--i:${i}">
      <div class="card ${red(x.card)?'red':''} ${x.card.joker?'joker':''}">${cardText(x.card)}</div>
      <small>${esc(state.players[x.player]?.name||'')}</small>
    </div>`;
  }).join('');
}

function renderHand(dealAnimate){
 if(!state)return;
 const myTurn=state.turn===state.players.findIndex(p=>p.id===socket.id);
 const legal=state.phase==='playing'&&myTurn?legalIds():new Set();
 const token=++dealAnimToken;
 const handEl=$('hand');
 if(!handEl) return;
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
  // player1..4 у DOM відповідають seat 0..3
  return $(`player${(playerIndex%4)+1}`);
}
function feltRect(){
  const felt=document.querySelector('.felt');
  return felt?felt.getBoundingClientRect():null;
}
function fxLayer(){ return $('fxLayer'); }

function makeFxCard(card){
  const d=document.createElement('div');
  d.className=`card fx-card ${red(card)?'red':''} ${card.joker?'joker':''}`;
  d.innerHTML=cardText(card);
  return d;
}

/** Карта летить з місця гравця в центр (хід). */
function animatePlayCard(playerIndex, card){
  const layer=fxLayer();
  const felt=feltRect();
  const seat=seatEl(playerIndex);
  if(!layer||!felt||!seat) return;
  const sr=seat.getBoundingClientRect();
  const fx=makeFxCard(card);
  const startX=sr.left+sr.width/2-felt.left-28;
  const startY=sr.top+sr.height/2-felt.top-40;
  // Центр столу (зона взятки)
  const endX=felt.width/2-28+(Math.random()*16-8);
  const endY=felt.height/2-20+(Math.random()*12-6);
  fx.style.left=startX+'px';
  fx.style.top=startY+'px';
  fx.style.opacity='0.95';
  layer.appendChild(fx);
  requestAnimationFrame(()=>{
    fx.style.transition='transform .38s cubic-bezier(.2,.8,.2,1), opacity .38s ease';
    fx.style.transform=`translate(${endX-startX}px, ${endY-startY}px) scale(1.05)`;
  });
  setTimeout(()=>{ fx.classList.add('fx-fade'); setTimeout(()=>fx.remove(),200); }, 380);
}

/** Усі карти взятки летять до переможця. */
function animateTakeTrick(trick, winnerIndex){
  const layer=fxLayer();
  const felt=feltRect();
  const seat=seatEl(winnerIndex);
  if(!layer||!felt||!seat||!trick||!trick.length) return;
  const sr=seat.getBoundingClientRect();
  const endX=sr.left+sr.width/2-felt.left-28;
  const endY=sr.top+sr.height/2-felt.top-40;
  const centerX=felt.width/2-28;
  const centerY=felt.height/2-20;
  // Підсвітка переможця
  seat.classList.add('winner-flash');
  setTimeout(()=>seat.classList.remove('winner-flash'), 700);

  trick.forEach((x,i)=>{
    const fx=makeFxCard(x.card);
    const ox=(i-1.5)*18;
    fx.style.left=(centerX+ox)+'px';
    fx.style.top=centerY+'px';
    fx.style.zIndex=String(10+i);
    layer.appendChild(fx);
    setTimeout(()=>{
      fx.style.transition=`transform .45s cubic-bezier(.25,.8,.25,1) ${i*40}ms, opacity .45s ease ${i*40}ms`;
      fx.style.transform=`translate(${endX-(centerX+ox)}px, ${endY-centerY}px) scale(.55) rotate(${(i-1.5)*12}deg)`;
      fx.style.opacity='0';
    }, 30);
    setTimeout(()=>fx.remove(), 600+i*40);
  });
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
 if(lead.joker&&(lead.status?.type==='suit'||lead.status?.type==='giveSuit')){
   const suit=lead.status.suit;
   const same=hand.filter(c=>!c.joker&&c.suit===suit);
   if(same.length){if(lead.status.type==='giveSuit')return new Set(same.map(c=>c.id).concat(jokers));const mx=Math.max(...same.map(c=>rankValue(c.rank)));return new Set(same.filter(c=>rankValue(c.rank)===mx).map(c=>c.id).concat(jokers))}
   const tr=hand.filter(c=>!c.joker&&state.trump&&c.suit===state.trump);
   if(tr.length)return new Set(tr.map(c=>c.id).concat(jokers));
   return new Set(hand.map(c=>c.id));
 }
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
  if(s?.type==='giveSuit') return `🃏<span class="joker-badge">↓</span>${suitHtml(s.suit)}`;
  if(s?.type==='asSuit') return `🃏${suitHtml(s.suit)}`;
  if(s?.type==='asCard') return `🃏${s.rank}${suitHtml(s.suit)}`;
  return '🃏';
}
function bid(v){socket.emit('bid',{value:v})};
function start(){socket.emit('startGame')};
function nextRound(){socket.emit('startNextRound')};
function addBot(){socket.emit('addBot')};
function setBotDiff(level){socket.emit('setBotDifficulty',{level});}
function newGame(){
  if(!confirm('Почати гру по новій? Поточний рахунок буде скинуто.')) return;
  socket.emit('newGame');
}
function endGame(){
  if(!confirm('Завершити поточну партію?')) return;
  socket.emit('endGame');
}
function leaveGame(){
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
    opts+='<button data-t="giveSuit">Віддати взятку (масть)</button>';
  } else {
    opts+='<button data-t="take">Забрати взятку</button>';
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
    // Дії без додаткового вибору
    if(t==='trumpHigh'||t==='take'){
      cardSound();
      socket.emit('play',{cardId:'JOKER',status:{type:t}});
      closeModal(m);
      return;
    }
    // Вибір масті
    if(t==='suit'||t==='giveSuit'||t==='asSuit'){
      const title = t==='suit' ? 'Оберіть масть (постаршій):' :
                    t==='giveSuit' ? 'Оберіть масть, яку віддаєте:' :
                    'Оберіть масть:';
      extra.innerHTML=`<p class="picker-title">${title}</p>${suitPickerHtml()}`;
      extra.querySelectorAll('.suit-btn').forEach(btn=>{
        btn.onclick=()=>{
          const suit=btn.dataset.suit;
          const type = t==='suit'?'suit':t==='giveSuit'?'giveSuit':'asSuit';
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

const _origRender=render;
render=function(){
  _origRender();
  updateVoiceUI();
};

// ========== VOICE CHAT (WebRTC mesh) ==========
let localStream=null;
let voiceEnabled=false;
const peers=new Map(); // peerId -> RTCPeerConnection
const ICE={iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]};

function updateVoiceUI(){
  const btn=$('voiceBtn');
  const st=$('voiceStatus');
  const hint=null;
  if(!btn) return;
  btn.classList.toggle('on',voiceEnabled);
  btn.textContent=voiceEnabled?'🎤 Увімкнено':'🎤 Мікрофон';
  const others=(state&&state.voiceOn)?state.voiceOn.filter(v=>v.id!==socket.id):[];
  if(st) st.textContent=voiceEnabled?(others.length?`У ефірі: ${others.map(v=>v.name).join(', ')}`:'Чекаємо інших…'):'';
  if(hint) hint.textContent=voiceEnabled?'🔊 голос':'';
}

function getMediaStream(constraints){
  if(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia==='function'){
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  const legacy=navigator.getUserMedia||navigator.webkitGetUserMedia||navigator.mozGetUserMedia||navigator.msGetUserMedia;
  if(legacy){
    return new Promise((resolve,reject)=>legacy.call(navigator,constraints,resolve,reject));
  }
  return Promise.reject(new Error('NO_MEDIA_DEVICES'));
}

async function enableVoice(){
  // На http:// (не localhost) браузери блокують мікрофон
  const isSecure=window.isSecureContext===true || location.protocol==='https:' ||
    location.hostname==='localhost' || location.hostname==='127.0.0.1' || location.hostname==='[::1]';
  if(!isSecure){
    alert(
      'Мікрофон недоступний на звичайному HTTP.\n\n'+
      'Відкрийте гру через:\n'+
      '• http://localhost:3000  (на цьому ПК)\n'+
      '• або натисніть «🌐 Публічне посилання» у господаря — воно дає HTTPS\n\n'+
      'Поточна адреса: '+location.origin
    );
    return;
  }
  try{
    localStream=await getMediaStream({audio:true,video:false});
    voiceEnabled=true;
    socket.emit('voiceToggle',{on:true});
    if(state&&state.voiceOn){
      for(const v of state.voiceOn){
        if(v.id!==socket.id) ensurePeer(v.id,true);
      }
    }
    updateVoiceUI();
  }catch(e){
    let msg=e&&e.message?String(e.message):String(e);
    if(e.name==='NotAllowedError'||e.name==='PermissionDeniedError'){
      msg='Доступ до мікрофона заборонено. Дозвольте його в налаштуваннях браузера для цього сайту.';
    } else if(e.name==='NotFoundError'||e.name==='DevicesNotFoundError'){
      msg='Мікрофон не знайдено. Підключіть пристрій і спробуйте ще раз.';
    } else if(msg==='NO_MEDIA_DEVICES'||/mediaDevices|getUserMedia/i.test(msg)){
      msg='Браузер не дає доступ до мікрофона (потрібен HTTPS або localhost).\n\n'+
          'Відкрийте через http://localhost або «Публічне посилання».\nАдреса зараз: '+location.origin;
    }
    alert('Не вдалося увімкнути мікрофон:\n'+msg);
    voiceEnabled=false;
    updateVoiceUI();
  }
}
function disableVoice(){
  voiceEnabled=false;
  socket.emit('voiceToggle',{on:false});
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  for(const [id,pc] of peers){ try{pc.close()}catch(e){} removeRemoteAudio(id); }
  peers.clear();
  updateVoiceUI();
}
$('voiceBtn').onclick=()=>{ if(voiceEnabled) disableVoice(); else enableVoice(); };

function ensurePeer(peerId,isInitiator){
  if(peers.has(peerId) || peerId===socket.id) return peers.get(peerId);
  const pc=new RTCPeerConnection(ICE);
  peers.set(peerId,pc);
  if(localStream) localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.onicecandidate=e=>{
    if(e.candidate) socket.emit('rtcSignal',{to:peerId,data:{type:'ice',candidate:e.candidate}});
  };
  pc.ontrack=e=>{
    const stream=e.streams[0];
    let audio=document.getElementById('audio-'+peerId);
    if(!audio){
      audio=document.createElement('audio');
      audio.id='audio-'+peerId;
      audio.autoplay=true;
      $('remoteAudios').appendChild(audio);
    }
    audio.srcObject=stream;
  };
  pc.onconnectionstatechange=()=>{
    if(['failed','disconnected','closed'].includes(pc.connectionState)){
      try{pc.close()}catch(e){}
      peers.delete(peerId);
      removeRemoteAudio(peerId);
    }
  };
  if(isInitiator){
    pc.createOffer().then(offer=>{
      return pc.setLocalDescription(offer);
    }).then(()=>{
      socket.emit('rtcSignal',{to:peerId,data:{type:'offer',sdp:pc.localDescription}});
    }).catch(console.error);
  }
  return pc;
}
function removeRemoteAudio(peerId){
  const a=document.getElementById('audio-'+peerId);
  if(a) a.remove();
}

socket.on('voicePeer',async ({id,name,on})=>{
  if(id===socket.id) return;
  if(on && voiceEnabled){
    // Only the side with "smaller" id initiates to avoid glare
    const iAmInitiator = socket.id < id;
    ensurePeer(id, iAmInitiator);
  } else {
    const pc=peers.get(id);
    if(pc){ try{pc.close()}catch(e){} peers.delete(id); }
    removeRemoteAudio(id);
  }
  updateVoiceUI();
});

socket.on('rtcSignal',async ({from,data})=>{
  if(!voiceEnabled) return;
  let pc=peers.get(from);
  if(!pc) pc=ensurePeer(from,false);
  try{
    if(data.type==='offer'){
      await pc.setRemoteDescription(data.sdp);
      const answer=await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('rtcSignal',{to:from,data:{type:'answer',sdp:pc.localDescription}});
    } else if(data.type==='answer'){
      await pc.setRemoteDescription(data.sdp);
    } else if(data.type==='ice' && data.candidate){
      try{ await pc.addIceCandidate(data.candidate); }catch(e){}
    }
  }catch(e){ console.error('rtc signal',e); }
});
