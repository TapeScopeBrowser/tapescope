// TapeScope v0.9 — raw prints + raw OHLC. No derived analytics.
// Everything on screen is either a print exactly as Vest reported it, or OHLC built
// directly from those prints (or Vest's own klines, shown separately — never mixed).
const $=id=>document.getElementById(id);
const WS='wss://ws.hz.vestmarkets.com/ws?version=1.0';
const GW='https://api-gateway.hz.vestmarkets.com';
const V2='https://server-prod.hz.vestmarkets.com/v2';
const C={bg:'#15191f',line:'#2a303b',ink:'#dfe3ea',mute:'#8a919e',up:'74,127,208',dn:'200,90,98',flat:'138,145,158',now:'#f2f2f2'};
const KL={60000:'1m',180000:'3m',300000:'5m',900000:'15m',1800000:'30m',3600000:'1h'};
const KLINE_MAX=501; // /v2/klines ignores startTime/endTime and only ever returns the latest 501 bars
const MAX_PRINTS=400000,TAPE_ROWS=120,RM=72,BM=20,PAD=.035;

let ws=null,retry=null,ping=null,symbol='',tick=.25,dec=2,gen=0,loadTok=null;
let prints=[],seen=new Set(),recvTimes=[];
let bars=[],barsKey='',klines={tf:0,bars:[],at:0};
let follow=true,right=0,yMan=null,drag=null,hover=null,dirty=true,tapeDirty=true,view=null,tapeTopKey=null;

const mode=()=>$('mode').value,src=()=>$('src').value,tfMs=()=>+$('tf').value||60000;
const spanMs=()=>(+$('span').value||1800)*1000,histMs=()=>(+$('hist').value||7200)*1000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function setStatus(s,cls=''){$('status').textContent=s;$('status').parentElement.className='status '+cls}
function note(s){$('histstatus').textContent=s}
function px(n,d=dec){return Number.isFinite(n)?n.toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d}):'—'}
function num(n){return Number.isFinite(n)?String(n):'—'}
function hms(t,ms=true){const d=new Date(t);return d.toLocaleTimeString('en-US',{hour12:false})+(ms?'.'+String(d.getMilliseconds()).padStart(3,'0'):'')}
function dur(ms){const m=Math.floor(ms/60000),h=Math.floor(m/60);return h?`${h}h ${String(m%60).padStart(2,'0')}m`:m?`${m}m ${String(Math.floor(ms/1000)%60).padStart(2,'0')}s`:`${Math.floor(ms/1000)}s`}
function sideCls(s){return s==='buy'?'up':s==='sell'?'dn':''}
function sideRgb(s){return s==='buy'?C.up:s==='sell'?C.dn:C.flat}

// ---- prints ---------------------------------------------------------------
// REST ids look like "prod:103:41396591:0", websocket ids like "<hash>:41396591:0".
// The trailing "seq:index" pair is shared by both, so it is the dedup key.
function parse(d,now){
  if(!d||typeof d!=='object')return null;
  const price=+d.price,time=+d.time;if(!Number.isFinite(price)||!Number.isFinite(time))return null;
  const id=String(d.id??''),m=id.match(/:(\d+):(\d+)$/);
  return {k:m?m[1]+':'+m[2]:(id||[d.time,d.price,d.qty,d.side].join('|')),s:m?+m[1]:0,i:m?+m[2]:0,id,time,price,
    qty:+d.qty,quote:d.quoteQty==null?NaN:+d.quoteQty,side:String(d.side??'').toLowerCase(),recv:now};
}
const cmp=(a,b)=>a.time-b.time||a.s-b.s||a.i-b.i;
function lower(a,t){let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m].time<t)lo=m+1;else hi=m}return lo}
function upper(a,t){let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m].time<=t)lo=m+1;else hi=m}return lo}
function trim(){if(prints.length<=MAX_PRINTS)return;for(const p of prints.splice(0,prints.length-MAX_PRINTS+20000))seen.delete(p.k);barsKey=''}
function addLive(p){
  if(seen.has(p.k))return false;seen.add(p.k);
  const n=prints.length;
  if(!n||cmp(p,prints[n-1])>=0){prints.push(p);barPush(p)}
  else{prints.splice(upper(prints,p.time),0,p);barsKey=''}
  trim();return true;
}
function addMany(arr){let added=0;for(const p of arr){if(seen.has(p.k))continue;seen.add(p.k);prints.push(p);added++}
  if(added){prints.sort(cmp);trim();barsKey=''}return added}

