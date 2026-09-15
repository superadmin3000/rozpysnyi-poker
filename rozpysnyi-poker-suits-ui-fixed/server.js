const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { execSync } = require('child_process');
const os = require('os');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || (PORT + 443 > 65535 ? 3443 : PORT === 3000 ? 3443 : PORT + 443);
let activePort = PORT;
let activeHttpsPort = null;
let publicTunnel = null; // { url, close }
let httpServer = null;
let httpsServer = null;
const io = new Server({
  cors: { origin: true, methods: ['GET', 'POST'] }
});

/** Самопідписаний сертифікат для локального HTTPS (мікрофон / WebRTC). */
function ensureCerts(){
  const dir = path.join(__dirname, 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if(fs.existsSync(keyPath) && fs.existsSync(certPath)){
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  fs.mkdirSync(dir, { recursive: true });
  try{
    // SAN для localhost + локальні IP — щоб телефон у мережі теж приймав cert
    const ips = [];
    const nets = os.networkInterfaces();
    for(const name of Object.keys(nets||{})){
      for(const n of nets[name]||[]){
        if(n.family==='IPv4' && !n.internal) ips.push(n.address);
      }
    }
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map(ip=>`IP:${ip}`)].join(',');
    const conf = path.join(dir, 'openssl.cnf');
    fs.writeFileSync(conf, [
      '[req]', 'distinguished_name=req_distinguished_name', 'x509_extensions=v3_req', 'prompt=no',
      '[req_distinguished_name]', 'CN=Rozpysnyi Poker Local',
      '[v3_req]', 'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
      `subjectAltName=${san}`
    ].join('\n'));
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 825 -config "${conf}"`,
      { stdio: 'ignore' }
    );
    console.log('Згенеровано self-signed сертифікат у папці certs/');
  }catch(e){
    console.warn('Не вдалося згенерувати сертифікат через openssl:', e.message);
    return null;
  }
  if(!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return null;
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}
const rooms = new Map();
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['6','7','8','9','10','J','Q','K','A'];
const VALUE = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
const ROUND_TYPES = [
  ...Array.from({length:8},(_,i)=>({name:String(i+1), cards:i+1, mode:'normal'})),
  ...Array.from({length:4},(_,i)=>({name:`9 (${i+1}/4)`, cards:9, mode:'normal'})),
  ...Array.from({length:4},(_,i)=>({name:`Темна ${i+1}/4`,cards:9,mode:'dark'})),
  ...Array.from({length:4},(_,i)=>({name:`Без козиря ${i+1}/4`,cards:9,mode:'notrump'})),
  ...Array.from({length:4},(_,i)=>({name:`Золота ${i+1}/4`,cards:9,mode:'gold'})),
  ...Array.from({length:4},(_,i)=>({name:`Мізер ${i+1}/4`,cards:9,mode:'misere'}))
];

function id(){ return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function deck(){
  const d=[];
  for(const suit of SUITS) for(const rank of RANKS) d.push({suit,rank,id:rank+suit});
  d.push({joker:true,rank:'JOKER',suit:'',id:'JOKER'});
  return d;
}
function shuffle(a){
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function nextSeat(seat){ return (seat+1)%4; }
function playerIndex(room,socketId){ return room.players.findIndex(p=>p.id===socketId); }
function addLog(room,msg){ room.log.push(msg); if(room.log.length>40) room.log.shift(); }
function currentPlayer(room){ return room.players[room.turn]; }
function isBiddingMode(mode){ return mode==='normal'||mode==='dark'||mode==='notrump'; }
function publicCard(c){
  if(!c) return c;
  return {id:c.id,suit:c.suit,rank:c.rank,joker:!!c.joker,status:c.status||null};
}
function publicState(room){
  return {
    code:room.code,
    roundIndex:room.roundIndex,
    round:ROUND_TYPES[room.roundIndex],
    phase:room.phase,
    dealer:room.dealer,
    leader:room.leader,
    turn:room.turn,
    trump:room.trump,
    trumpCard:publicCard(room.trumpCard),
    players:room.players.map((p,i)=>({
      id:p.id,name:p.name,seat:i,connected:p.connected,score:p.score,
      bid:p.bid,tricks:p.tricks,cards:p.hand.length,bot:!!p.bot,
      jokers:p.jokers||0,
      zeroBidStreak:p.zeroBidStreak||0
    })),
    trick:room.trick.map(x=>({player:x.player,card:publicCard(x.card)})),
    winner:room.winner,
    roundScores:room.roundScores,
    scoreHistory:room.scoreHistory||[],
    lottery:room.lottery||[],
    log:room.log.slice(-14),
    chat:(room.chat||[]).slice(-50),
    voiceOn:room.players.filter(p=>p.voiceOn && p.connected && !p.bot).map(p=>({id:p.id,name:p.name})),
    publicUrl: publicTunnel ? publicTunnel.url : null
  };
}
function emit(room){ io.to(room.code).emit('state',publicState(room)); scheduleBot(room); }
function sortHand(hand){
  // Зліва направо: масть ♠♥♦♣, у масті від 6 до A; джокер справа
  const suitOrder=Object.fromEntries(SUITS.map((s,i)=>[s,i]));
  return hand.slice().sort((a,b)=>{
    if(a.joker && b.joker) return 0;
    if(a.joker) return 1;
    if(b.joker) return -1;
    const sa=suitOrder[a.suit]??9, sb=suitOrder[b.suit]??9;
    if(sa!==sb) return sa-sb;
    return (VALUE[a.rank]??0)-(VALUE[b.rank]??0);
  });
}
function sendHand(room){
  for(const p of room.players){
    if(p.bot) continue;
    p.hand=sortHand(p.hand);
    io.to(p.id).emit('hand',p.hand.map(publicCard));
  }
}

// After all cards are dealt, the NEXT card is opened and determines trump.
// If that opened card is the joker, the round is played without trump.
function chooseTrump(room){
  const top=room.trumpCard;
  room.trump = (room.round.mode==='notrump' || !top || top.joker) ? null : top.suit;
}
function deal(room){
  const r=room.round;
  room.deck=shuffle(deck());
  room.trumpCard=null;
  for(let n=0;n<r.cards;n++) {
    for(let i=0;i<4;i++) {
      room.players[(room.dealer+1+i)%4].hand.push(room.deck.pop());
    }
  }
  room.trumpCard=room.deck.pop() || null;
  chooseTrump(room);
  room.players.forEach(p=>{
    p.hand=sortHand(p.hand);
    // Кому випав джокер — не розкриваємо публічно до кінця раунду
    p.dealtJokerThisRound=p.hand.some(c=>c.joker);
  });
}
function resetRoundData(room){
  room.trick=[]; room.winner=null; room.roundScores=null;
  room.players.forEach(p=>{p.hand=[];p.bid=null;p.tricks=0;p.dealtJokerThisRound=false;});
}
function startRound(room){
  const r=ROUND_TYPES[room.roundIndex];
  room.round=r;
  room.phase='prebid';
  room.winner=null;
  room.trick=[];
  room.turn=nextSeat(room.dealer);
  room.leader=room.turn;
  room.trump=null;
  room.players.forEach(p=>{p.hand=[];p.bid=null;p.tricks=0;p.dealtJokerThisRound=false;});

  if(r.mode==='dark'){
    // Dark: orders are made before cards are dealt.
    addLog(room,`Раунд «Темна»: спочатку всі роблять замовлення, потім буде роздача.`);
  } else {
    deal(room);
    const trumpLabel=()=> room.trumpCard&&!room.trumpCard.joker&&room.trump
        ? `${room.trumpCard.rank}${room.trumpCard.suit}` : (room.trump||null);
    if(isBiddingMode(r.mode)){
      room.phase='bidding';
      addLog(room,`Раунд «${r.name}» розпочато. ${trumpLabel()?`Козир: ${trumpLabel()}`:'Без козиря'}.`);
    } else {
      room.phase='playing';
      addLog(room,`Раунд «${r.name}» розпочато. ${trumpLabel()?`Козир: ${trumpLabel()}`:'Без козиря'}.`);
    }
  }
  emit(room); sendHand(room);
}
function allBids(room){ return room.players.every(p=>p.bid!==null); }
function beginDarkDeal(room){
  deal(room);
  room.phase='playing';
  room.turn=room.leader;
  const tl=room.trumpCard&&!room.trumpCard.joker&&room.trump?`${room.trumpCard.rank}${room.trumpCard.suit}`:(room.trump||null);
  addLog(room,`Замовлення «Темної» завершено. Карти роздано. ${tl?`Козир: ${tl}.`:''}`);
  emit(room); sendHand(room);
}
function beginPlaying(room){
  room.phase='playing'; room.turn=room.leader;
  addLog(room,'Торги завершено. Граємо взятки.'); emit(room);
}

function basePower(card, trump, leadSuit){
  if(card.joker) return 10000;
  const rank=VALUE[card.rank] ?? 0;
  if(trump && card.suit===trump) return 2000+rank;
  if(leadSuit && card.suit===leadSuit) return 1000+rank;
  return rank;
}
function highest(cards){
  return cards.reduce((best,c)=>VALUE[c.rank]>VALUE[best.rank]?c:best);
}
function jokerLead(room){
  // Джокер, яким зайшли у взятку (зі статусом)
  const first=room.trick[0];
  if(first && first.card.joker && first.card.status) return first;
  return null;
}
function trickRule(room){
  const j=jokerLead(room);
  if(!j) return null;
  const s=j.card.status;
  if(s.type==='trumpHigh') return {type:'trumpHigh'};
  if(s.type==='suit' && s.suit) return {type:'suit',suit:s.suit,forceHigh:true};
  if(s.type==='giveSuit' && s.suit) return {type:'suit',suit:s.suit,forceHigh:false};
  return null;
}
function validateJokerStatus(room,status,isLead){
  if(!status||!status.type) return false;
  if(isLead){
    // Захід з джокера: лише «по старших козирях» або «по старших <масть>»
    if(status.type==='trumpHigh') return !!room.trump;
    if(status.type==='suit'||status.type==='giveSuit') return SUITS.includes(status.suit);
    return false;
  }
  // Не з заходу: можна забрати взятку або скинути «як карту» масті
  if(status.type==='take') return true;
  if(status.type==='asSuit') return SUITS.includes(status.suit);
  if(status.type==='asCard') return SUITS.includes(status.suit)&&RANKS.includes(status.rank);
  return false;
}
function validCards(room,p){
  // Джокер завжди можна класти — правило масті/козиря на нього не діє
  const jokers=p.hand.filter(c=>c.joker);
  if(room.trick.length===0) return p.hand;
  const rule=trickRule(room);
  if(rule?.type==='trumpHigh'){
    const trumps=room.trump?p.hand.filter(c=>!c.joker&&c.suit===room.trump):[];
    if(trumps.length) return [highest(trumps)].concat(jokers);
    return p.hand;
  }
  if(rule?.type==='suit'){
    const suited=p.hand.filter(c=>!c.joker&&c.suit===rule.suit);
    if(suited.length) return (rule.forceHigh ? [highest(suited)] : suited).concat(jokers);
    const trumps=room.trump?p.hand.filter(c=>!c.joker&&c.suit===room.trump):[];
    if(trumps.length) return trumps.concat(jokers);
    return p.hand;
  }
  const lead=room.trick[0].card;
  const leadSuit=lead.joker?null:lead.suit;
  if(!leadSuit) return p.hand;
  const same=p.hand.filter(c=>!c.joker&&c.suit===leadSuit);
  if(same.length) return same.concat(jokers);
  // Немає масті заходу → зобов’язаний бити козирем, якщо є
  const trumps=room.trump?p.hand.filter(c=>!c.joker&&c.suit===room.trump):[];
  if(trumps.length) return trumps.concat(jokers);
  return p.hand;
}
function winnerOf(room,trick){
  const rule=trickRule(room);
  const jEntry=trick.find(x=>x.card.joker);

  if(rule?.type==='trumpHigh'){
    // «По старших козирях» — взятку завжди забирає джокер
    return jEntry || trick[0];
  }
  if(rule?.type==='suit'){
    // giveSuit (forceHigh=false): джокер віддає масть — сам не бере
    if(!rule.forceHigh){
      const trumps=trick.filter(x=>!x.card.joker&&room.trump&&x.card.suit===room.trump&&rule.suit!==room.trump);
      if(trumps.length) return trumps.reduce((a,b)=>VALUE[a.card.rank]>=VALUE[b.card.rank]?a:b);
      const ofSuit=trick.filter(x=>!x.card.joker&&x.card.suit===rule.suit);
      if(ofSuit.length) return ofSuit.reduce((a,b)=>VALUE[a.card.rank]>=VALUE[b.card.rank]?a:b);
      return trick.find(x=>!x.card.joker)||trick[0];
    }
    // forceHigh («постаршій масті»):
    // 1. Усі, хто мають масть, зобов’язані скинути найстаршу карту цієї масті (вже в legalCards)
    // 2. Джокер ЗАВЖДИ забирає взятку, окрім випадку коли хтось поклав козир
    //    (тому що в нього немає цієї масті)
    const trumps=trick.filter(x=>!x.card.joker&&room.trump&&x.card.suit===room.trump&&rule.suit!==room.trump);
    if(trumps.length)
      return trumps.reduce((a,b)=>basePower(a.card,room.trump,room.trump)>=basePower(b.card,room.trump,room.trump)?a:b);
    // немає козиря → джокер бере
    return jEntry || trick[0];
  }

  // Звичайна взятка / джокер не з заходу
  // Джокер зі статусом take або без статусу як «забрати» — б'є все
  // Джокер asSuit/asCard — грає як ця карта
  const first=trick[0];
  const leadSuit=first.card.joker?null:first.card.suit;
  return trick.reduce((best,entry)=>{
    const power=(e)=>{
      const c=e.card;
      if(c.joker){
        const s=c.status;
        if(!s||s.type==='take'||s.type==='trumpHigh') return 10000;
        if(s.type==='suit'||s.type==='asSuit')
          return basePower({suit:s.suit,rank:'A'},room.trump,leadSuit);
        if(s.type==='asCard'||s.type==='card')
          return basePower({suit:s.suit,rank:s.rank},room.trump,leadSuit);
        return 10000;
      }
      return basePower(c,room.trump,leadSuit);
    };
    return power(entry)>=power(best)?entry:best;
  });
}
function scoreRound(room){
  // Гарантуємо ініціалізацію історії рахунку для старих/відновлених кімнат.
  if(!Array.isArray(room.scoreHistory)) room.scoreHistory=[];
  const r=room.round;
  room.roundScores=room.players.map(p=>{
    let delta=0;
    if(r.mode==='gold') delta=p.tricks===0?-50:p.tricks*10;
    else if(r.mode==='misere') {
      // Special misère sweep: taking all 9 tricks gives +100 to the sweep winner
      // and 0 to every other player.
      const sweepWinner=room.players.find(x=>x.tricks===9);
      if(sweepWinner) delta=(p.tricks===9)?100:0;
      else delta=p.tricks===0?50:-10*p.tricks;
    }
    else {
      // Звичайні / Темна / Без козиря:
      // - точно: +10 за кожну взятку
      // - 0/0: +5
      // - перебір (взяток більше ніж замовлено): +1 за кожну взятку
      // - недобір: −10 за кожну недобрану (замовлена − взята)
      // На Темній усі ці очки ×2
      let base;
      if(p.bid===0 && p.tricks===0) base=5;
      else if(p.bid===p.tricks) base=10*p.tricks;
      else if(p.tricks > p.bid) base=1*p.tricks; // перебір
      else base=-10 * ((p.bid||0) - (p.tricks||0)); // недобір за кожну недобрану
      delta=r.mode==='dark'?base*2:base;
    }
    p.score+=delta;
    // Серія нульових замовлень лише в раундах, де є торги
    if(isBiddingMode(r.mode)){
      if(p.bid===0) p.zeroBidStreak=(p.zeroBidStreak||0)+1;
      else p.zeroBidStreak=0;
    }
    return {player:p.name,delta,tricks:p.tricks,bid:p.bid,total:p.score};
  });
  room.scoreHistory.push({round:r.name, scores:room.roundScores.map(x=>({...x}))});
}
function finishRound(room){
  // Розкриваємо, кому дістався джокер у цьому раунді
  room.players.forEach(p=>{
    if(p.dealtJokerThisRound) p.jokers=(p.jokers||0)+1;
    p.dealtJokerThisRound=false;
  });
  scoreRound(room); room.phase='roundEnd';
  addLog(room,'Раунд завершено. Рахунок оновлено.');
  emit(room); sendHand(room);
}
function finishTrick(room){
  if(room.phase!=='playing' || room.trick.length!==4) return;
  const w=winnerOf(room,room.trick);
  room.winner=w.player;
  room.players[w.player].tricks++;
  addLog(room,`${room.players[w.player].name} бере взятку.`);
  room.trick=[];
  room.leader=w.player;
  room.turn=w.player;
  if(room.players.every(p=>p.hand.length===0)) finishRound(room); else { emit(room); sendHand(room); }
}

// ========== BOTS (розумніша логіка) ==========
const BOT_NAMES = ['Бот Алекс','Бот Оля','Бот Макс','Бот Іра','Бот Сергій','Бот Настя'];
function scheduleBot(room){
  if(!room || !['bidding','prebid','playing'].includes(room.phase)) return;
  if(room.phase==='playing' && room.trick.length===4) return;
  const p = room.players[room.turn];
  if(!p || !p.bot) return;
  if(room._botTimer) clearTimeout(room._botTimer);
  const delay = 500 + Math.floor(Math.random()*700);
  room._botTimer = setTimeout(()=> botAct(room), delay);
}
function botAct(room){
  if(!room || !rooms.has(room.code)) return;
  if(room.phase==='playing' && room.trick.length===4) return;
  const p = room.players[room.turn];
  if(!p || !p.bot) return;
  if(room.phase==='bidding' || room.phase==='prebid') botBid(room, p);
  else if(room.phase==='playing') botPlay(room, p);
}

function rankVal(c){ return VALUE[c.rank]??0; }
function lowestCard(cards){
  return cards.reduce((b,c)=> rankVal(c)<rankVal(b)?c:b);
}
function highestCard(cards){
  return cards.reduce((b,c)=> rankVal(c)>rankVal(b)?c:b);
}

/** Оцінка сили руки → очікувані взятки */
function estimateTricks(hand, trump, mode){
  if(!hand || !hand.length) return 0;
  let score = 0;
  const bySuit = {};
  for(const s of SUITS) bySuit[s]=[];
  let hasJoker=false;
  for(const c of hand){
    if(c.joker){ hasJoker=true; continue; }
    bySuit[c.suit].push(c);
  }
  if(hasJoker) score += 1.15;

  if(mode==='misere'){
    // На мізері рахуємо «ризик» взяток
    let risk=0;
    if(hasJoker) risk+=1;
    for(const s of SUITS){
      const arr=bySuit[s];
      if(!arr.length) continue;
      const hi=Math.max(...arr.map(rankVal));
      if(hi>=7) risk+=0.7; // A/K
      else if(hi>=5) risk+=0.35;
      if(arr.length>=4) risk+=0.3;
    }
    return risk;
  }

  for(const s of SUITS){
    const arr=bySuit[s];
    if(!arr.length) continue;
    const isTrump = trump && s===trump;
    const sorted=[...arr].sort((a,b)=>rankVal(b)-rankVal(a));
    for(let i=0;i<sorted.length;i++){
      const v=rankVal(sorted[i]);
      if(isTrump){
        if(v>=7) score+=0.95;      // A/K козир
        else if(v>=5) score+=0.7;  // Q/J
        else if(v>=3) score+=0.45;
        else score+=0.25;
      } else if(mode==='notrump' || !trump){
        if(v>=7) score+=0.85;
        else if(v>=5) score+=0.4;
        else if(v>=3 && sorted.length<=2) score+=0.15;
      } else {
        // звичайна масть
        if(v>=7) score+=0.75;
        else if(v>=5 && sorted.length<=2) score+=0.25;
        // короткі масті — шанс козирити
        if(arr.length===1 && v<5) score+=0.1;
      }
    }
    // довгий козир
    if(isTrump && arr.length>=3) score += 0.35*(arr.length-2);
  }
  // void + trump = потенційна взятка
  if(trump){
    const voids = SUITS.filter(s=>s!==trump && bySuit[s].length===0).length;
    const trN = bySuit[trump].length;
    score += Math.min(voids, trN)*0.35;
  }
  return Math.max(0, score);
}

function botBid(room, p){
  const r = room.round;
  const nMax = r.cards;
  const othersSum = room.players.reduce((s,pl,i)=> i===room.turn ? s : s + (pl.bid??0), 0);
  const isLast = room.players.filter(pl=>pl.bid!==null).length === 3;
  const blockZero = isBiddingMode(r.mode) && (p.zeroBidStreak||0)>=2;

  let estimate;
  if(r.mode==='dark' || room.phase==='prebid'){
    // Темна: карти ще не роздані — обережна оцінка
    estimate = Math.max(0, Math.round(nMax*0.22 + Math.random()*1.2 - 0.3));
  } else if(r.mode==='gold'){
    // На золотій немає торгів — не викликається
    estimate = 0;
  } else if(r.mode==='misere'){
    estimate = 0; // на мізері торгів немає
  } else {
    const raw = estimateTricks(p.hand, room.trump, r.mode);
    // трохи консервативно + шум
    estimate = Math.round(raw*0.92 + (Math.random()*0.6-0.2));
  }
  estimate = Math.max(0, Math.min(nMax, estimate));

  // Якщо вже 2 нулі підряд — мінімум 1
  if(blockZero && estimate===0) estimate=1;

  // Останній гравець: сума ≠ nMax
  if(isLast && othersSum + estimate === nMax){
    if(estimate+1 <= nMax) estimate++;
    else if(estimate-1 >= (blockZero?1:0)) estimate--;
    else {
      // крайній випадок
      for(let d=1;d<=nMax;d++){
        if(estimate+d<=nMax && othersSum+(estimate+d)!==nMax){ estimate+=d; break; }
        if(estimate-d>=(blockZero?1:0) && othersSum+(estimate-d)!==nMax){ estimate-=d; break; }
      }
    }
  }

  // Фінальна перевірка допустимості
  let pick = estimate;
  if(blockZero && pick===0) pick=1;
  if(isLast && othersSum + pick === nMax){
    pick = pick===0 ? 1 : (pick-1>=0 && !(blockZero&&pick-1===0) ? pick-1 : Math.min(nMax, pick+1));
    if(isLast && othersSum + pick === nMax && pick+1<=nMax) pick++;
  }
  pick = Math.max(0, Math.min(nMax, pick));
  if(blockZero && pick===0) pick = Math.min(nMax,1);

  p.bid = pick;
  addLog(room, `${p.name}: замовлення ${pick}.`);
  if(allBids(room)){
    if(r.mode==='dark') beginDarkDeal(room); else beginPlaying(room);
  } else {
    room.turn = nextSeat(room.turn);
    emit(room);
  }
}

/** Хто зараз виграє взятку (серед уже покладених) */
function currentTrickWinner(room){
  if(!room.trick.length) return null;
  return winnerOf(room, room.trick);
}

/** Чи наша карта поб'є поточну взятку */
function wouldWin(room, card, status){
  const trial = room.trick.concat([{player: room.turn, card: status ? {...card, status}:{...card}}]);
  try {
    const w = winnerOf(room, trial);
    return w && w.player === room.turn;
  } catch(e){ return false; }
}

function botPickJokerStatus(room, p, wantTrick){
  const isLead = room.trick.length===0;
  if(isLead){
    if(wantTrick && room.trump){
      // забрати козирі суперників
      return {type:'trumpHigh'};
    }
    // найсильніша масть у руці (без козиря) або випадкова
    const counts={};
    for(const s of SUITS) counts[s]=0;
    for(const c of p.hand){ if(!c.joker) counts[c.suit]=(counts[c.suit]||0)+1; }
    let best=SUITS[0], bestN=-1;
    for(const s of SUITS){
      if(room.trump && s===room.trump) continue;
      if((counts[s]||0)>bestN){ bestN=counts[s]||0; best=s; }
    }
    if(wantTrick) return {type:'suit', suit:best};
    return {type:'giveSuit', suit:best};
  }
  // не з заходу
  if(wantTrick) return {type:'take'};
  // скинути як слабку масть
  const lead = room.trick[0]?.card;
  const leadSuit = lead && !lead.joker ? lead.suit : (room.trump||SUITS[0]);
  return {type:'asSuit', suit: leadSuit};
}

function botPlay(room, p){
  const allowed = validCards(room, p);
  if(!allowed.length) return;
  const r = room.round;
  const mode = r.mode;
  const bid = p.bid??0;
  const need = bid - (p.tricks||0); // скільки ще треба
  const remainingTricks = p.hand.length; // приблизно = карт у руці
  const mustTake = need > 0;
  const mustDump = mode==='misere' || (need <= 0 && mode!=='gold');
  const desperate = mustTake && need >= remainingTricks; // треба майже все

  const jokers = allowed.filter(c=>c.joker);
  const nonJ = allowed.filter(c=>!c.joker);
  const isLead = room.trick.length===0;
  const trump = room.trump;

  let card=null;
  let status=null;

  // --- МІЗЕР / скидання ---
  if(mustDump && !desperate){
    if(nonJ.length){
      // наймолодша, бажано не козир (на мізері козир небезпечний)
      const nonTr = trump ? nonJ.filter(c=>c.suit!==trump) : nonJ;
      const pool = nonTr.length ? nonTr : nonJ;
      card = lowestCard(pool);
    } else if(jokers.length){
      card = jokers[0];
      status = botPickJokerStatus(room, p, false);
    }
  }

  // --- ЗАХІД ---
  if(!card && isLead){
    if(mustTake || mode==='gold'){
      // ходити з сильної: козирний туз / старший козир / туз
      const trumps = trump ? nonJ.filter(c=>c.suit===trump) : [];
      const aces = nonJ.filter(c=>c.rank==='A' && (!trump || c.suit!==trump));
      if(trumps.length && (desperate || Math.random()<0.55)){
        card = highestCard(trumps);
      } else if(aces.length){
        card = aces[0];
      } else if(trumps.length){
        card = highestCard(trumps);
      } else if(nonJ.length){
        card = highestCard(nonJ);
      } else if(jokers.length){
        card = jokers[0];
        status = botPickJokerStatus(room, p, true);
      }
    } else {
      // скидання: наймолодша некозирна
      const nonTr = trump ? nonJ.filter(c=>c.suit!==trump) : nonJ;
      const pool = nonTr.length ? nonTr : nonJ;
      if(pool.length) card = lowestCard(pool);
      else if(jokers.length){ card=jokers[0]; status=botPickJokerStatus(room,p,false); }
    }
  }

  // --- ВІДПОВІДЬ У ВЗЯТКУ ---
  if(!card && !isLead){
    const cur = currentTrickWinner(room);
    const winningUs = cur && cur.player === room.turn; // ще не ходили, завжди false
    // карти, якими можемо взяти
    const winners = nonJ.filter(c=> wouldWin(room, c, null));
    const losers = nonJ.filter(c=> !wouldWin(room, c, null));

    if(mustTake || mode==='gold'){
      if(winners.length){
        // мінімальна карта, що все ще бере
        card = winners.reduce((b,c)=> rankVal(c)<rankVal(b)?c:b);
        // якщо desperate — можна й старшу
        if(desperate) card = highestCard(winners);
      } else if(jokers.length && (desperate || need>0)){
        card = jokers[0];
        status = {type:'take'};
        if(!wouldWin(room, card, status)) status = {type:'take'};
      } else if(nonJ.length){
        card = lowestCard(nonJ); // не можемо взяти — скинути дешеву
      }
    } else {
      // не треба взятка
      if(losers.length) card = lowestCard(losers);
      else if(nonJ.length) card = lowestCard(nonJ);
      else if(jokers.length){
        card = jokers[0];
        status = botPickJokerStatus(room, p, false);
      }
    }
  }

  // fallback
  if(!card){
    card = nonJ.length ? lowestCard(nonJ) : (jokers[0]||allowed[0]);
    if(card.joker && !status) status = botPickJokerStatus(room, p, mustTake);
  }

  if(card.joker){
    if(!status) status = botPickJokerStatus(room, p, mustTake || mode==='gold');
    if(!validateJokerStatus(room, status, isLead)){
      status = isLead
        ? (room.trump ? {type:'trumpHigh'} : {type:'suit', suit:SUITS[0]})
        : {type: mustTake ? 'take' : 'asSuit', suit: room.trump||SUITS[0]};
    }
    card.status = {...status};
    const label = status.type==='trumpHigh' ? 'по старших козирях'
      : status.type==='suit' ? `по старших ${status.suit}`
      : status.type==='giveSuit' ? `віддати ${status.suit}`
      : status.type==='take' ? 'забрати взятку'
      : status.type==='asSuit' ? `як ${status.suit}` : 'джокером';
    addLog(room, `${p.name} ходить джокером: ${label}.`);
  } else {
    delete card.status;
  }

  const idx = p.hand.findIndex(c=>c.id===card.id);
  if(idx<0) return;
  p.hand.splice(idx,1);
  room.trick.push({player: room.turn, card});
  room.turn = nextSeat(room.turn);
  emit(room); sendHand(room);
  if(room.trick.length===4) setTimeout(()=>finishTrick(room), 500);
}

io.on('connection',socket=>{
  socket.on('createRoom',({name},cb)=>{
    let code; do code=id(); while(rooms.has(code));
    const room={code,roundIndex:0,round:ROUND_TYPES[0],phase:'lobby',dealer:0,leader:0,turn:0,trump:null,trumpCard:null,players:[],trick:[],deck:[],winner:null,roundScores:null,scoreHistory:[],log:[],chat:[]};
    const token=crypto.randomBytes(8).toString('hex');
    const p={id:socket.id,token,name:(name||'Гравець').slice(0,20),score:0,bid:null,tricks:0,hand:[],connected:true,bot:false,jokers:0,zeroBidStreak:0};
    room.players.push(p); rooms.set(code,room); socket.join(code); socket.roomCode=code; socket.playerToken=token;
    socket.emit('hand',[]); emit(room); cb({ok:true,code,token});
  });
  socket.on('joinRoom',({code,name},cb)=>{
    const room=rooms.get((code||'').trim().toUpperCase());
    if(!room) return cb({ok:false,error:'Кімнату не знайдено'});
    if(room.phase!=='lobby') return cb({ok:false,error:'Гра вже розпочата'});
    if(room.players.length>=4) return cb({ok:false,error:'Кімната вже заповнена'});
    const token=crypto.randomBytes(8).toString('hex');
    const p={id:socket.id,token,name:(name||`Гравець ${room.players.length+1}`).slice(0,20),score:0,bid:null,tricks:0,hand:[],connected:true,bot:false,jokers:0,zeroBidStreak:0};
    room.players.push(p); socket.join(room.code); socket.roomCode=room.code; socket.playerToken=token;
    cb({ok:true,code:room.code,token}); emit(room);
  });
  // Перепідключення по токену (після закриття вкладки / оновлення сторінки)
  socket.on('reconnectRoom',({code,token},cb)=>{
    const room=rooms.get((code||'').trim().toUpperCase());
    if(!room) return cb({ok:false,error:'Кімнату не знайдено'});
    const p=room.players.find(pl=>pl.token===token && !pl.bot);
    if(!p) return cb({ok:false,error:'Сесію не знайдено'});
    p.id=socket.id;
    p.connected=true;
    socket.join(room.code);
    socket.roomCode=room.code;
    socket.playerToken=token;
    addLog(room,`${p.name} повернувся в гру.`);
    cb({ok:true,code:room.code,token,name:p.name});
    emit(room);
    sendHand(room);
  });
  socket.on('addBot',()=>{
    const room=rooms.get(socket.roomCode);
    if(!room||room.phase!=='lobby'||room.players[0].id!==socket.id) return;
    if(room.players.length>=4) return;
    const usedNames = new Set(room.players.map(p=>p.name));
    const name = BOT_NAMES.find(n=>!usedNames.has(n)) || `Бот ${room.players.length}`;
    const botId = 'bot-' + crypto.randomBytes(3).toString('hex');
    const p={id:botId,name,score:0,bid:null,tricks:0,hand:[],connected:true,bot:true,jokers:0,zeroBidStreak:0};
    room.players.push(p);
    addLog(room, `${name} приєднався до кімнати.`);
    emit(room);
  });
  socket.on('startGame',()=>{
    const room=rooms.get(socket.roomCode); if(!room||room.players.length!==4||room.players[0].id!==socket.id)return;
    room.roundIndex=0; room.players.forEach(p=>{p.score=0;p.jokers=0;p.zeroBidStreak=0;});
    room.scoreHistory=[];

    // Визначення першого здавача: гравці по черзі тягнуть по 1 карті,
    // і перший, кому випадає туз, стає здавачем.
    const probe=shuffle(deck());
    const draws=[];
    let seat=0;
    let dealer=-1;
    while(probe.length && dealer===-1){
      const card=probe.pop();
      draws.push({seat,card});
      if(!card.joker && card.rank==='A') dealer=seat;
      else seat=nextSeat(seat);
    }
    if(dealer===-1) dealer=0; // технічний захист, практично недосяжно
    room.dealer=dealer;
    room.lottery=draws.map(x=>({player:x.seat,card:publicCard(x.card)}));
    addLog(room,`Визначення здавача: ${draws.map(x=>`${room.players[x.seat].name} — ${x.card.joker?'🃏':x.card.rank+x.card.suit}`).join('; ')}.`);
    addLog(room,`Перший туз отримує ${room.players[room.dealer].name} — він/вона здає першим.`);
    startRound(room);
  });
  socket.on('startNextRound',()=>{
    const room=rooms.get(socket.roomCode); if(!room||room.phase!=='roundEnd'||room.players[0].id!==socket.id)return;
    room.roundIndex++;
    if(room.roundIndex>=ROUND_TYPES.length){room.phase='gameEnd';addLog(room,'Партію завершено.');emit(room);return;}
    room.dealer=nextSeat(room.dealer); startRound(room);
  });
  socket.on('newGame',()=>{
    const room=rooms.get(socket.roomCode);
    // Господар може почати нову партію з будь-якої фази (крім lobby без 4 гравців)
    if(!room||room.players[0]?.id!==socket.id) return;
    if(room.players.length!==4) return;
    room.roundIndex=0;
    room.scoreHistory=[];
    room.log=[];
    room.trick=[];
    room.winner=null;
    room.roundScores=null;
    room.trump=null;
    room.trumpCard=null;
    room.players.forEach(p=>{p.score=0;p.jokers=0;p.zeroBidStreak=0;p.bid=null;p.tricks=0;p.hand=[];p.dealtJokerThisRound=false;});
    const probe=shuffle(deck());
    const draws=[];
    let seat=0, dealer=-1;
    while(probe.length && dealer===-1){
      const card=probe.pop();
      draws.push({seat,card});
      if(!card.joker && card.rank==='A') dealer=seat;
      else seat=nextSeat(seat);
    }
    if(dealer===-1) dealer=0;
    room.dealer=dealer;
    room.lottery=draws.map(x=>({player:x.seat,card:publicCard(x.card)}));
    addLog(room,`Нова партія. Визначення здавача: ${draws.map(x=>`${room.players[x.seat].name} — ${x.card.joker?'🃏':x.card.rank+x.card.suit}`).join('; ')}.`);
    addLog(room,`Перший туз — ${room.players[room.dealer].name} здає.`);
    startRound(room);
  });
  socket.on('endGame',()=>{
    const room=rooms.get(socket.roomCode);
    if(!room||room.players[0]?.id!==socket.id) return;
    if(room.phase==='lobby'||room.phase==='gameEnd') return;
    room.phase='gameEnd';
    room.trick=[];
    room.players.forEach(p=>{p.hand=[];p.bid=null;});
    addLog(room,'Господар завершив партію.');
    emit(room);
    sendHand(room);
  });
  socket.on('leaveGame',()=>{
    const room=rooms.get(socket.roomCode);
    if(!room) return;
    const pi=playerIndex(room,socket.id);
    if(pi<0) return;
    const p=room.players[pi];
    if(p.bot) return;
    addLog(room,`${p.name} вийшов з гри.`);
    p.connected=false;
    socket.leave(room.code);
    delete socket.roomCode;
    delete socket.playerToken;
    // Якщо всі живі гравці вийшли — кімнату можна прибрати
    const humans=room.players.filter(x=>!x.bot && x.connected);
    if(humans.length===0){
      rooms.delete(room.code);
    } else {
      emit(room);
    }
  });
  socket.on('bid',({value})=>{
    const room=rooms.get(socket.roomCode); if(!room||!['bidding','prebid'].includes(room.phase))return;
    const pi=playerIndex(room,socket.id); if(pi!==room.turn)return;
    const r=room.round; const n=Number(value);
    if(!Number.isInteger(n)||n<0||n>r.cards)return;
    const p=room.players[pi];
    // Не можна замовляти 0 три рази підряд у раундах із торгами
    if(n===0 && isBiddingMode(r.mode) && (p.zeroBidStreak||0)>=2){
      addLog(room,`${p.name}: замовлення 0 заборонено (вже 2 нулі підряд).`);
      emit(room);
      return;
    }
    // Сума всіх замовлень не може дорівнювати кількості взяток (карт у руці)
    const othersSum = room.players.reduce((s,pl,i)=> i===pi ? s : s + (pl.bid??0), 0);
    const isLastBidder = room.players.filter(pl=>pl.bid!==null).length === 3;
    if(isLastBidder && othersSum + n === r.cards){
      addLog(room,`${p.name}: замовлення ${n} заборонено (сума не може = ${r.cards}).`);
      emit(room);
      return;
    }
    p.bid=n;
    addLog(room,`${p.name}: замовлення ${n}.`);
    if(allBids(room)){
      if(r.mode==='dark') beginDarkDeal(room); else beginPlaying(room);
    } else { room.turn=nextSeat(room.turn); emit(room); }
  });
  socket.on('play',({cardId,status})=>{
    const room=rooms.get(socket.roomCode); if(!room||room.phase!=='playing')return;
    const pi=playerIndex(room,socket.id); if(pi!==room.turn)return;
    const p=room.players[pi]; const idx=p.hand.findIndex(c=>c.id===cardId); if(idx<0)return;
    const card=p.hand[idx]; const allowed=validCards(room,p);
    if(!allowed.some(c=>c.id===card.id))return;
    if(card.joker){
      const isLead=room.trick.length===0;
      if(!validateJokerStatus(room,status,isLead)) return;
      card.status={...status};
      let label='джокером';
      if(status.type==='trumpHigh') label='по старших козирях';
      else if(status.type==='suit') label=`по старших ${status.suit}`;
      else if(status.type==='take') label='забрати взятку';
      else if(status.type==='asSuit') label=`як масть ${status.suit}`;
      else if(status.type==='asCard') label=`як ${status.rank}${status.suit}`;
      addLog(room,`${p.name} ходить джокером: ${label}.`);
    } else {
      delete card.status;
    }
    p.hand.splice(idx,1); room.trick.push({player:pi,card}); room.turn=nextSeat(room.turn);
    emit(room); sendHand(room);
    if(room.trick.length===4) setTimeout(()=>finishTrick(room),500);
  });
  socket.on('requestHand',()=>{const room=rooms.get(socket.roomCode);if(room)sendHand(room)});
  // --- Публічне посилання (тунель без пробросу порту) ---
  socket.on('createTunnel',async (cb)=>{
    const room=rooms.get(socket.roomCode);
    if(!room||room.players[0]?.id!==socket.id) return cb&&cb({ok:false,error:'Лише господар кімнати'});
    try{
      const url=await openPublicTunnel();
      addLog(room,`Публічне посилання: ${url}`);
      // Оновити стан усіх кімнат (publicUrl глобальний для процесу)
      for(const r of rooms.values()) emit(r);
      cb&&cb({ok:true,url});
    }catch(e){
      console.error(e);
      cb&&cb({ok:false,error:e.message||'Не вдалося відкрити тунель'});
    }
  });
  socket.on('closeTunnel',(cb)=>{
    const room=rooms.get(socket.roomCode);
    if(!room||room.players[0]?.id!==socket.id) return cb&&cb({ok:false});
    if(publicTunnel) publicTunnel.close();
    publicTunnel=null;
    for(const r of rooms.values()) emit(r);
    cb&&cb({ok:true});
  });
  // --- Текстовий чат ---
  socket.on('chat',({text})=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    const p=room.players.find(pl=>pl.id===socket.id); if(!p||p.bot) return;
    const msg=String(text||'').trim().slice(0,200);
    if(!msg) return;
    if(!room.chat) room.chat=[];
    const entry={name:p.name,text:msg,ts:Date.now()};
    room.chat.push(entry);
    if(room.chat.length>80) room.chat.shift();
    io.to(room.code).emit('chat',entry);
  });
  // --- Голосовий чат (сигналінг WebRTC) ---
  socket.on('voiceToggle',({on})=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    const p=room.players.find(pl=>pl.id===socket.id); if(!p||p.bot) return;
    p.voiceOn=!!on;
    emit(room);
    // Повідомити інших, щоб встановити/розірвати peer connections
    socket.to(room.code).emit('voicePeer',{id:socket.id,name:p.name,on:!!on});
  });
  socket.on('rtcSignal',({to,data})=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    // Переслати offer/answer/ice конкретному гравцю
    io.to(to).emit('rtcSignal',{from:socket.id,data});
  });
  socket.on('disconnect',()=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    const p=room.players.find(pl=>pl.id===socket.id && !pl.bot);
    if(!p) return;
    p.connected=false;
    p.voiceOn=false;
    addLog(room,`${p.name} відключився (можна повернутися).`);
    socket.to(room.code).emit('voicePeer',{id:socket.id,name:p.name,on:false});
    emit(room);
  });
});

function localLanUrls(scheme, port){
  const urls=[];
  const nets=os.networkInterfaces();
  for(const name of Object.keys(nets||{})){
    for(const n of nets[name]||[]){
      if(n.family==='IPv4' && !n.internal) urls.push(`${scheme}://${n.address}:${port}`);
    }
  }
  return urls;
}

