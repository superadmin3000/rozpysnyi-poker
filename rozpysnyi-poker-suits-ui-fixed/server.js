const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { execSync } = require('child_process');
const os = require('os');
const rating = require('./rating');
const auth = require('./auth');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', async (req, res)=>{
  try{ res.json(await auth.register((req.body||{}).username, (req.body||{}).password)); }
  catch(e){ res.status(500).json({ ok:false, error:String(e.message||e) }); }
});
app.post('/api/login', async (req, res)=>{
  try{ res.json(await auth.login((req.body||{}).username, (req.body||{}).password)); }
  catch(e){ res.status(500).json({ ok:false, error:String(e.message||e) }); }
});
app.get('/api/me', async (req, res)=>{
  try{
    const token = (req.headers.authorization||'').replace(/^Bearer\s+/i,'') || req.query.token;
    const user = await auth.getUserByToken(token);
    res.json({ ok:!!user, user: user||null });
  }catch(e){ res.json({ ok:false, user:null }); }
});
app.post('/api/logout', async (req, res)=>{
  try{
    const token = (req.headers.authorization||'').replace(/^Bearer\s+/i,'') || (req.body&&req.body.token);
    await auth.logout(token);
  }catch(e){}
  res.json({ ok:true });
});


// --- Рейтинг (PostgreSQL) ---
app.get('/api/ratings', async (req, res)=>{
  try{
    const limit = parseInt(req.query.limit, 10) || 20;
    const period = (req.query.period === 'month') ? 'month' : 'all';
    const month = req.query.month || null;
    res.json(await rating.getLeaderboard(limit, period, month));
  }catch(e){
    res.status(500).json({ ok:false, error:String(e.message||e), rows:[] });
  }
});
app.get('/api/rating/:name', async (req, res)=>{
  try{
    res.json({ ok:true, player: await rating.getPlayerRating(req.params.name) });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});


// --- TURN (Metered) — ПРОСТИЙ ВАРІАНТ ---
// Достатньо двох змінних (логін і пароль з кабінету Metered):
//   METERED_USERNAME=...
//   METERED_CREDENTIAL=...
// Як отримати за 2 хвилини — див. README.
// trim — часто на Render випадково додають пробіл на початку/в кінці
function env(name){
  const v = process.env[name];
  return (v==null || v==='') ? '' : String(v).trim();
}
const METERED_USERNAME = env('METERED_USERNAME') || env('TURN_USERNAME');
const METERED_CREDENTIAL = env('METERED_CREDENTIAL') || env('METERED_PASSWORD') || env('TURN_CREDENTIAL') || env('TURN_PASSWORD');
const METERED_API_KEY = env('METERED_API_KEY') || env('METERED_TURN_API_KEY');
const METERED_APP_NAME = env('METERED_APP_NAME') || env('METERED_DOMAIN');
let iceCache = { at: 0, servers: null, source: 'fallback' };

console.log('[ice] Metered username set:', !!METERED_USERNAME, '| credential set:', !!METERED_CREDENTIAL, '| apiKey set:', !!METERED_API_KEY);

function fallbackIceServers(){
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];
}

function meteredStaticIceServers(user, pass){
  const u = String(user).trim();
  const p = String(pass).trim();
  const withAuth = (urls) => ({ urls, username: u, credential: p });
  // TLS/TCP першими — критично для iPhone на мобільному інтернеті (UDP часто ріжуть)
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    withAuth('turns:standard.relay.metered.ca:443?transport=tcp'),
    withAuth('turns:global.relay.metered.ca:443?transport=tcp'),
    withAuth('turns:a.relay.metered.ca:443?transport=tcp'),
    withAuth('turn:standard.relay.metered.ca:443?transport=tcp'),
    withAuth('turn:global.relay.metered.ca:443?transport=tcp'),
    withAuth('turn:standard.relay.metered.ca:80?transport=tcp'),
    withAuth('turn:global.relay.metered.ca:80?transport=tcp'),
    withAuth('turn:standard.relay.metered.ca:443'),
    withAuth('turn:global.relay.metered.ca:443'),
    withAuth('turn:standard.relay.metered.ca:80'),
    withAuth('turn:global.relay.metered.ca:80'),
    withAuth('turn:a.relay.metered.ca:80'),
    withAuth('turn:a.relay.metered.ca:443?transport=tcp'),
    withAuth('turn:b.relay.metered.ca:80'),
    withAuth('turn:b.relay.metered.ca:443?transport=tcp')
  ];
}