// ---- candles --------------------------------------------------------------
function newBar(t,p){return {time:t,open:p.price,high:p.price,low:p.price,close:p.price,n:1}}
function extend(b,p){if(p.price>b.high)b.high=p.price;if(p.price<b.low)b.low=p.price;b.close=p.price;b.n++}
function barPush(p){
  if(barsKey!=='trades|'+tfMs())return;
  const tf=tfMs(),t=Math.floor(p.time/tf)*tf,b=bars[bars.length-1];
  if(b&&b.time===t)extend(b,p);else if(!b||t>b.time)bars.push(newBar(t,p));else barsKey='';
}
function currentBars(){
  const tf=tfMs();
  if(src()==='klines')return klines.tf===tf?klines.bars:[];
  if(barsKey!=='trades|'+tf){bars=[];for(const p of prints){const t=Math.floor(p.time/tf)*tf,b=bars[bars.length-1];if(b&&b.time===t)extend(b,p);else bars.push(newBar(t,p))}barsKey='trades|'+tf}
  return bars;
}

// ---- REST -----------------------------------------------------------------
async function getInfo(){try{const j=await (await fetch(GW+'/v3/exchangeInfo')).json(),x=(j.symbols||[]).find(x=>x.symbol===symbol);
  if(x){tick=+(x.minTickSize??x.tickSizes?.[0])||tick;if(Number.isInteger(x.priceDecimals))dec=x.priceDecimals}}catch(e){}$('tick').textContent=String(tick)}

// Pages backwards with endTime. Keeps endTime = oldest seen (not oldest-1) so prints sharing
// the boundary millisecond are not skipped; duplicates are removed by key.
async function fetchTrades(start,g,onPage){
  let end=Date.now();const out=[];
  for(let i=0;i<400;i++){
    const u=new URL(GW+'/v3/trades');u.search=new URLSearchParams({symbol,limit:'1000',endTime:String(Math.floor(end))});
    const r=await fetch(u);if(!r.ok)throw new Error('trades HTTP '+r.status);
    const j=await r.json();if(g!==gen)return null;
    const pg=Array.isArray(j)?j:(j.data||j.trades||[]);if(!pg.length)break;
    let oldest=Infinity;const now=Date.now();
    for(const d of pg){const p=parse(d,now);if(!p)continue;if(p.time<oldest)oldest=p.time;if(p.time>=start)out.push(p)}
    onPage?.(i+1,oldest);
    if(!Number.isFinite(oldest)||oldest<=start)break;
    end=oldest<end?oldest:end-1;await sleep(60);
  }
  return out;
}
async function loadHistory(){
  if(mode()==='candles'&&src()==='klines')return loadKlines();
  if(loadTok)return;const tok=loadTok={},g=gen,start=Date.now()-histMs();
  note('Backfilling prints…');
  try{
    const got=await fetchTrades(start,g,(n,o)=>note(`Backfilling prints… page ${n} · back to ${hms(o,false)}`));
    if(!got)return;const added=addMany(got);
    note(`Prints backfilled: ${got.length.toLocaleString()} fetched, ${added.toLocaleString()} new · ${new Date(start).toLocaleString()} → now`);
    follow=true;yMan=null;$('livebtn').classList.add('on');dirty=tapeDirty=true;
  }catch(e){note('Backfill failed: '+e.message);console.error(e)}
  finally{if(loadTok===tok)loadTok=null}
}
async function gapFill(from){
  const g=gen;
  try{const got=await fetchTrades(from,g);if(!got)return;const n=addMany(got);if(n){note(`Reconnect: ${n} missed prints filled from REST`);dirty=tapeDirty=true}}
  catch(e){note(`Reconnect gap fill failed — buffer may be missing prints after ${hms(from)}`)}
}
async function loadKlines(quiet=false){
  const tf=tfMs(),g=gen;if(!KL[tf])return;
  if(!quiet)note(`Loading Vest klines ${KL[tf]}…`);
  try{
    const u=new URL(V2+'/klines');u.search=new URLSearchParams({symbol,interval:KL[tf],limit:String(KLINE_MAX)});
    const r=await fetch(u);if(!r.ok)throw new Error('klines HTTP '+r.status);
    const j=await r.json();if(g!==gen||tf!==tfMs())return;
    const b=((Array.isArray(j)?j:j.data)||[]).filter(Array.isArray)
      .map(k=>({time:+k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4]})).filter(b=>Number.isFinite(b.time)).sort((a,b)=>a.time-b.time);
    klines={tf,bars:b,at:Date.now()};dirty=true;
    if(b.length)note(`Vest klines ${KL[tf]}: ${b.length} bars (API serves latest ${KLINE_MAX} only) · ${new Date(b[0].time).toLocaleString()} → now · polled ${hms(klines.at,false)}`);
    else note('Vest klines: empty response');
  }catch(e){note('Klines failed: '+e.message);console.error(e)}
}