function startServer(port){
  const p = port || PORT;
  // На Fly.io / Render / хмарі TLS вже на проксі — локальний HTTPS не потрібен
  const isCloud = !!(process.env.FLY_APP_NAME || process.env.RENDER || process.env.KOYEB_APP_ID || process.env.RAILWAY_ENVIRONMENT);
  return new Promise((resolve)=>{
    httpServer = http.createServer(app);
    io.attach(httpServer);

    httpServer.listen(p, '0.0.0.0', ()=>{
      activePort = httpServer.address().port;
      console.log(`HTTP:  http://0.0.0.0:${activePort}`);

      if(isCloud || process.env.DISABLE_LOCAL_HTTPS==='1'){
        console.log('Хмарний режим: зовнішній HTTPS забезпечує хостинг.');
        resolve(activePort);
        return;
      }

      const certs = ensureCerts();
      if(!certs){
        console.warn('HTTPS вимкнено (немає openssl або помилка сертифіката). Мікрофон працює лише на localhost HTTP.');
        resolve(activePort);
        return;
      }

      httpsServer = https.createServer(certs, app);
      io.attach(httpsServer);

      const tryListen = (hp)=>{
        httpsServer.once('error', (err)=>{
          if(err.code==='EADDRINUSE' && hp!==3443){
            console.warn(`Порт ${hp} зайнятий, пробуємо 3443…`);
            tryListen(3443);
          } else {
            console.warn('HTTPS не запустився:', err.message);
            resolve(activePort);
          }
        });
        httpsServer.listen(hp, '0.0.0.0', ()=>{
          activeHttpsPort = httpsServer.address().port;
          console.log(`HTTPS: https://localhost:${activeHttpsPort}`);
          const lan = localLanUrls('https', activeHttpsPort);
          if(lan.length) console.log('У мережі (телефон):', lan.join(', '));
          console.log('(У браузері прийміть попередження про self-signed сертифікат — «Додатково» → «Перейти…»)');
          resolve(activePort);
        });
      };
      tryListen(HTTPS_PORT);
    });
  });
}

async function openPublicTunnel(){
  if(publicTunnel && publicTunnel.url) return publicTunnel.url;
  let localtunnel;
  try { localtunnel = require('localtunnel'); }
  catch(e){ throw new Error('Пакет localtunnel не встановлено. Виконайте: npm install localtunnel'); }
  // Тунель на HTTP-порт — localtunnel сам дає https://…loca.lt
  const tunnel = await localtunnel({ port: activePort });
  publicTunnel = {
    url: tunnel.url,
    close: () => { try{ tunnel.close(); }catch(e){} publicTunnel = null; }
  };
  tunnel.on('close', ()=>{ publicTunnel = null; });
  tunnel.on('error', err=>{ console.error('tunnel error', err); publicTunnel = null; });
  console.log('Public URL:', tunnel.url);
  return tunnel.url;
}

if(require.main===module){
  startServer();
}

module.exports={startServer,get server(){return httpServer},app,io,PORT,HTTPS_PORT,openPublicTunnel};