async function fetchMeteredIceServers(){
  if(!METERED_API_KEY || !METERED_APP_NAME) return null;
  const appName = METERED_APP_NAME.replace(/\.metered\.live$/i, '').trim();
  const url = `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Metered HTTP '+res.status);
  const data = await res.json();
  if(!Array.isArray(data) || !data.length) throw new Error('Metered empty response');
  return data;
}

app.get('/api/ice', async (req, res)=>{
  try{
    const now = Date.now();
    if(iceCache.servers && (now - iceCache.at) < 4*60*1000){
      return res.json({ iceServers: iceCache.servers, source: iceCache.source || 'cache' });
    }
    let servers = null;
    let source = 'fallback';

    // 1) Найточніший варіант — API key конкретного TURN credential.
    // Metered сам повертає правильні hostname/порти для тарифу та регіону.
    if(METERED_API_KEY && METERED_APP_NAME){
      try{
        servers = await fetchMeteredIceServers();
        source = 'metered-api';
      }catch(e){
        console.warn('[ice] Metered API failed:', e.message);
      }
    }
    // 2) Резервний варіант: статичні username/password.
    if(!servers && METERED_USERNAME && METERED_CREDENTIAL){
      servers = meteredStaticIceServers(METERED_USERNAME, METERED_CREDENTIAL);
      source = 'metered-static';
    }
    if(!servers){
      servers = fallbackIceServers();
      source = 'fallback';
    }
    iceCache = { at: now, servers, source };
    console.log('[ice] serving source=', source, 'servers=', servers.length);
    res.json({
      iceServers: servers,
      source,
      configured: source.startsWith('metered')
    });
  }catch(e){
    console.error('[ice]', e);
    res.json({ iceServers: fallbackIceServers(), source: 'fallback-error', configured: false });
  }
});

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || (PORT + 443 > 65535 ? 3443 : PORT === 3000 ? 3443 : PORT + 443);
let activePort = PORT;
let activeHttpsPort = null;
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
  ...Array.from({length:9},(_,i)=>({name:String(i+1), cards:i+1, mode:'normal'})),
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
function addLog(room,msg){ room.log.push(msg); if(room.log.length>120) room.log.shift(); }
function cardLabel(c){
  if(!c) return '?';
  if(c.joker){
    const s=c.status;
    if(!s) return '🃏';
    if(s.type==='trumpHigh') return '🃏 по козирях';
    if(s.type==='suit') return `🃏 по ${s.suit}`;
    if(s.type==='give'||s.type==='giveSuit') return s.suit?`🃏 віддати ${s.suit}`:'🃏 віддати';
    if(s.type==='take') return '🃏 забрати';
    if(s.type==='asSuit') return `🃏 як ${s.suit}`;
    if(s.type==='asCard') return `🃏 як ${s.rank}${s.suit}`;
    return '🃏';
  }
  return `${c.rank}${c.suit}`;
}
function currentPlayer(room){ return room.players[room.turn]; }
function isBiddingMode(mode){ return mode==='normal'||mode==='dark'||mode==='notrump'; }
function publicCard(c){
  if(!c) return c;
  return {id:c.id,suit:c.suit,rank:c.rank,joker:!!c.joker,status:c.status||null};
}
/** Актуальний id господаря (після reconnect hostId може застаріти) */
function resolveHostId(room){
  if(!room||!room.players||!room.players.length) return null;
  if(room.hostId && room.players.some(p=>p.id===room.hostId && !p.bot)) return room.hostId;
  if(room.hostToken){
    const hp=room.players.find(p=>!p.bot && p.token===room.hostToken);
    if(hp){ room.hostId=hp.id; return hp.id; }
  }
  // fallback: перший живий людина, інакше players[0]
  const human=room.players.find(p=>!p.bot&&p.connected)||room.players.find(p=>!p.bot)||room.players[0];
  if(human){ room.hostId=human.id; if(human.token) room.hostToken=human.token; }
  return human?human.id:null;
}
function isRoomHost(room, socketId){
  return resolveHostId(room)===socketId;
}
function publicState(room){
  return {
    code:room.code,
    hostId:resolveHostId(room),
    kickVotes:room.kickVotes || {},
    roundIndex:room.roundIndex,
    round:ROUND_TYPES[room.roundIndex],
    phase:room.phase,
    dealer:room.dealer,
    leader:room.leader,
    turn:room.turn,
    trump:room.trump,
    trumpCard:publicCard(room.trumpCard),
    players:room.players.map((p,i)=>({
      id:p.id,name:p.name,seat:i,connected:p.connected,score:p.score,registered:!!p.userId,
      bid:p.bid,tricks:p.tricks,cards:p.hand.length,bot:!!p.bot,
      jokers:p.jokers||0,
      zeroBidStreak:p.zeroBidStreak||0
    })),
    spectators:(room.spectators||[]).filter(s=>s.connected!==false).map(s=>({id:s.id,name:s.name})),
    botDifficulty: room.botDifficulty || 'medium',
    hasPassword: !!(room.password && String(room.password).length),
    trick:room.trick.map(x=>({player:x.player,card:publicCard(x.card)})),
    lastTrick:Array.isArray(room.lastTrick)?room.lastTrick.map(x=>({
      player:x.player,
      card:publicCard(x.card),
      winner:!!x.winner
    })):[],
    lastTrickWinner: typeof room.lastTrickWinner==='number' ? room.lastTrickWinner : null,
    winner:room.winner,
    roundScores:room.roundScores,
    scoreHistory:room.scoreHistory||[],
    lastRatingDelta:room.lastRatingDelta||null,
    lottery:room.lottery||[],
    log:room.log.slice(-30),
    chat:[],
    voiceOn:(()=>{
      const players=(room.players||[]).filter(p=>p.voiceOn && p.connected && !p.bot).map(p=>({id:p.id,name:p.name}));
      const specs=(room.spectators||[]).filter(s=>s.voiceOn && s.connected!==false).map(s=>({id:s.id,name:s.name||'SuperAdmin'}));
      return players.concat(specs);
    })(),
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
// У раунді mode==='notrump' козиря немає завжди — карту з колоди не показуємо.
function chooseTrump(room){
  const top=room.trumpCard;
  if(room.round.mode==='notrump'){
    room.trump=null;
    room.trumpCard=null; // щоб UI не показував джокер/карту як «козир»
    return;
  }
  room.trump = (!top || top.joker) ? null : top.suit;
}
function deal(room){
  const r=room.round;
  room.deck=shuffle(deck());
  room.trumpCard=null;
  room._playedHistory=[];
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
  room.lastTrick=[]; room.lastTrickWinner=null;
  room.players.forEach(p=>{p.hand=[];p.bid=null;p.tricks=0;p.dealtJokerThisRound=false;});
}
function startRound(room){
  const r=ROUND_TYPES[room.roundIndex];
  room.round=r;
  room.phase='prebid';
  room.winner=null;
  room.trick=[];
  room.lastTrick=[];
  room.lastTrickWinner=null;
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
  // «Віддати джокер» з заходу — джокер не бере, але масть обов’язкова (ведуча)
  if((s.type==='give' || s.type==='giveSuit') && s.suit) return {type:'give',suit:s.suit};
  if(s.type==='give' || s.type==='giveSuit') return {type:'give'};
  return null;
}
function validateJokerStatus(room,status,isLead){
  if(!status||!status.type) return false;
  if(isLead){
    // Захід: по козирях / по старшій масті / віддати джокер за масть (не бере)
    if(status.type==='trumpHigh') return !!room.trump;
    if(status.type==='suit') return SUITS.includes(status.suit);
    // При заході «віддати» масть обов’язкова
    if(status.type==='give' || status.type==='giveSuit') return SUITS.includes(status.suit);
    return false;
  }
  // Не з заходу: забрати, віддати джокер, або скинути як масть/карту
  if(status.type==='take') return true;
  if(status.type==='give' || status.type==='giveSuit') return true;
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
  // «Віддати джокер» з заходу: масть має пріоритет; якщо її немає — обов’язковий козир.
  if(rule?.type==='give' && rule.suit){
    const suited=p.hand.filter(c=>!c.joker&&c.suit===rule.suit);
    if(suited.length) return suited.concat(jokers);
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
    // «По старшій масті»: джокер бере, якщо ніхто не поклав козир
    const trumps=trick.filter(x=>!x.card.joker&&room.trump&&x.card.suit===room.trump&&rule.suit!==room.trump);
    if(trumps.length)
      return trumps.reduce((a,b)=>basePower(a.card,room.trump,room.trump)>=basePower(b.card,room.trump,room.trump)?a:b);
    return jEntry || trick[0];
  }
  if(rule?.type==='give'){
    // «Віддати джокер» за масть S: масть обов’язкова; без неї обов’язковий козир.
    // Взятку бере найстарша карта заявленої масті, якщо її не перебив козир;
    // якщо заявлену масть ніхто не поклав — найстарший козир, інакше джокер.
    const leadSuit=rule.suit||null;
    const ofSuit=leadSuit ? trick.filter(x=>!x.card.joker && x.card.suit===leadSuit) : [];
    const trumps=room.trump ? trick.filter(x=>!x.card.joker && x.card.suit===room.trump) : [];
    if(ofSuit.length){
      const bestSuit=ofSuit.reduce((best,entry)=>(VALUE[entry.card.rank]??0)>=(VALUE[best.card.rank]??0)?entry:best);
      const beatingTrumps=trumps.filter(x=>room.trump!==leadSuit);
      if(beatingTrumps.length) return beatingTrumps.reduce((a,b)=>basePower(a.card,room.trump,leadSuit)>=basePower(b.card,room.trump,leadSuit)?a:b);
      return bestSuit;
    }
    if(trumps.length) return trumps.reduce((a,b)=>basePower(a.card,room.trump,leadSuit)>=basePower(b.card,room.trump,leadSuit)?a:b);
    // Немає заявленої масті й козирів — взятку забирає джокер
    return jEntry || trick[0];
  }

  // Звичайна взятка / джокер не з заходу
  const first=trick[0];
  const leadSuit=first.card.joker?null:first.card.suit;
  return trick.reduce((best,entry)=>{
    const power=(e)=>{
      const c=e.card;
      if(c.joker){
        const s=c.status;
        // «Віддати джокер» — ніколи не бере взятку
        if(s&&(s.type==='give'||s.type==='giveSuit')) return -1;
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
  if(room.phase!=='playing') return;
  // Захист: якщо з якоїсь причини накопичилось >4 — беремо лише перші 4
  if(room.trick.length<4) return;
  if(room.trick.length>4){
    console.warn('finishTrick: trick overflow', room.trick.length, '— обрізаємо до 4');
    room.trick=room.trick.slice(0,4);
  }
  if(room._finishingTrick) return;
  room._finishingTrick=true;
  try{
    const completed=room.trick.slice();
    const w=winnerOf(room,completed);
    room.winner=w.player;
    room.players[w.player].tricks++;
    addLog(room,`${room.players[w.player].name} бере взятку.`);
    if(!room._playedHistory) room._playedHistory=[];
    for(const x of completed) if(x&&x.card) room._playedHistory.push({suit:x.card.suit,rank:x.card.rank,joker:!!x.card.joker,id:x.card.id});
    // Зберегти останню взятку для відображення
    room.lastTrick=completed.map(x=>({
      player:x.player,
      card:x.card,
      winner:x.player===w.player
    }));
    room.lastTrickWinner=w.player;
    room.trick=[];
    room.leader=w.player;
    room.turn=w.player;
    if(room.players.every(p=>p.hand.length===0)) finishRound(room);
    else { emit(room); sendHand(room); }
  } finally {
    room._finishingTrick=false;
  }
}
/** Покласти карту у взятку; повертає false якщо хід відхилено */
function pushToTrick(room, playerIndex, card){
  if(room.phase!=='playing') return false;
  if(room._finishingTrick) return false;
  if(room.trick.length>=4){
    // вже повна взятка — негайно закрити, нову карту не приймати
    finishTrick(room);
    return false;
  }
  room.trick.push({player:playerIndex, card});
  return true;
}


async function applyGameRatings(room){
  if(!room || room._ratingsApplied) return;
  room._ratingsApplied = true;
  try{
    const list = (room.players||[]).map(p=>({ name:p.name, score:p.score||0, bot:!!p.bot }));
    const applied = await rating.recordGameResults(list);
    if(applied && applied.length){
      const msg = applied.map(a=>`${a.name} ${a.delta>=0?'+':''}${a.delta}→${a.rating}`).join(' · ');
      addLog(room, '📊 Рейтинг: '+msg);
      room.lastRatingDelta = applied;
    }
  }catch(e){
    console.warn('[rating] applyGameRatings', e.message);
  }
}

// ========== BOTS ==========
const BOT_NAMES = ['Бот Алекс','Бот Оля','Бот Макс','Бот Іра','Бот Сергій','Бот Настя'];
function scheduleBot(room){
  if(!room || !['bidding','prebid','playing'].includes(room.phase)) return;
  // Повна взятка — спочатку закрити, ботів не планувати
  if(room.phase==='playing' && room.trick.length>=4){
    if(!room._finishingTrick) setTimeout(()=>finishTrick(room), 0);
    return;
  }
  const p = room.players[room.turn];
  if(!p || !p.bot) return;
  if(room._botTimer) clearTimeout(room._botTimer);
  const diff = botDiff(room);
  const delay = diff==='hard'
    ? 700 + Math.floor(Math.random()*900)
    : 500 + Math.floor(Math.random()*700);
  room._botTimer = setTimeout(()=> botAct(room), delay);
}
function botAct(room){
  if(!room || !rooms.has(room.code)) return;
  if(room.phase==='playing' && room.trick.length>=4){
    if(!room._finishingTrick) finishTrick(room);
    return;
  }
  if(room._finishingTrick) return;
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
function bySuitMap(hand){
  const m={}; for(const s of SUITS) m[s]=[];
  for(const c of hand){ if(!c.joker) m[c.suit].push(c); }
  for(const s of SUITS) m[s].sort((a,b)=>rankVal(b)-rankVal(a));
  return m;
}

/** Карти, уже зіграні в раунді (з усіх зроблених трюків + поточний) */
function playedCards(room){
  const out=[];
  if(room._playedHistory) out.push(...room._playedHistory);
  for(const x of room.trick||[]) if(x&&x.card) out.push(x.card);
  return out;
}

/** Скільки старших за `rank` ще «живі» у масті (не в нашій руці і не зіграні) */
function higherOutstanding(room, hand, suit, rank){
  const ranks=['6','7','8','9','10','J','Q','K','A'];
  const rv=VALUE[rank]??0;
  let n=0;
  for(const r of ranks){
    if((VALUE[r]??0)<=rv) continue;
    const stillMine = hand.some(c=>!c.joker&&c.suit===suit&&c.rank===r);
    const stillPlayed = playedCards(room).some(c=>!c.joker&&c.suit===suit&&c.rank===r);
    if(!stillMine && !stillPlayed) n++;
  }
  return n;
}

/** Оцінка сили руки → очікувані взятки (покращена для hard) */
function estimateTricks(hand, trump, mode){
  if(!hand || !hand.length) return 0;
  let score = 0;
  const bySuit = bySuitMap(hand);
  const jokers = hand.filter(c=>c.joker);
  if(jokers.length) score += 1.15 * jokers.length;

  if(mode==='misere'){
    let risk=0;
    if(jokers.length) risk += 1.15 * jokers.length;
    for(const s of SUITS){
      const arr=bySuit[s];
      if(!arr.length) continue;
      const hi=rankVal(arr[0]);
      if(hi>=8) risk+=1.0;
      else if(hi>=7) risk+=0.7;
      else if(hi>=5) risk+=0.35;
      if(arr.length>=4) risk+=0.4;
      if(arr.length===1 && hi>=7) risk+=0.3;
      // довга масть без фігур теж небезпечна (хтось кине і ви змушені)
      if(arr.length>=5 && hi<5) risk+=0.25;
    }
    return risk;
  }

  for(const s of SUITS){
    const arr=bySuit[s];
    if(!arr.length) continue;
    const isTrump = trump && s===trump;
    // послідовність старших «зверху» (A, K, Q...) — майже гарантовані взятки
    let consecutive = 0;
    for(let expect = 8; expect >= 0; expect--){
      if(arr.some(c=>rankVal(c)===expect)) consecutive++;
      else break;
    }
    if(isTrump){
      score += consecutive * 0.95;
      for(const c of arr){
        const v=rankVal(c);
        if(v>=8) continue; // уже в consecutive
        if(v>=7) score+=0.85;
        else if(v>=5) score+=0.55;
        else if(v>=3) score+=0.35;
        else score+=0.18;
      }
      if(arr.length>=3) score += 0.45*(arr.length-2);
    } else if(mode==='notrump' || !trump){
      score += consecutive * 0.9;
      for(const c of arr){
        const v=rankVal(c);
        if(v>=8) continue;
        if(v>=7) score+=0.5;
        else if(v>=5 && arr.length<=2) score+=0.22;
        else if(v>=5 && arr.length>=4) score+=0.3;
      }
      if(arr.length>=4) score += 0.28*(arr.length-3);
    } else {
      // звичайний з козирем: side-масті
      score += consecutive * 0.75;
      for(const c of arr){
        const v=rankVal(c);
        if(v>=8) continue;
        if(v>=7 && arr.length<=2) score+=0.32;
        else if(v>=5 && arr.length===1) score+=0.12;
      }
      // коротка масть (void-building)
      if(arr.length===1 && rankVal(arr[0])<5) score+=0.1;
      if(arr.length===2 && rankVal(arr[0])<5) score+=0.05;
    }
  }
  if(trump){
    const voids = SUITS.filter(s=>s!==trump && bySuit[s].length===0).length;
    const trN = bySuit[trump].length;
    score += Math.min(voids, trN)*0.45;
    const sings = SUITS.filter(s=>s!==trump && bySuit[s].length===1).length;
    score += Math.min(sings, Math.max(0,trN-voids))*0.18;
  }
  // обмеження: не більше карт у руці
  return Math.max(0, Math.min(hand.length, score));
}

function botDiff(room){
  const d = room.botDifficulty || 'medium';
  if(d==='easy' || d==='hard') return d;
  return 'medium';
}

function botBid(room, p){
  const r = room.round;
  const nMax = r.cards;
  const othersSum = room.players.reduce((s,pl,i)=> i===room.turn ? s : s + (pl.bid??0), 0);
  const isLast = room.players.filter(pl=>pl.bid!==null).length === 3;
  const blockZero = isBiddingMode(r.mode) && (p.zeroBidStreak||0)>=2;
  const diff = botDiff(room);
  const knownBids = room.players.filter(pl=>pl.bid!==null).map(pl=>pl.bid);
  const avgKnown = knownBids.length ? knownBids.reduce((a,b)=>a+b,0)/knownBids.length : null;

  let estimate;
  if(r.mode==='dark' || room.phase==='prebid'){
    if(diff==='easy') estimate = Math.floor(Math.random()*(nMax+1));
    else if(diff==='hard'){
      // Темна hard: ~1/4–1/3, але сильніше тягнеться до «середнього столу», щоб не ламати банк
      let base = nMax<=2 ? 0.4 : nMax*0.27;
      if(avgKnown!=null) base = base*0.45 + avgKnown*0.55;
      // якщо вже багато замовлено — ще консервативніше
      if(othersSum >= nMax) base = Math.min(base, 0.3);
      estimate = Math.max(0, Math.round(base + (Math.random()*0.5-0.15)));
    } else {
      estimate = Math.max(0, Math.round(nMax*0.22 + Math.random()*1.2 - 0.3));
    }
  } else if(r.mode==='gold' || r.mode==='misere'){
    estimate = 0;
  } else {
    const raw = estimateTricks(p.hand, room.trump, r.mode);
    if(diff==='easy'){
      estimate = Math.round(raw + (Math.random()*3 - 1.5));
      if(Math.random()<0.25) estimate = Math.floor(Math.random()*(nMax+1));
    } else if(diff==='hard'){
      // точна оцінка + ситуація на столі (скільки вже замовлено)
      let adj = raw;
      const hasJ = p.hand.some(c=>c.joker);
      const trN = room.trump ? p.hand.filter(c=>!c.joker&&c.suit===room.trump).length : 0;
      if(hasJ) adj += 0.15;
      if(trN>=3) adj += 0.15;
      if(trN>=5) adj += 0.2;
      // якщо стіл уже «перевантажений» замовленнями — граємо нижче
      if(othersSum > nMax * 0.9) adj -= 0.55;
      else if(othersSum > nMax * 0.6) adj -= 0.25;
      // якщо стіл порожній (мало замовлено) і рука сильна — можна +1
      if(othersSum < nMax * 0.35 && raw >= nMax * 0.5) adj += 0.2;
      estimate = Math.round(adj);
      // майже без шуму (hard = передбачувано сильний)
      if(Math.random()<0.08) estimate -= 1;
    } else {
      estimate = Math.round(raw*0.92 + (Math.random()*0.6-0.2));
    }
  }
  estimate = Math.max(0, Math.min(nMax, estimate));

  if(blockZero && estimate===0) estimate=1;

  if(isLast && othersSum + estimate === nMax){
    if(diff==='hard'){
      // hard: відхиляємось у бік ближчий до оцінки сили (не завжди +1)
      const upOk = estimate+1<=nMax;
      const downOk = estimate-1>=(blockZero?1:0);
      if(upOk && downOk){
        // якщо оцінка була «висока» відносно nMax — краще -1 (точніше влучити)
        estimate = (estimate >= nMax*0.4) ? estimate-1 : estimate+1;
      } else if(upOk) estimate++;
      else if(downOk) estimate--;
      else {
        for(let d=1;d<=nMax;d++){
          if(estimate+d<=nMax && othersSum+(estimate+d)!==nMax){ estimate+=d; break; }
          if(estimate-d>=(blockZero?1:0) && othersSum+(estimate-d)!==nMax){ estimate-=d; break; }
        }
      }
    } else {
      if(estimate+1 <= nMax) estimate++;
      else if(estimate-1 >= (blockZero?1:0)) estimate--;
      else {
        for(let d=1;d<=nMax;d++){
          if(estimate+d<=nMax && othersSum+(estimate+d)!==nMax){ estimate+=d; break; }
          if(estimate-d>=(blockZero?1:0) && othersSum+(estimate-d)!==nMax){ estimate-=d; break; }
        }
      }
    }
  }

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
  const counts={};
  for(const s of SUITS) counts[s]=0;
  for(const c of p.hand){ if(!c.joker) counts[c.suit]=(counts[c.suit]||0)+1; }
  let longSuit=SUITS[0], longN=-1, shortSuit=SUITS[0], shortN=99;
  for(const s of SUITS){
    if(room.trump && s===room.trump) continue;
    const n=counts[s]||0;
    if(n>longN){ longN=n; longSuit=s; }
    if(n<shortN){ shortN=n; shortSuit=s; }
  }
  // для hard: якщо віддаємо — масть де у нас найслабше (коротка),
  // якщо беремо з заходу без козиря — довга масть для контролю
  if(isLead){
    if(wantTrick && room.trump) return {type:'trumpHigh'};
    if(wantTrick) return {type:'suit', suit:longSuit};
    return {type:'give', suit: shortN<99 ? shortSuit : SUITS[0]};
  }
  if(wantTrick) return {type:'take'};
  return {type:'give'};
}

/** Чи карта майже гарантовано забирає, якщо ходити з неї */
function isNearCertainWinner(room, hand, card, trump){
  if(!card || card.joker) return true;
  const suit = card.suit;
  const higher = higherOutstanding(room, hand, suit, card.rank);
  if(higher===0) return true;
  // козирний туз — майже завжди
  if(trump && suit===trump && rankVal(card)>=8) return true;
  return false;
}

/** Найкраща карта для «скидання» (не брати): коротка масть, низький ранг, не чіпати козир без потреби */
function bestDumpCard(room, p, nonJ, trump){
  const by = bySuitMap(p.hand);
  let best=null, bestKey=1e9;
  for(const c of nonJ){
    const isTr = trump && c.suit===trump;
    const len = by[c.suit] ? by[c.suit].length : 1;
    // пріоритет: некозир, коротка масть, низький ранг; штраф за фігури
    let key = (isTr ? 100 : 0) + len*12 + rankVal(c);
    if(rankVal(c)>=7) key += 25;
    if(rankVal(c)>=5) key += 8;
    // якщо масть довга і карта низька — трохи краще тримати довжину для контролю? ні, при dump краще з короткої
    if(key < bestKey){ bestKey=key; best=c; }
  }
  return best || (nonJ.length ? lowestCard(nonJ) : null);
}

/** Мінімальна карта, що все ще б'є поточну взятку */
function cheapestWinner(winners){
  if(!winners.length) return null;
  return winners.reduce((b,c)=> rankVal(c)<rankVal(b)?c:b);
}

/** Hard: захід */
function hardLead(room, p, nonJ, jokers, mustTake, mode, trump){
  const by = bySuitMap(p.hand);
  const remaining = p.hand.length;

  if(mustTake || mode==='gold'){
    const trumps = trump ? nonJ.filter(c=>c.suit===trump) : [];

    // 1) Гарантовані взятки: чисті старші (0 higher outstanding)
    const certain = nonJ.filter(c=> isNearCertainWinner(room, p.hand, c, trump));
    if(certain.length){
      // спочатку козирні певні, потім side-тузи з короткої масті
      certain.sort((a,b)=>{
        const at = trump && a.suit===trump ? 0 : 1;
        const bt = trump && b.suit===trump ? 0 : 1;
        if(at!==bt) return at-bt;
        const la=by[a.suit].length, lb=by[b.suit].length;
        if(la!==lb) return la-lb;
        return rankVal(b)-rankVal(a);
      });
      return {card: certain[0]};
    }

    // 2) Козирний туз / старший козир
    if(trumps.length){
      const top = highestCard(trumps);
      if(rankVal(top)>=7) return {card: top};
    }

    // 3) Side-туз з найкоротшої масті (будуємо void під козир)
    const sideAces = nonJ.filter(c=>c.rank==='A' && (!trump || c.suit!==trump));
    if(sideAces.length){
      sideAces.sort((a,b)=> by[a.suit].length - by[b.suit].length);
      return {card: sideAces[0]};
    }

    // 4) Довга масть зі старшою — «вибивати» масть
    let best=null, bestScore=-1e9;
    for(const s of SUITS){
      if(trump && s===trump) continue;
      const arr=by[s].filter(c=> nonJ.some(n=>n.id===c.id));
      if(!arr.length) continue;
      const hi=arr[0];
      const sc = rankVal(hi)*1.2 + arr.length*0.5 - higherOutstanding(room, p.hand, s, hi.rank)*0.8;
      if(sc>bestScore){ bestScore=sc; best=hi; }
    }
    if(best && bestScore>2) return {card: best};

    // 5) Козир середній
    if(trumps.length) return {card: highestCard(trumps)};

    // 6) Джокер — лише якщо немає гідної карти (беремо)
    if(jokers.length && remaining<=3) return {card: jokers[0], status: botPickJokerStatus(room,p,true)};
    if(nonJ.length) return {card: highestCard(nonJ)};
    if(jokers.length) return {card: jokers[0], status: botPickJokerStatus(room,p,true)};
  } else {
    // Не треба взяток / мізер: ходити «сміттям», будувати void, НЕ ходити тузом
    let best=null, bestKey=1e9;
    for(const s of SUITS){
      if(trump && s===trump) continue;
      const arr = by[s].filter(c=> nonJ.some(n=>n.id===c.id));
      if(!arr.length) continue;
      const low = lowestCard(arr);
      let key = arr.length*10 + rankVal(low);
      if(rankVal(low)>=7) key += 80; // ніколи не ходи з A/K коли скидаєш
      if(rankVal(low)>=5) key += 20;
      if(key<bestKey){ bestKey=key; best=low; }
    }
    if(best) return {card: best};
    const tr = trump ? nonJ.filter(c=>c.suit===trump) : [];
    if(tr.length) return {card: lowestCard(tr)};
    if(jokers.length) return {card: jokers[0], status: botPickJokerStatus(room,p,false)};
    if(nonJ.length) return {card: lowestCard(nonJ)};
  }
  return null;
}

/** Hard: відповідь */
function hardFollow(room, p, nonJ, jokers, mustTake, mustDump, mode, trump, need, remainingTricks){
  const winners = nonJ.filter(c=> wouldWin(room, c, null));
  const losers = nonJ.filter(c=> !wouldWin(room, c, null));
  const afterUs = Math.max(0, 3 - room.trick.length); // скільки ще ходять після нас
  const desperate = mustTake && need >= remainingTricks;
  const curWin = currentTrickWinner(room);
  const leadSuit = room.trick[0] && room.trick[0].card && !room.trick[0].card.joker
    ? room.trick[0].card.suit
    : (room.trick[0] && room.trick[0].card && room.trick[0].card.status && room.trick[0].card.status.suit)
      ? room.trick[0].card.status.suit
      : null;

  if(mustTake || mode==='gold'){
    if(winners.length){
      // Найдешевша переможна, якщо не desperation
      let pick = cheapestWinner(winners);
      if(desperate) pick = highestCard(winners);
      else if(afterUs===0){
        // ми останні — достатньо мінімальної, що б'є
        pick = cheapestWinner(winners);
      } else if(afterUs>=2 && winners.length>1){
        // рано у взятці — не світити туза, якщо є дешевша що б'є
        pick = cheapestWinner(winners);
      }
      return {card: pick};
    }
    // Немає звичайного переможця
    // Джокер: тільки якщо реально треба (золото / відчай / мало трюків лишилось)
    if(jokers.length){
      const useJoker = mode==='gold' || desperate || need >= remainingTricks || (need>0 && remainingTricks<=2);
      if(useJoker) return {card: jokers[0], status:{type:'take'}};
    }
    // скинути найменш цінне
    if(losers.length) return {card: bestDumpCard(room, p, losers, trump) || lowestCard(losers)};
    if(nonJ.length) return {card: bestDumpCard(room, p, nonJ, trump) || lowestCard(nonJ)};
    if(jokers.length) return {card: jokers[0], status:{type: mode==='gold' ? 'take' : 'give'}};
  } else {
    // Не треба брати (або мізер): ніколи не брати, якщо можна
    if(losers.length){
      return {card: bestDumpCard(room, p, losers, trump) || lowestCard(losers)};
    }
    // змушені «перемагати» — віддати джокером або найменшою
    if(jokers.length) return {card: jokers[0], status:{type:'give'}};
    if(nonJ.length) return {card: lowestCard(nonJ)};
  }
  return null;
}

function botPlay(room, p){
  const allowed = validCards(room, p);
  if(!allowed.length) return;
  const r = room.round;
  const mode = r.mode;
  const diff = botDiff(room);
  const bid = p.bid??0;
  const need = bid - (p.tricks||0);
  const remainingTricks = p.hand.length;
  // Золота: завжди беремо максимум взяток; Мізер: завжди скидаємо
  let mustTake = mode==='gold' || need > 0;
  let mustDump = mode==='misere' || (need <= 0 && mode!=='gold');
  let desperate = mode==='gold' || (mustTake && need >= remainingTricks);

  // Легкий: інколи плутає ціль
  if(diff==='easy' && mode!=='gold' && mode!=='misere'){
    if(Math.random()<0.28){ mustTake = !mustTake; mustDump = !mustDump; }
    if(Math.random()<0.2) desperate = false;
  }

  const jokers = allowed.filter(c=>c.joker);
  const nonJ = allowed.filter(c=>!c.joker);
  const isLead = room.trick.length===0;
  const trump = room.trump;

  // Легкий: часто випадкова легальна карта
  if(diff==='easy' && Math.random()<0.4){
    let card = allowed[Math.floor(Math.random()*allowed.length)];
    let status=null;
    if(card.joker){
      status = botPickJokerStatus(room, p, Math.random()<0.5);
      if(!validateJokerStatus(room, status, isLead)){
        status = isLead
          ? (room.trump ? {type:'trumpHigh'} : {type:'suit', suit:SUITS[0]})
          : {type:'take'};
      }
      card.status = {...status};
    } else delete card.status;
    const idx = p.hand.findIndex(c=>c.id===card.id);
    if(idx<0) return;
    if(room.trick.length>=4){ finishTrick(room); return; }
    p.hand.splice(idx,1);
    if(!pushToTrick(room, room.turn, card)){
      p.hand.push(card); // відкат
      return;
    }
    addLog(room, `${p.name}: ${cardLabel(card)}`);
    const full=room.trick.length>=4;
    if(!full) room.turn = nextSeat(room.turn);
    emit(room); sendHand(room);
    if(full) setTimeout(()=>finishTrick(room), 500);
    return;
  }

  let card=null;
  let status=null;

  // ===== HARD: окрема стратегія =====
  if(diff==='hard'){
    let pick=null;
    if(isLead){
      pick = hardLead(room, p, nonJ, jokers, mustTake||mode==='gold', mode, trump);
    } else {
      pick = hardFollow(room, p, nonJ, jokers, mustTake, mustDump, mode, trump, need, remainingTricks);
    }
    if(pick){ card=pick.card; status=pick.status||null; }
  }

  // --- medium / fallback: МІЗЕР / скидання ---
  if(!card && mustDump && !desperate){
    if(nonJ.length){
      const nonTr = trump ? nonJ.filter(c=>c.suit!==trump) : nonJ;
      const pool = nonTr.length ? nonTr : nonJ;
      card = lowestCard(pool);
    } else if(jokers.length){
      card = jokers[0];
      status = botPickJokerStatus(room, p, false);
    }
  }

  // --- medium: ЗАХІД ---
  if(!card && isLead){
    if(mustTake || mode==='gold'){
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
      const nonTr = trump ? nonJ.filter(c=>c.suit!==trump) : nonJ;
      const pool = nonTr.length ? nonTr : nonJ;
      if(pool.length) card = lowestCard(pool);
      else if(jokers.length){ card=jokers[0]; status=botPickJokerStatus(room,p,false); }
    }
  }

  // --- medium: ВІДПОВІДЬ ---
  if(!card && !isLead){
    const winners = nonJ.filter(c=> wouldWin(room, c, null));
    const losers = nonJ.filter(c=> !wouldWin(room, c, null));

    if(mustTake || mode==='gold'){
      if(winners.length){
        card = winners.reduce((b,c)=> rankVal(c)<rankVal(b)?c:b);
        if(desperate) card = highestCard(winners);
      } else if(jokers.length && (mode==='gold' || desperate || need>0)){
        card = jokers[0];
        status = {type:'take'};
      } else if(nonJ.length){
        card = lowestCard(nonJ);
      } else if(jokers.length){
        card = jokers[0];
        status = {type: mode==='gold' ? 'take' : 'give'};
      }
    } else {
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
      if(isLead){
        if(mustTake || mode==='gold')
          status = room.trump ? {type:'trumpHigh'} : {type:'suit', suit:SUITS[0]};
        else
          status = {type:'give', suit:SUITS[0]};
      } else {
        status = {type: (mustTake || mode==='gold') ? 'take' : 'give'};
      }
    }
    // На Золотій ніколи не віддаємо джокер
    if(mode==='gold' && (status.type==='give'||status.type==='giveSuit')){
      status = isLead
        ? (room.trump ? {type:'trumpHigh'} : {type:'suit', suit:status.suit||SUITS[0]})
        : {type:'take'};
    }
    card.status = {...status};
  } else {
    delete card.status;
  }

  const idx = p.hand.findIndex(c=>c.id===card.id);
  if(idx<0) return;
  if(room.trick.length>=4){ finishTrick(room); return; }
  p.hand.splice(idx,1);
  if(!pushToTrick(room, room.turn, card)){
    p.hand.push(card);
    return;
  }
  addLog(room, `${p.name}: ${cardLabel(card)}`);
  const full=room.trick.length>=4;
  if(!full) room.turn = nextSeat(room.turn);
  emit(room); sendHand(room);
  if(full) setTimeout(()=>finishTrick(room), 500);
}

/** Публічний список кімнат (без паролів) */
function listRoomsPublic(){
  const out=[];
  for(const room of rooms.values()){
    const host=room.players.find(p=>!p.bot)||room.players[0];
    const humans=room.players.filter(p=>!p.bot).length;
    const bots=room.players.filter(p=>p.bot).length;
    const offline=room.players.filter(p=>!p.bot && !p.connected).map(p=>p.name);
    const onlineHumans=room.players.filter(p=>!p.bot && p.connected).length;
    // У лобі — вільні місця; під час гри — можна повернутися зі своїм ніком якщо хтось offline
    const joinable = (room.phase==='lobby' && room.players.length<4) || offline.length>0;
    out.push({
      code: room.code,
      host: host?host.name:'—',
      players: room.players.length,
      humans,
      online: onlineHumans,
      bots,
      max: 4,
      phase: room.phase,
      phaseLabel: ({lobby:'Лобі',prebid:'Гра',bidding:'Гра',playing:'Гра',roundEnd:'Гра',gameEnd:'Фініш'})[room.phase]||room.phase,
      hasPassword: !!(room.password && String(room.password).length),
      offlineNames: offline,
      joinable
    });
  }
  out.sort((a,b)=>{
    if(a.joinable!==b.joinable) return a.joinable?-1:1;
    return a.code.localeCompare(b.code);
  });
  return out;
}
function broadcastRoomList(){
  io.emit('roomList', listRoomsPublic());
}

io.on('connection',socket=>{
  // Одразу віддати список кімнат новому клієнту
  socket.emit('roomList', listRoomsPublic());

  socket.on('listRooms',(cb)=>{
    const list=listRoomsPublic();
    if(typeof cb==='function') cb({ok:true,rooms:list});
    else socket.emit('roomList', list);
  });

  function normalizeName(n){
    return String(n||'').trim().replace(/\s+/g,' ').slice(0,20);
  }
  function namesEqual(a,b){
    return normalizeName(a).toLowerCase() === normalizeName(b).toLowerCase();
  }
  function isSuperAdminName(n){
    return normalizeName(n).toLowerCase()==='superadmin';
  }
  function checkRoomPassword(room, password){
    if(!room.password) return true;
    return password!=null && String(password) === room.password;
  }
  function ensureSpectators(room){
    if(!room.spectators) room.spectators=[];
    return room.spectators;
  }
  function attachSpectator(socket, room, existing, displayName){
    const specs=ensureSpectators(room);
    let sp=existing || specs.find(s=>s.id===socket.id);
    if(!sp){
      sp={id:socket.id,token:crypto.randomBytes(8).toString('hex'),name:displayName||'SuperAdmin',connected:true,voiceOn:false};
      specs.push(sp);
    } else {
      sp.id=socket.id;
      sp.connected=true;
      sp.token=crypto.randomBytes(8).toString('hex');
      if(displayName) sp.name=displayName;
      // voiceOn зберігаємо, якщо вже був увімкнений до reconnect
      if(typeof sp.voiceOn!=='boolean') sp.voiceOn=false;
    }
    socket.join(room.code);
    socket.roomCode=room.code;
    socket.playerToken=sp.token;
    socket.isSpectator=true;
    return sp;
  }
  /** Усі учасники голосу: гравці + спостерігачі SuperAdmin */
  function voiceParticipants(room){
    const players=(room.players||[])
      .filter(p=>p.voiceOn && p.connected && !p.bot)
      .map(p=>({id:p.id,name:p.name}));
    const specs=(room.spectators||[])
      .filter(s=>s.voiceOn && s.connected!==false)
      .map(s=>({id:s.id,name:s.name||'SuperAdmin'}));
    return players.concat(specs);
  }
  function findVoiceMember(room, socketId){
    const p=(room.players||[]).find(pl=>pl.id===socketId && !pl.bot);
    if(p) return {kind:'player', ref:p};
    const s=(room.spectators||[]).find(sp=>sp.id===socketId);
    if(s) return {kind:'spectator', ref:s};
    return null;
  }
  /** Прив’язати сокет до існуючого гравця (перепідключення) */
  function attachSocketToPlayer(socket, room, p, {rotateToken}={}){
    const wasHost = (room.hostId && room.hostId===p.id)
      || (room.hostToken && room.hostToken===p.token)
      || (room.players[0]===p);
    // Якщо старий сокет ще «живий» на іншому пристрої — він втратить місце
    p.id = socket.id;
    p.connected = true;
    p.voiceOn = false;
    if(rotateToken) p.token = crypto.randomBytes(8).toString('hex');
    if(wasHost){
      room.hostId = p.id;
      room.hostToken = p.token;
    }
    socket.join(room.code);
    socket.roomCode = room.code;
    socket.playerToken = p.token;
    return p.token;
  }

  socket.on('createRoom',async ({name,password,authToken},cb)=>{
    if(typeof cb!=='function') cb=()=>{};
    let displayName = normalizeName(name) || 'Гравець';
    let userId = null;
    if(authToken){
      try{
        const u = await auth.getUserByToken(authToken);
        if(u){ userId = u.id; displayName = normalizeName(u.name) || displayName; }
      }catch(e){}
    }
    if(isSuperAdminName(displayName)){
      return cb({ok:false,error:'SuperAdmin лише спостерігає — приєднайтесь до існуючої кімнати'});
    }
    let code; do code=id(); while(rooms.has(code));
    const pwd = (password!=null && String(password).trim()) ? String(password).trim().slice(0,32) : '';
    const token=crypto.randomBytes(8).toString('hex');
    const room={
      code,hostId:socket.id,hostToken:token,kickVotes:{},roundIndex:0,round:ROUND_TYPES[0],phase:'lobby',dealer:0,leader:0,turn:0,
      trump:null,trumpCard:null,players:[],trick:[],deck:[],winner:null,roundScores:null,
      scoreHistory:[],log:[],chat:[],botDifficulty:'medium',password:pwd
    };
    const p={id:socket.id,token,name:displayName,score:0,bid:null,tricks:0,hand:[],connected:true,bot:false,jokers:0,zeroBidStreak:0,userId:userId||null};
    room.players.push(p); rooms.set(code,room); socket.join(code); socket.roomCode=code; socket.playerToken=token;
    socket.emit('hand',[]); emit(room); cb({ok:true,code,token,hasPassword:!!pwd,name:displayName});
    broadcastRoomList();
  });
  socket.on('joinRoom',async ({code,name,password,authToken},cb)=>{
    if(typeof cb!=='function') cb=()=>{};
    const room=rooms.get((code||'').trim().toUpperCase());
    if(!room) return cb({ok:false,error:'Кімнату не знайдено'});
    let displayName = normalizeName(name) || `Гравець ${room.players.length+1}`;
    let userId = null;
    if(authToken){
      try{
        const u = await auth.getUserByToken(authToken);
        if(u){ userId = u.id; displayName = normalizeName(u.name) || displayName; }
      }catch(e){}
    }

    // --- SuperAdmin: спостерігач у будь-якій кімнаті, без участі в грі ---
    if(isSuperAdminName(displayName)){
      ensureSpectators(room);
      // Перепідключення існуючого спостерігача з тим самим сокетом/ніком
      let existingSpec=room.spectators.find(s=>namesEqual(s.name,'SuperAdmin') && (!s.connected || s.id===socket.id));
      if(!existingSpec){
        // Якщо інший SuperAdmin уже online — дозволяємо другого спостерігача
        existingSpec=null;
      }
      const sp=attachSpectator(socket, room, existingSpec, 'SuperAdmin');
      addLog(room, `👁 SuperAdmin спостерігає за кімнатою.`);
      cb({ok:true,code:room.code,token:sp.token,name:'SuperAdmin',spectator:true});
      // Персональний прапорець для клієнта
      socket.emit('state', Object.assign({}, publicState(room), {spectator:true}));
      socket.emit('hand',[]);
      emit(room);
      broadcastRoomList();
      return;
    }

    // --- Повернення в гру за тим самим ніком (з іншого пристрою / після обриву) ---
    const existing = room.players.find(pl => !pl.bot && namesEqual(pl.name, displayName));
    if(existing){
      if(existing.connected && existing.id !== socket.id){
        // Якщо сокет «живий», але гравець реально offline — дозволимо перехопити через кілька спроб
        // Інакше — нік зайнятий активним гравцем
        const oldSock = io.sockets.sockets.get(existing.id);
        if(oldSock && oldSock.connected){
          return cb({ok:false,error:'Цей нік уже в грі. Якщо це ви — зачекайте кілька секунд після виходу і спробуйте знову.'});
        }
        // старий сокет мертвий, а connected ще true — виправляємо
        existing.connected = false;
      }
      if(!checkRoomPassword(room, password)){
        return cb({ok:false,error:'Невірний пароль',needPassword:true});
      }
      const token = attachSocketToPlayer(socket, room, existing, {rotateToken:true});
      // Зберігаємо оригінальний регістр ніка з кімнати
      addLog(room, `${existing.name} повернувся в гру.`);
      cb({ok:true,code:room.code,token,name:existing.name,rejoined:true});
      emit(room);
      sendHand(room);
      broadcastRoomList();
      return;
    }

    if(!checkRoomPassword(room, password)){
      return cb({ok:false,error:'Невірний пароль',needPassword:true});
    }

    // Новий гравець може зайняти місце будь-якого бота навіть після початку гри.
    // Стан місця (очки, карти, замовлення та взятки) зберігається, змінюється лише керування.
    const botSeat = room.players.find(pl => pl.bot);
    if(botSeat){
      const token=crypto.randomBytes(8).toString('hex');
      const oldBotName=botSeat.name;
      botSeat.id=socket.id;
      botSeat.token=token;
      botSeat.name=displayName;
      botSeat.bot=false;
      botSeat.connected=true;
      botSeat.voiceOn=false;
      socket.join(room.code); socket.roomCode=room.code; socket.playerToken=token;
      if(!room.kickVotes) room.kickVotes={};
      for(const id of Object.keys(room.kickVotes)) room.kickVotes[id]=room.kickVotes[id].filter(v=>v!==socket.id);
      addLog(room,`${displayName} приєднався до кімнати та зайняв місце ${oldBotName}.`);
      cb({ok:true,code:room.code,token,name:displayName,replacedBot:true});
      emit(room); sendHand(room); broadcastRoomList();
      return;
    }

    // Якщо ботів немає, нові гравці можуть приєднатися лише до початку партії.
    if(room.phase!=='lobby') return cb({ok:false,error:'Гра вже розпочата, а вільних місць ботів немає.'});
    if(room.players.length>=4) return cb({ok:false,error:'Кімната вже заповнена'});
    const token=crypto.randomBytes(8).toString('hex');
    const p={id:socket.id,token,name:displayName,score:0,bid:null,tricks:0,hand:[],connected:true,bot:false,jokers:0,zeroBidStreak:0,userId:userId||null};
    room.players.push(p); socket.join(room.code); socket.roomCode=room.code; socket.playerToken=token;
    cb({ok:true,code:room.code,token,name:displayName}); emit(room);
    broadcastRoomList();
  });
  // Господар може видалити гравця до початку першої роздачі.
  socket.on('kickPlayer',({targetId},cb)=>{
    if(typeof cb!=='function') cb=()=>{};
    const room=rooms.get(socket.roomCode);
    if(!room) return cb({ok:false,error:'Кімнату не знайдено'});
    if(!isRoomHost(room, socket.id)) return cb({ok:false,error:'Лише господар кімнати'});
    if(room.phase!=='lobby') return cb({ok:false,error:'Викидати гравців можна лише до початку першої роздачі'});
    const index=room.players.findIndex(p=>p.id===targetId);
    if(index<0) return cb({ok:false,error:'Гравця не знайдено'});
    if(room.players[index].id===resolveHostId(room)) return cb({ok:false,error:'Не можна викинути господаря кімнати'});
    const [removed]=room.players.splice(index,1);
    const oldSocket=io.sockets.sockets.get(removed.id);
    if(oldSocket){ oldSocket.leave(room.code); delete oldSocket.roomCode; delete oldSocket.playerToken; oldSocket.emit('removedFromRoom',{reason:'Господар кімнати видалив вас до початку гри.'}); }
    addLog(room,`${removed.name} видалено з кімнати господарем.`);
    emit(room); broadcastRoomList(); cb({ok:true});
  });

  // Голосування «Мінус ПІДАР»: більшість інших людей (включно з офлайн-людьми в знаменнику лише онлайн для голосу) замінює гравця ботом.
  socket.on('voteKick',({targetId},cb)=>{
    if(typeof cb!=='function') cb=()=>{};
    try{
      const room=rooms.get(socket.roomCode);
      if(!room) return cb({ok:false,error:'Кімнату не знайдено'});
      if(!['prebid','bidding','playing','roundEnd'].includes(room.phase))
        return cb({ok:false,error:'Голосування доступне під час гри'});

      const voter=room.players.find(p=>p.id===socket.id && !p.bot);
      if(!voter) return cb({ok:false,error:'Ви не є гравцем кімнати'});
      if(!voter.connected) return cb({ok:false,error:'Спочатку перепідключіться до гри'});

      // Можна голосувати і проти офлайн-гравця (AFK)
      const target=room.players.find(p=>p.id===targetId && !p.bot);
      if(!target) return cb({ok:false,error:'Цього гравця не можна обрати'});
      if(target.id===voter.id) return cb({ok:false,error:'Не можна голосувати проти себе'});

      if(!room.kickVotes) room.kickVotes={};
      // Один гравець — один голос; перенесення голосу на іншого кандидата
      for(const id of Object.keys(room.kickVotes)){
        room.kickVotes[id]=(room.kickVotes[id]||[]).filter(v=>v!==socket.id);
        if(room.kickVotes[id].length===0) delete room.kickVotes[id];
      }
      if(!room.kickVotes[targetId]) room.kickVotes[targetId]=[];
      room.kickVotes[targetId].push(socket.id);

      // Голосувати можуть лише підключені люди; у знаменнику — усі інші люди (крім цілі), щоб 1 з 3 не викидав сам
      const otherHumans=room.players.filter(p=>!p.bot && p.id!==target.id);
      const onlineVoters=otherHumans.filter(p=>p.connected);
      const eligible=Math.max(otherHumans.length, onlineVoters.length, 1);
      const votes=room.kickVotes[targetId].length;
      const needed=Math.floor(eligible/2)+1;

      addLog(room,`${voter.name} проголосував(ла) «Мінус ПІДАР» проти ${target.name} (${votes}/${needed}).`);

      if(votes>=needed){
        const oldId=target.id;
        const oldName=target.name;
        const oldToken=target.token;
        const botId='bot-'+crypto.randomBytes(3).toString('hex');
        target.id=botId;
        target.name=`Бот (${oldName})`;
        target.bot=true;
        target.connected=true;
        target.voiceOn=false;
        target.token=null;

        if(room.hostId===oldId || (oldToken && room.hostToken===oldToken)){
          const nextHost=room.players.find(p=>!p.bot && p.connected && p.id!==botId)
            || room.players.find(p=>!p.bot && p.id!==botId)
            || room.players[0];
          room.hostId=nextHost?nextHost.id:null;
          room.hostToken=nextHost&&nextHost.token?nextHost.token:null;
        }

        const oldSocket=io.sockets.sockets.get(oldId);
        if(oldSocket){
          oldSocket.leave(room.code);
          delete oldSocket.roomCode;
          delete oldSocket.playerToken;
          oldSocket.emit('removedFromRoom',{reason:'Гравці проголосували «Мінус ПІДАР» — вас замінено ботом.'});
        }

        // Прибрати всі голоси
        room.kickVotes={};
        addLog(room,`${target.name} замінив «${oldName}» після більшості голосів.`);
        emit(room);
        sendHand(room);
        broadcastRoomList();
        // Якщо зараз хід нового бота — він має зіграти
        scheduleBot(room);
        return cb({ok:true,removed:true,votes,needed});
      }

      emit(room);
      return cb({ok:true,removed:false,votes,needed});
    }catch(e){
      console.error('voteKick error',e);
      return cb({ok:false,error:'Помилка сервера при голосуванні'});
    }
  });

  // Господар може змінити/зняти пароль у лобі
  socket.on('setRoomPassword',({password},cb)=>{
    if(typeof cb!=='function') cb=()=>{};
    const room=rooms.get(socket.roomCode);
    if(!room) return cb({ok:false,error:'Немає кімнати'});
    if(!isRoomHost(room, socket.id)) return cb({ok:false,error:'Лише господар'});
    if(room.phase!=='lobby') return cb({ok:false,error:'Лише в лобі'});
    room.password = (password!=null && String(password).trim()) ? String(password).trim().slice(0,32) : '';
    addLog(room, room.password ? 'Господар встановив пароль на кімнату.' : 'Господар зняв пароль з кімнати.');
    emit(room);
    broadcastRoomList();
    cb({ok:true,hasPassword:!!room.password});
  });
  // Перепідключення по токену (той самий пристрій) або по ніку+код (будь-який пристрій)
  socket.on('reconnectRoom',({code,token,name,password},cb)=>{
    if(typeof cb!=='function') cb=()=>{};
    const room=rooms.get((code||'').trim().toUpperCase());
    if(!room) return cb({ok:false,error:'Кімнату не знайдено'});

    // SuperAdmin / spectator reconnect
    if(isSuperAdminName(name) || (token && (room.spectators||[]).some(s=>s.token===token))){
      ensureSpectators(room);
      let sp=(token && room.spectators.find(s=>s.token===token))
        || room.spectators.find(s=>namesEqual(s.name,'SuperAdmin'));
      sp=attachSpectator(socket, room, sp, 'SuperAdmin');
      cb({ok:true,code:room.code,token:sp.token,name:'SuperAdmin',spectator:true,rejoined:true});
      socket.emit('state', Object.assign({}, publicState(room), {spectator:true}));
      socket.emit('hand',[]);
      emit(room);
      broadcastRoomList();
      return;
    }

    let p = null;
    if(token) p = room.players.find(pl=>pl.token===token && !pl.bot);
    if(!p && name){
      p = room.players.find(pl => !pl.bot && namesEqual(pl.name, name));
      if(p){
        // за ніком потрібен пароль, якщо кімната захищена
        if(!checkRoomPassword(room, password)){
          return cb({ok:false,error:'Невірний пароль',needPassword:true});
        }
        // не забираємо місце в активного гравця з живим сокетом
        if(p.connected){
          const oldSock = io.sockets.sockets.get(p.id);
          if(oldSock && oldSock.connected && p.id !== socket.id){
            return cb({ok:false,error:'Цей нік уже в грі на іншому пристрої.'});
          }
        }
      }
    }
    if(!p) return cb({ok:false,error:'Сесію не знайдено. Увійдіть з тим самим ім’ям і кодом кімнати.'});

    const newToken = attachSocketToPlayer(socket, room, p, {rotateToken: !token || p.token !== token});
    addLog(room,`${p.name} повернувся в гру.`);
    cb({ok:true,code:room.code,token:newToken,name:p.name,rejoined:true});
    emit(room);
    sendHand(room);
    broadcastRoomList();
  });
  socket.on('setBotDifficulty',({level})=>{
    const room=rooms.get(socket.roomCode);
    if(!room||!isRoomHost(room, socket.id)) return;
    const lv=String(level||'').toLowerCase();
    if(!['easy','medium','hard'].includes(lv)) return;
    room.botDifficulty=lv;
    const labels={easy:'Легка',medium:'Середня',hard:'Складна'};
    addLog(room,`Складність ботів: ${labels[lv]}.`);
    emit(room);
  });
  socket.on('addBot',()=>{
    const room=rooms.get(socket.roomCode);
    if(!room||room.phase!=='lobby'||!isRoomHost(room, socket.id)) return;
    if(room.players.length>=4) return;
    const usedNames = new Set(room.players.map(p=>p.name));
    const name = BOT_NAMES.find(n=>!usedNames.has(n)) || `Бот ${room.players.length}`;
    const botId = 'bot-' + crypto.randomBytes(3).toString('hex');
    const p={id:botId,name,score:0,bid:null,tricks:0,hand:[],connected:true,bot:true,jokers:0,zeroBidStreak:0};
    room.players.push(p);
    addLog(room, `${name} приєднався до кімнати.`);
    emit(room);
    broadcastRoomList();
  });
  socket.on('startGame',()=>{
    const room=rooms.get(socket.roomCode); if(!room||room.players.length!==4||!isRoomHost(room, socket.id))return;
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
    broadcastRoomList();
  });
  socket.on('startNextRound',()=>{
    const room=rooms.get(socket.roomCode); if(!room||room.phase!=='roundEnd'||!isRoomHost(room, socket.id))return;
    room.roundIndex++;
    if(room.roundIndex>=ROUND_TYPES.length){
      room.phase='gameEnd';
      const ranked=[...room.players].sort((a,b)=>b.score-a.score);
      const top=ranked[0];
      const second=ranked[1];
      if(top){
        const margin=second!=null?(top.score-second.score):0;
        let congrats=`🏆 Переможець — ${top.name} з ${top.score} очками!`;
        if(margin>=50) congrats+=` Впевнена перемога (+${margin}).`;
        else if(margin<=5 && second) congrats+=` Напружена боротьба з ${second.name}!`;
        else if(second) congrats+=` Вітаємо!`;
        addLog(room, congrats);
        addLog(room, `Підсумок: ${ranked.map((p,i)=>`${i+1}. ${p.name} ${p.score}`).join(' · ')}`);
      } else {
        addLog(room,'Партію завершено.');
      }
      applyGameRatings(room).then(()=>emit(room)).catch(()=>emit(room));
      return;
    }
    room.dealer=nextSeat(room.dealer); startRound(room);
  });
  socket.on('newGame',()=>{
    const room=rooms.get(socket.roomCode);
    // Господар може почати нову партію з будь-якої фази (крім lobby без 4 гравців)
    if(!room||!isRoomHost(room, socket.id)) return;
    if(room.players.length!==4) return;
    room._ratingsApplied=false;
    room.lastRatingDelta=null;
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
    if(!room||!isRoomHost(room, socket.id)) return;
    if(room.phase==='lobby'||room.phase==='gameEnd') return;
    room.phase='gameEnd';
    room.trick=[];
    room.players.forEach(p=>{p.hand=[];p.bid=null;});
    const ranked=[...room.players].sort((a,b)=>b.score-a.score);
    const top=ranked[0];
    addLog(room,'Господар завершив партію.');
    if(top) addLog(room,`🏆 Лідер на момент завершення — ${top.name} (${top.score}). ${ranked.map((p,i)=>`${i+1}. ${p.name} ${p.score}`).join(' · ')}`);
    applyGameRatings(room).then(()=>{ emit(room); sendHand(room); }).catch(()=>{ emit(room); sendHand(room); });
  });
  socket.on('leaveGame',()=>{
    const room=rooms.get(socket.roomCode);
    if(!room) return;
    // Спостерігач SuperAdmin
    const specs=room.spectators||[];
    const si=specs.findIndex(s=>s.id===socket.id);
    if(si>=0){
      const sp=specs[si];
      if(sp.voiceOn) socket.to(room.code).emit('voicePeer',{id:socket.id,name:sp.name||'SuperAdmin',on:false});
      specs.splice(si,1);
      socket.leave(room.code);
      delete socket.roomCode;
      delete socket.playerToken;
      delete socket.isSpectator;
      emit(room);
      broadcastRoomList();
      return;
    }
    const pi=playerIndex(room,socket.id);
    if(pi<0) return;
    const p=room.players[pi];
    if(p.bot) return;
    addLog(room,`${p.name} самостійно вийшов(ла) з кімнати.`);
    p.voiceOn=false;
    socket.leave(room.code);
    delete socket.roomCode;
    delete socket.playerToken;
    if(room.phase==='lobby'||room.phase==='gameEnd'){
      room.players.splice(pi,1);
      if(room.hostId===p.id || room.hostToken===p.token){
        const nh=room.players.find(x=>!x.bot&&x.connected)||room.players.find(x=>!x.bot)||room.players[0];
        room.hostId=nh?nh.id:null;
        room.hostToken=nh&&nh.token?nh.token:null;
      }
      if(room.players.length===0){ rooms.delete(room.code); }
      else emit(room);
    } else {
      // Зберігаємо місце за столом і поточну руку, щоб гра могла тривати з ботом.
      const oldId=p.id;
      const oldToken=p.token;
      p.id='bot-'+crypto.randomBytes(3).toString('hex');
      p.name=`Бот (${p.name})`; p.bot=true; p.connected=true; p.token=null;
      if(room.hostId===oldId || room.hostToken===oldToken){
        const nh=room.players.find(x=>!x.bot&&x.connected)||room.players.find(x=>!x.bot)||room.players[0];
        room.hostId=nh?nh.id:null;
        room.hostToken=nh&&nh.token?nh.token:null;
      }
      room.kickVotes={};
      emit(room); sendHand(room);
    }
    broadcastRoomList();
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
    if(room._finishingTrick || room.trick.length>=4){
      if(room.trick.length>=4) finishTrick(room);
      return;
    }
    const pi=playerIndex(room,socket.id); if(pi!==room.turn)return;
    const p=room.players[pi]; const idx=p.hand.findIndex(c=>c.id===cardId); if(idx<0)return;
    const card=p.hand[idx]; const allowed=validCards(room,p);
    if(!allowed.some(c=>c.id===card.id))return;
    if(card.joker){
      const isLead=room.trick.length===0;
      if(!validateJokerStatus(room,status,isLead)) return;
      card.status={...status};
    } else {
      delete card.status;
    }
    p.hand.splice(idx,1);
    if(!pushToTrick(room, pi, card)){
      p.hand.push(card);
      return;
    }
    addLog(room,`${p.name}: ${cardLabel(card)}`);
    const full=room.trick.length>=4;
    if(!full) room.turn=nextSeat(room.turn);
    emit(room); sendHand(room);
    if(full) setTimeout(()=>finishTrick(room),500);
  });
  socket.on('requestHand',()=>{const room=rooms.get(socket.roomCode);if(room)sendHand(room)});
  // --- Емодзі-реакції поверх іконки гравця ---
  socket.on('chatBubble',({text})=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    if(!text || typeof text!=='string') return;
    const clean=String(text).replace(/\s+/g,' ').trim().slice(0,48);
    if(!clean) return;
    // rate limit ~1 msg / 0.6s per socket
    const now=Date.now();
    if(socket._lastChatAt && now-socket._lastChatAt<600) return;
    socket._lastChatAt=now;
    let playerIndex=-1;
    let name='Гравець';
    const pi=room.players.findIndex(p=>p.id===socket.id);
    if(pi>=0){ playerIndex=pi; name=room.players[pi].name||name; }
    else if(room.spectators){
      const sp=room.spectators.find(x=>x.id===socket.id);
      if(sp){ name=sp.name||'SuperAdmin'; playerIndex=-1; }
      else return;
    } else return;
    io.to(room.code).emit('chatBubble',{
      text:clean,
      playerIndex,
      playerId:socket.id,
      name
    });
  });
    socket.on('emojiReaction',({emoji})=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    if(!emoji || typeof emoji!=='string') return;
    // обмежити довжину (один-два символи / сурогатна пара)
    const clean=String(emoji).slice(0,8);
    if(!clean.trim()) return;
    const pi=room.players.findIndex(p=>p.id===socket.id && !p.bot);
    const sp=(room.spectators||[]).find(s=>s.id===socket.id);
    if(pi<0 && !sp) return;
    const playerIndex=pi>=0?pi:null;
    const name=pi>=0?room.players[pi].name:(sp.name||'SuperAdmin');
    io.to(room.code).emit('emojiReaction',{
      emoji:clean,
      playerIndex,
      playerId:socket.id,
      name
    });
  });
  // --- Текстовий чат ---
  // --- Голосовий чат (сигналінг WebRTC full-mesh) ---
  // Гравці + спостерігачі SuperAdmin можуть говорити/чути
  socket.on('voiceToggle',({on})=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    const member=findVoiceMember(room, socket.id);
    if(!member) return;
    if(member.kind==='player' && member.ref.bot) return;
    member.ref.voiceOn=!!on;
    const name=member.ref.name||(member.kind==='spectator'?'SuperAdmin':'Гравець');
    emit(room);
    // Усім у кімнаті (гравці + спостерігачі)
    io.to(room.code).emit('voicePeer',{id:socket.id,name,on:!!on});
    // Повний список усім, хто в ефірі (включно з тим, хто щойно ввімкнув)
    const list=voiceParticipants(room);
    for(const v of list){
      io.to(v.id).emit('voiceSync',{list});
    }
    // Якщо вимкнув — все одно скажи іншим оновити mesh через state/voicePeer
  });
  // PCM-голос через Socket.IO (fallback для iPhone / мобільного інтернету)
    socket.on('voiceBlob',(payload)=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    const member=findVoiceMember(room, socket.id);
    if(!member) return;
    if(member.kind==='player' && member.ref.bot) return;
    if(!member.ref.voiceOn) return;
    if(!payload || !payload.data) return;
    const size = payload.data.byteLength || payload.data.length || 0;
    if(size<10 || size>64000) return;
    const list=voiceParticipants(room);
    for(const v of list){
      if(v.id===socket.id) continue;
      try{
        io.to(v.id).emit('voiceBlob', {
          from: socket.id,
          mime: payload.mime || 'audio/mp4',
          data: payload.data
        });
      }catch(e){}
    }
  });
  socket.on('voicePcm', (payload)=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    const member=findVoiceMember(room, socket.id);
    if(!member) return;
    if(member.kind==='player' && member.ref.bot) return;
    if(!member.ref.voiceOn) return;
    // payload: ArrayBuffer | Buffer | {data: ...}
    let data = payload;
    if(payload && payload.data) data = payload.data;
    if(!data) return;
    // ліміт ~50 пакетів/с на клієнта; тут м'який захист розміру
    const size = data.byteLength || data.length || 0;
    if(size<2 || size>16000) return;
    const list=voiceParticipants(room);
    for(const v of list){
      if(v.id===socket.id) continue;
      try{ io.to(v.id).emit('voicePcm', { from: socket.id, data }); }catch(e){}
    }
  });
    socket.on('rtcSignal',({to,data})=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    if(!to||!data) return;
    const fromMember=findVoiceMember(room, socket.id);
    if(!fromMember) return;
    const targetPlayer=room.players.find(pl=>pl.id===to && !pl.bot);
    const targetSpec=(room.spectators||[]).find(s=>s.id===to);
    if(!targetPlayer && !targetSpec) return;
    // Одна доставка (без дубля — дубль ламав negotiation)
    try{
      const targetSock = io.sockets.sockets.get(to);
      if(targetSock) targetSock.emit('rtcSignal',{from:socket.id,data});
      else io.to(to).emit('rtcSignal',{from:socket.id,data});
    }catch(e){
      io.to(to).emit('rtcSignal',{from:socket.id,data});
    }
  });
  // Запит: «хто зараз у голосі?»
  socket.on('voiceSync',()=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    socket.emit('voiceSync',{list:voiceParticipants(room)});
  });
  socket.on('disconnect',()=>{
    const room=rooms.get(socket.roomCode); if(!room) return;
    // Спостерігач
    if(room.spectators){
      const sp=room.spectators.find(s=>s.id===socket.id);
      if(sp){
        const wasVoice=!!sp.voiceOn;
        sp.connected=false;
        sp.voiceOn=false;
        if(wasVoice) socket.to(room.code).emit('voicePeer',{id:socket.id,name:sp.name||'SuperAdmin',on:false});
        emit(room);
        broadcastRoomList();
        return;
      }
    }
    const p=room.players.find(pl=>pl.id===socket.id && !pl.bot);
    if(!p) return;
    p.connected=false;
    p.voiceOn=false;
    // Не залишаємо голоси від відключеного гравця або за нього.
    if(room.kickVotes){
      delete room.kickVotes[p.id];
      for(const candidateId of Object.keys(room.kickVotes)){
        room.kickVotes[candidateId]=room.kickVotes[candidateId].filter(voterId=>voterId!==p.id);
        if(room.kickVotes[candidateId].length===0) delete room.kickVotes[candidateId];
      }
    }
    addLog(room,`${p.name} відключився (можна повернутися з тим самим ніком).`);
    socket.to(room.code).emit('voicePeer',{id:socket.id,name:p.name,on:false});
    emit(room);
    broadcastRoomList();
  });
});

// Прибрати «мертві» кімнати без людей (після 2 год порожнечі під час гри)
setInterval(()=>{
  const now=Date.now();
  let changed=false;
  for(const [code,room] of rooms){
    const online=room.players.some(p=>!p.bot && p.connected);
    if(online){ room._emptySince=null; continue; }
    if(!room._emptySince) room._emptySince=now;
    const age=now-room._emptySince;
    // лобі без людей — 10 хв; активна партія — 2 год
    const limit = room.phase==='lobby' ? 3*60*1000 : (room.phase==='gameEnd' ? 1*60*1000 : 10*60*1000);
    if(age>=limit){ rooms.delete(code); changed=true; }
  }
  if(changed) broadcastRoomList();
}, 60*1000);

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
  try{ rating.initRatingDb(); }catch(e){ console.warn('[rating] init', e&&e.message); }
  try{ auth.initAuthDb(); }catch(e){ console.warn('[auth] init', e&&e.message); }
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

if(require.main===module){
  startServer();
}

module.exports={startServer,get server(){return httpServer},app,io,PORT,HTTPS_PORT};