// ---- websocket ------------------------------------------------------------
function connect(){
  disconnect(false);setStatus('CONNECTING');$('channel').textContent=symbol+'@trades';
  const sock=ws=new WebSocket(WS);
  sock.onopen=()=>{setStatus('LIVE','live');sock.send(JSON.stringify({method:'SUBSCRIBE',params:[symbol+'@trades'],id:1}));
    ping=setInterval(()=>{try{sock.send(JSON.stringify({method:'PING'}))}catch(e){}},15000);
    if(prints.length)gapFill(prints[prints.length-1].time)};
  sock.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(_){return}
    if(m.channel===symbol+'@trades'){const a=Array.isArray(m.data)?m.data:[m.data],now=Date.now();let any=false;
      for(const d of a){const p=parse(d,now);if(p&&addLive(p)){recvTimes.push(now);any=true}}if(any)dirty=tapeDirty=true}
    else if(Array.isArray(m.subscription_outcomes)){const bad=m.subscription_outcomes.find(o=>o.status!=='registered');if(bad)setStatus('REJECTED '+(bad.reason||bad.requested),'err')}};
  sock.onerror=()=>setStatus('SOCKET ERROR','err');
  sock.onclose=()=>{if(ws!==sock)return;clearInterval(ping);setStatus('RECONNECTING','err');retry=setTimeout(connect,2500)};
}
function disconnect(show=true){clearTimeout(retry);clearInterval(ping);retry=ping=null;if(ws){const s=ws;ws=null;try{s.close()}catch(e){}}if(show)setStatus('DISCONNECTED')}

// ---- top bar + tape -------------------------------------------------------
function updateTop(){
  const l=prints[prints.length-1];
  if(l){$('last').textContent=px(l.price);$('sideTag').textContent=l.side.toUpperCase()||'—';$('sideTag').className=sideCls(l.side);
    $('lqty').textContent=num(l.qty);$('ltime').textContent=hms(l.time);$('bufspan').textContent=dur(l.time-prints[0].time)}
  else{$('last').textContent='—';$('sideTag').textContent='';$('lqty').textContent=$('ltime').textContent=$('bufspan').textContent='—'}
  const cut=Date.now()-1000;while(recvTimes.length&&recvTimes[0]<cut)recvTimes.shift();
  $('rate').textContent=recvTimes.length;$('count').textContent=prints.length.toLocaleString();
}
function renderTape(){
  const a=prints.slice(-TAPE_ROWS).reverse(),idx=tapeTopKey==null?-1:a.findIndex(p=>p.k===tapeTopKey);
  $('rows').innerHTML=a.map((p,i)=>{const c=sideCls(p.side);return `<div class="row${i<idx?' new':''}"><span>${hms(p.time)}</span><span class="${c}">${px(p.price)}</span><span>${num(p.qty)}</span><span>${px(p.quote,2)}</span><span class="${c}">${p.side.toUpperCase()||'—'}</span></div>`}).join('');
  tapeTopKey=a[0]?.k??null;
}

// ---- drawing --------------------------------------------------------------
function niceStep(range,target){const raw=range/target,p=Math.pow(10,Math.floor(Math.log10(Math.max(raw,1e-12)))),n=raw/p;return (n<1.5?1:n<3.5?2:n<7.5?5:10)*p}
function prepareCanvas(){const cv=$('cv'),W=cv.clientWidth,H=cv.clientHeight;if(W<50||H<50)return null;const dpr=devicePixelRatio||1;
  if(cv.width!==Math.round(W*dpr)||cv.height!==Math.round(H*dpr)){cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr)}
  const x=cv.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.fillStyle=C.bg;x.fillRect(0,0,W,H);x.font='11px ui-monospace,Consolas,monospace';return {W,H,x,pw:W-RM,ph:H-BM}}
// Auto range = visible min/max plus a fixed 8% margin. No smoothing, no minimum based on price.
function yRange(lo,hi){if(yMan)return yMan;const r=Math.max(hi-lo,tick*8),mid=(lo+hi)/2,h=r/2*1.08;return [mid-h,mid+h]}
function axes(x,W,H,pw,ph,ll,rr,lo,hi){
  const span=rr-ll,X=t=>(t-ll)/span*pw,Y=p=>ph-(p-lo)/(hi-lo||1)*ph;x.textBaseline='middle';
  const ps=Math.max(tick,niceStep(hi-lo,Math.max(3,ph/52)));
  for(let p=Math.ceil(lo/ps)*ps;p<=hi;p+=ps){const y=Y(p);x.strokeStyle=C.line;x.beginPath();x.moveTo(0,y+.5);x.lineTo(pw,y+.5);x.stroke();x.fillStyle=C.mute;x.fillText(px(p,ps<1?dec:0),pw+6,y)}
  const tstep=[1000,2000,5000,10000,15000,30000,60000,120000,300000,600000,900000,1800000,3600000,7200000,21600000].find(s=>span/s<=Math.max(3,pw/90))||21600000;
  x.textAlign='center';x.textBaseline='alphabetic';
  for(let t=Math.ceil(ll/tstep)*tstep;t<=rr;t+=tstep){const xx=X(t);x.strokeStyle=C.line;x.beginPath();x.moveTo(xx+.5,0);x.lineTo(xx+.5,ph);x.stroke();x.fillStyle=C.mute;x.fillText(new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:tstep<60000?'2-digit':undefined,hour12:false}),xx,H-5)}
  x.textAlign='left';x.strokeStyle=C.line;x.beginPath();x.moveTo(pw+.5,0);x.lineTo(pw+.5,ph);x.stroke();return {X,Y};
}
function priceTag(x,pw,ph,Y,p){const yy=Y(p);if(yy<0||yy>ph)return;x.fillStyle=C.now;x.fillRect(pw+1,yy-8,RM-2,16);x.fillStyle='#111';x.textBaseline='middle';x.fillText(px(p),pw+5,yy)}
function window_(){const span=spanMs(),rr=follow?Date.now()+span*PAD:right,ll=rr-span;return {span,rr,ll}}
function msg(x,s){x.fillStyle=C.mute;x.textBaseline='alphabetic';x.fillText(s,12,24)}

// radius = 1.5 + 4·k·√qty → area ∝ qty. qty 1 ≈ 5.5px, qty 5 ≈ 10px, qty 20 ≈ 19px at 1×.
function bubbleR(q,k){return 1.5+4*k*Math.sqrt(Math.max(0,q)||0)}
// "seq" groups fills that share Vest's match sequence (id "...:<seq>:<n>") — one taker order
// sweeping levels. Its mark sits at the qty-weighted price, with a line spanning the fills' range.
function group(a){
  const byOrder=$('grp').value==='seq',out=[];let m=null;
  for(const p of a){
    if(byOrder&&m&&p.s&&p.s===m.s&&p.side===m.side){m.fills.push(p);m.pq+=p.price*p.qty;m.qty+=p.qty;m.quote+=p.quote;m.lo=Math.min(m.lo,p.price);m.hi=Math.max(m.hi,p.price);m.price=m.qty?m.pq/m.qty:p.price;continue}
    m={s:p.s,time:p.time,price:p.price,pq:p.price*p.qty,qty:p.qty,quote:p.quote,side:p.side,lo:p.price,hi:p.price,fills:[p]};out.push(m);
  }
  return out;
}
function drawTick(){
  const c=prepareCanvas();if(!c)return;const {W,H,x,pw,ph}=c,{span,rr,ll}=window_();
  const i0=lower(prints,ll),i1=upper(prints,rr),a=prints.slice(i0,i1),prev=i0>0?prints[i0-1]:null;
  let lo=Infinity,hi=-Infinity;for(const p of a){if(p.price<lo)lo=p.price;if(p.price>hi)hi=p.price}
  if(!Number.isFinite(lo)){if(!prev){view=null;msg(x,loadTok?'Backfilling prints…':'Waiting for prints…');return}lo=hi=prev.price}
  [lo,hi]=yRange(lo,hi);const {X,Y}=axes(x,W,H,pw,ph,ll,rr,lo,hi);
  // Step line: price holds until the next print.
  x.save();x.beginPath();x.rect(0,0,pw,ph);x.clip();
  const seq=prev?[prev,...a]:a,endT=Math.min(Date.now(),rr);
  x.strokeStyle=`rgba(${C.flat},.45)`;x.lineWidth=1;x.beginPath();
  seq.forEach((p,j)=>{const xx=Math.max(-1,X(p.time)),yy=Y(p.price);if(!j)x.moveTo(xx,yy);else{x.lineTo(xx,Y(seq[j-1].price));x.lineTo(xx,yy)}});
  if(seq.length&&i1===prints.length)x.lineTo(X(endT),Y(seq[seq.length-1].price));x.stroke();
  // Bubbles: area ∝ qty on a fixed scale (same qty → same size everywhere). Largest drawn first.
  const k=+$('bub').value,marks=group(a).sort((m,n)=>n.qty-m.qty);
  for(const m of marks){const xx=X(m.time),yy=Y(m.price),col=sideRgb(m.side);
    if(m.hi>m.lo){x.strokeStyle=`rgba(${col},.8)`;x.lineWidth=1;x.beginPath();x.moveTo(Math.round(xx)+.5,Y(m.hi));x.lineTo(Math.round(xx)+.5,Y(m.lo));x.stroke()}
    if(!k){x.fillStyle=`rgba(${col},.9)`;x.fillRect(Math.round(xx)-2,Math.round(yy)-2,4,4);m.r=3;continue}
    m.r=bubbleR(m.qty,k);x.fillStyle=`rgba(${col},${m.r>6?.5:.85})`;x.beginPath();x.arc(xx,yy,m.r,0,Math.PI*2);x.fill();
    if(m.r>6){x.strokeStyle=`rgba(${col},1)`;x.lineWidth=1;x.stroke()}}
  x.restore();
  const l=prints[prints.length-1];if(l)priceTag(x,pw,ph,Y,l.price);
  view={kind:'tick',ll,rr,lo,hi,pw,ph,span,X,Y,a:marks};if(hover)tipAt(hover);else showOhlc(null);
}
function drawCandles(){
  const c=prepareCanvas();if(!c)return;const {W,H,x,pw,ph}=c,{span,rr,ll}=window_(),tf=tfMs(),all=currentBars();
  const vis=all.slice(lower(all,ll-tf),upper(all,rr));
  let lo=Infinity,hi=-Infinity;for(const b of vis){if(b.low<lo)lo=b.low;if(b.high>hi)hi=b.high}
  if(!Number.isFinite(lo)){view=null;msg(x,src()==='klines'?'No klines loaded for this TF':loadTok?'Backfilling prints…':'No prints in this window — LOAD HISTORY or wait for prints');showOhlc(null);return}
  [lo,hi]=yRange(lo,hi);const {X,Y}=axes(x,W,H,pw,ph,ll,rr,lo,hi),slot=tf/span*pw,bodyW=Math.max(1,Math.min(18,slot*.68));
  // LOD: when bars are sub-pixel, merge by screen column so zoomed-out history stays legible.
  let data=vis;
  if(slot<2.2){data=[];let cur=null,lc=null;for(const b of vis){const col=Math.floor(X(b.time+tf/2));if(col!==lc){cur={...b};data.push(cur);lc=col}else{cur.high=Math.max(cur.high,b.high);cur.low=Math.min(cur.low,b.low);cur.close=b.close}}}
  x.save();x.beginPath();x.rect(0,0,pw,ph);x.clip();
  for(const b of data){const cx=Math.round(X(b.time+tf/2))+.5,col=b.close>b.open?C.up:b.close<b.open?C.dn:C.flat;
    x.strokeStyle=`rgb(${col})`;x.lineWidth=1;x.beginPath();x.moveTo(cx,Y(b.high));x.lineTo(cx,Y(b.low));x.stroke();
    if(slot>=2.2){const y1=Y(b.open),y2=Y(b.close);x.fillStyle=`rgba(${col},.88)`;x.fillRect(Math.round(cx-bodyW/2),Math.min(y1,y2),Math.max(1,Math.floor(bodyW)),Math.max(1,Math.abs(y2-y1)))}}
  x.restore();
  const lastBar=all[all.length-1];if(lastBar)priceTag(x,pw,ph,Y,lastBar.close);
  view={kind:'candles',ll,rr,lo,hi,pw,ph,span,X,Y,a:vis,tf};if(hover)tipAt(hover);else showOhlc(lastBar);
}
function showOhlc(b){$('ohlc').textContent=b&&mode()==='candles'?`${new Date(b.time).toLocaleString([],{hour12:false})}  O ${px(b.open)}  H ${px(b.high)}  L ${px(b.low)}  C ${px(b.close)}${b.n?`  · ${b.n} prints`:''}`:''}
function draw(){mode()==='candles'?drawCandles():drawTick()}

function tipAt(p){
  const el=$('tip');if(!view||p.x>view.pw){el.style.display='none';if(view?.kind==='candles')showOhlc(currentBars().at(-1));return}
  if(view.kind==='candles'){let best=null,bd=Infinity;for(const b of view.a){const dx=Math.abs(view.X(b.time+view.tf/2)-p.x);if(dx<bd){bd=dx;best=b}}
    el.style.display='none';showOhlc(best&&bd<=Math.max(6,view.tf/view.span*view.pw)?best:currentBars().at(-1));return}
  // Nearest mark whose bubble contains the cursor (smallest wins when nested), else nearest within 8px.
  let best=null,bd=Infinity;for(const o of view.a){const d=Math.hypot(view.X(o.time)-p.x,view.Y(o.price)-p.y),lim=Math.max(8,o.r||0);if(d<=lim&&(o.r||0)+d<bd){bd=(o.r||0)+d;best=o}}
  if(!best){el.style.display='none';return}
  const f=best.fills,one=f.length===1,s=`<b class="${sideCls(best.side)}">${best.side.toUpperCase()||'—'}</b>`;
  el.style.display='block';el.style.left=Math.min(p.x+12,view.pw-250)+'px';el.style.top=Math.max(8,p.y-70)+'px';
  el.innerHTML=one?`${s} ${num(f[0].qty)} @ ${px(f[0].price)}<br>quoteQty ${px(f[0].quote,2)}<br>${hms(f[0].time)} · id ${f[0].id||'—'}`
    :`${s} ${num(+best.qty.toFixed(6))} in ${f.length} fills · seq ${best.s}<br>${px(best.lo)} → ${px(best.hi)} · avg ${px(best.price)}<br>quoteQty ${px(best.quote,2)} · ${hms(best.time)}<br>`+
     f.slice(0,8).map(q=>`${num(q.qty)} @ ${px(q.price)}`).join('<br>')+(f.length>8?`<br>… +${f.length-8} more`:'');
}

// ---- input ----------------------------------------------------------------
function inputs(){
  const cv=$('cv'),pos=e=>{const r=cv.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}};
  const setY=(mid,range)=>{range=Math.max(tick*4,range);yMan=[mid-range/2,mid+range/2];dirty=true};
  const goLive=()=>{follow=true;right=0;$('livebtn').classList.add('on');dirty=true};
  cv.addEventListener('mousemove',e=>{const p=pos(e);hover=p;dirty=true;cv.style.cursor=view&&p.x>=view.pw?'ns-resize':drag?.mode==='pan'?'grabbing':'crosshair';if(!drag||!view)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(drag.mode==='yscale')setY(drag.mid,drag.range*Math.exp(dy/220));
    else if(Math.abs(dx)>1){follow=false;right=drag.right-dx/view.pw*view.span;$('livebtn').classList.remove('on')}});
  cv.addEventListener('mouseleave',()=>{hover=null;$('tip').style.display='none';dirty=true});
  cv.addEventListener('mousedown',e=>{if(!view)return;const p=pos(e);
    drag=p.x>=view.pw?{mode:'yscale',x:e.clientX,y:e.clientY,mid:(view.lo+view.hi)/2,range:view.hi-view.lo}:{mode:'pan',x:e.clientX,y:e.clientY,right:view.rr};e.preventDefault()});
  window.addEventListener('mouseup',()=>{drag=null});
  cv.addEventListener('wheel',e=>{e.preventDefault();const p=pos(e);
    if(view&&p.x>=view.pw){setY((view.lo+view.hi)/2,(view.hi-view.lo)*Math.exp(e.deltaY*.0012));return}
    const spans=[...$('span').options].map(o=>+o.value),cur=+$('span').value;let i=spans.indexOf(cur);
    i=Math.max(0,Math.min(spans.length-1,i+(e.deltaY>0?1:-1)));$('span').value=String(spans[i]);yMan=null;dirty=true},{passive:false});
  cv.addEventListener('dblclick',e=>{const p=pos(e);if(view&&p.x>=view.pw){yMan=null;dirty=true}else goLive()});
  $('livebtn').onclick=goLive;
}

// ---- controls -------------------------------------------------------------
function clearAll(){prints=[];seen.clear();recvTimes=[];bars=[];barsKey='';klines={tf:0,bars:[],at:0};tapeTopKey=null;yMan=null;dirty=tapeDirty=true;note('Buffer cleared');updateTop()}
function exportCsv(){
  const head='time_iso,time_ms,price,qty,quote_qty,side,id\n',body=prints.map(p=>[new Date(p.time).toISOString(),p.time,p.price,p.qty,Number.isFinite(p.quote)?p.quote:'',p.side,JSON.stringify(p.id)].join(',')).join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([head+body],{type:'text/csv'}));a.download=`vest-${symbol}-prints-${new Date().toISOString().slice(0,19).replace(/:/g,'')}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function updateUi(){
  const candles=mode()==='candles',kl=candles&&src()==='klines';
  document.querySelectorAll('.candleOnly').forEach(e=>e.style.display=candles?'':'none');
  document.querySelectorAll('.tickOnly').forEach(e=>e.style.display=candles?'none':'');
  for(const o of $('tf').options)o.disabled=src()==='klines'&&!KL[+o.value];
  if(src()==='klines'&&!KL[tfMs()])$('tf').value='60000';
  $('hist').disabled=kl;$('hist').parentElement.style.opacity=kl?.4:1;
  $('history').textContent=kl?'RELOAD KLINES':'LOAD HISTORY';
  $('tip').style.display='none';yMan=null;dirty=true;
}
function startMarket(){
  gen++;loadTok=null;disconnect(false);clearAll();symbol=$('market').value.trim()||'NDX-USD-PERP';
  getInfo().finally(()=>{connect();loadHistory();if(src()==='klines')loadKlines()});
}
$('reconnect').onclick=connect;$('clear').onclick=clearAll;$('csv').onclick=exportCsv;$('history').onclick=loadHistory;
$('market').addEventListener('change',startMarket);
$('mode').addEventListener('change',()=>{updateUi();if(mode()==='candles'&&src()==='klines')loadKlines()});
$('src').addEventListener('change',()=>{updateUi();if(src()==='klines')loadKlines();else note(`OHLC built from ${prints.length.toLocaleString()} buffered prints`)});
$('tf').addEventListener('change',()=>{yMan=null;dirty=true;if(mode()==='candles'&&src()==='klines')loadKlines()});
$('span').addEventListener('change',()=>{yMan=null;dirty=true});
for(const id of ['bub','grp'])$(id).addEventListener('change',()=>dirty=true);

// ---- main loop ------------------------------------------------------------
inputs();updateUi();setInterval(updateTop,250);
setInterval(()=>{if(mode()==='candles'&&src()==='klines'&&!document.hidden)loadKlines(true)},5000);
let lt=0,lastPix=null;
function loop(t){requestAnimationFrame(loop);if(t-lt<33)return;
  if(tapeDirty){tapeDirty=false;renderTape()}
  const pw=Math.max(1,$('cv').clientWidth-RM),pix=follow?Math.floor(Date.now()/(spanMs()/pw)):right;
  if(!dirty&&pix===lastPix)return;lastPix=pix;lt=t;dirty=false;draw()}
requestAnimationFrame(loop);startMarket();
