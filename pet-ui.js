"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const desktop = window.PET_DESKTOP === true;
  const pollInterval = desktop ? 2000 : 1000;
  let nativeVisible = true;
  let idleTimer, idleResetTimer, memes = null, memeLoad = null, activeMeme = null, shareFile = null, memeRevision = 0, memeCovered = false, lastAutoMemeAt = -Infinity;
  const shareNames = new Set(['meme-generated-profit.png','meme-generated-buy.png','meme-generated-loss.png']);
  const nativeShare = () => window.webkit?.messageHandlers?.petMemeShare;
  const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : {matches:false};
  const speech=window.PetSpeech.create({root:$('pet-bubble'),text:$('pet-speech'),image:$('pet-speech-image'),reducedMotion:()=>reducedMotion.matches});
  const canPresent=()=>!stopped&&!document.hidden&&nativeVisible;
  function say(text,priority=1,id){return speech.show({text,priority,id});}
  async function loadMemes(){
    if(memes)return memes;
    if(!memeLoad)memeLoad=(async()=>{const response=await fetch('assets/memes.json',{cache:'force-cache'});if(!response.ok)throw new Error('index');const items=await response.json();if(!Array.isArray(items))throw new Error('index');return memes=items.filter(m=>m&&typeof m.caption==='string'&&/^assets\/[a-zA-Z0-9_-]+\.(png|jpg)$/.test(m.path));})().finally(()=>{memeLoad=null;});
    return memeLoad;
  }
  async function autoMeme(kind,token){
    if(token===null || !canPresent() || memeCovered || Date.now()-lastAutoMemeAt<12000 || Math.random()>=.2)return;
    lastAutoMemeAt=Date.now();
    const revision=memeRevision;
    try{const items=await loadMemes();if(!canPresent() || memeCovered || revision!==memeRevision)return;const match=items.filter(m=>m.type===kind),pool=match.length?match:items;if(!pool.length)return;const item=pool[Math.floor(Math.random()*pool.length)];speech.attachImage(token,item.path,item.caption);}catch{}
  }
  const hiddenIds = new Set(['CODEX','CLAUDE','MOUSE_BATTERY','MOUSE_FREQUENCY','BATTERY']);
  let interactionTimer, dragging=false, lastIdle='', suppressTapUntil=0;
  const idleMoves=['wave','stretch','sleep','look','sway','blink'];
  const animation=window.PetAnimation.create($('pet-art'));
  function syncMotion(){const stage=$('pet-stage').dataset;const name=stage.expression&&stage.expression!=='idle'?stage.expression:stage.interaction||stage.idle||'idle';animation.update(name,{active:!stopped&&!document.hidden&&nativeVisible,reduced:reducedMotion.matches});}
  function clearPlay(){clearTimeout(idleTimer);clearTimeout(idleResetTimer);clearTimeout(interactionTimer);$('pet-stage').dataset.idle='';$('pet-stage').dataset.interaction='';syncMotion();}
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if(stopped || document.hidden || !nativeVisible || reducedMotion.matches || dragging)return;
    idleTimer=setTimeout(()=>{
      if($('pet-stage').dataset.expression==='idle' && !$('pet-stage').dataset.interaction){const pool=idleMoves.filter(x=>x!==lastIdle);lastIdle=pool[Math.floor(Math.random()*pool.length)];play(lastIdle,false);}else scheduleIdle();
    },6000+Math.floor(Math.random()*6001));
  }
  function play(name,speak=true){
    if(stopped || document.hidden || !nativeVisible || dragging || $('pet-stage').dataset.expression!=='idle')return;
    const words={loss:'被套了？我只是暂时不想卖！',buy:'加仓的冲动，先演给你看。',liquidation:'归零也要站起来……这只是演出！',profit:'布丁自由，今天先庆祝！',sell:'收好小金库，歇一会儿。',wave:'嗨！今天也陪着你。',stretch:'伸个懒腰，肩膀放松一点。',sleep:'眯一小会儿，我还在这里。',look:'让我看看你在忙什么。',sway:'晃一晃，心情轻一点。',blink:'在看你呢。',press:'收到摸摸，今天也一起看盘。'};
    if(!words[name])return;if(speak)say(words[name],0);clearPlay();
    if(reducedMotion.matches)return;
    if(name==='press')$('pet-stage').dataset.interaction='press';else $('pet-stage').dataset.idle=name;syncMotion();
    interactionTimer=setTimeout(()=>{clearPlay();scheduleIdle();},window.PetAnimation.durations[name] || 1600);
  }
  function petTap(){if(Date.now()<suppressTapUntil || dragging)return;play('press');}
  function petDrag(phase){
    if(phase==='start'){
      if(stopped || document.hidden || !nativeVisible)return;
      clearPlay();clearTimeout(cueTimer);dragging=true;$('pet-stage').dataset.expression='idle';
      say('抓稳啦，带我去哪里？',0);
      if(!reducedMotion.matches)$('pet-stage').dataset.interaction='dragging';syncMotion();
    }else if(phase==='end' && dragging){
      dragging=false;suppressTapUntil=Date.now()+450;clearPlay();
      if(stopped || document.hidden || !nativeVisible)return;
      if(!reducedMotion.matches && $('pet-stage').dataset.expression==='idle'){$('pet-stage').dataset.interaction='landing';syncMotion();interactionTimer=setTimeout(()=>{clearPlay();scheduleIdle();},360);}else scheduleIdle();
    }
  }
  function suspendPlay(){$('action-popover').hidden=true;$('action-toggle').setAttribute('aria-expanded','false');dragging=false;clearPlay();clearTimeout(cueTimer);$('pet-stage').dataset.expression='idle';syncMotion();}
  $('pet-stage').title='拖动我，右键找我玩';
  window.addEventListener('jiuliu-pet-drag',event=>petDrag(event.detail?.phase));
  window.addEventListener('jiuliu-pet-action',event=>{const name=event.detail?.name;if(name==='demo'){toggleDemo();}else if(name==='meme'){if(!stopped&&!document.hidden&&nativeVisible&&!dragging)void showMeme();}else if(['wave','stretch','sleep'].includes(name))play(name);});
  function toggleDemo(){if(stopped||document.hidden||!nativeVisible)return;$('action-popover').hidden=!$('action-popover').hidden;$('action-toggle').setAttribute('aria-expanded',String(!$('action-popover').hidden));}
  $('action-toggle').addEventListener('click',toggleDemo);
  $('action-close').addEventListener('click',()=>{$('action-popover').hidden=true;$('action-toggle').setAttribute('aria-expanded','false');});
  for(const [id,name] of [['action-wave','wave'],['action-stretch','stretch'],['action-loss','loss'],['action-buy','buy'],['action-zero','liquidation']])$(id).addEventListener('click',()=>{play(name);$('action-popover').hidden=true;$('action-toggle').setAttribute('aria-expanded','false');});
  async function showMeme() {
    if(!canPresent())return;
    const revision=++memeRevision;
    const current=()=>revision===memeRevision&&canPresent();
    $('action-popover').hidden=true;$('action-toggle').setAttribute('aria-expanded','false');
    memeCovered=true;speech.setCovered(true);
    try {
      const items=await loadMemes();
      if(!current())return;
      if(!items.length)throw new Error('empty');
      activeMeme=items[Math.floor(Math.random()*items.length)];
      $('meme-image').src=activeMeme.path;$('meme-image').alt=activeMeme.caption;$('meme-caption').textContent=activeMeme.caption;
      for(const id of ['meme-save','meme-open'])$(id).href=activeMeme.path;
      $('meme-copy').hidden=!(window.ClipboardItem && navigator.clipboard?.write);
      shareFile=null;$('meme-share').hidden=true;
      const selectedMeme=activeMeme, fileName=selectedMeme.path.split('/').pop();
      $('meme-status').textContent='此环境不支持系统分享，可复制图片或保存。';
      $('meme-popover').hidden=false;$('meme-toggle').setAttribute('aria-expanded','true');
      if(shareNames.has(fileName) && selectedMeme.path===`assets/${fileName}`) {
        if(nativeShare()) { $('meme-share').hidden=false;$('meme-status').textContent='点击发送后选择系统分享目标，不会自动发送。'; }
        else if(navigator.canShare && navigator.share) {
          try {const response=await fetch(selectedMeme.path);if(!response.ok)throw new Error('image');const blob=await response.blob();const file=new File([blob],fileName,{type:'image/jpeg'});
            if(current() && activeMeme===selectedMeme && navigator.canShare({files:[file]})) {shareFile=file;$('meme-share').hidden=false;$('meme-status').textContent='点击发送后选择系统分享目标，不会自动发送。';}
          }catch {}
        }
      }
    } catch {if(current()){closeMeme();say('表情包暂时没加载成功，稍后再试。',1);}}
  }
  function closeMeme(){memeRevision++;memeCovered=false;activeMeme=null;shareFile=null;$('meme-popover').hidden=true;$('meme-image').removeAttribute('src');$('meme-image').alt='';$('meme-caption').textContent='';$('meme-share').hidden=true;$('meme-toggle').setAttribute('aria-expanded','false');speech.setCovered(false);}
  function setSpeechActive(active){if(!active){speech.setActive(false);closeMeme();}else speech.setActive(true);}

  const chartHandles = new Map();
  let performanceMode = 'return', chartLoadError = false, performanceEpisode = null, timeframe='minute', viewport=null, viewportFrame=null;
  async function loadCharts() {
    if (desktop || window.PetCharts) return;
    try {
      for (const src of ['vendor/chart.umd.js','vendor/luxon.min.js','vendor/chartjs-adapter-luxon.umd.min.js','vendor/chartjs-chart-financial.min.js','pet-charts.js']) {
        await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.addEventListener('load',resolve);script.addEventListener('error',reject);document.head.append(script);});
      }
      if(!stopped) render();
    } catch {chartLoadError=true;if(!stopped)render();}
  }
  function releaseCharts() {for(const handle of chartHandles.values())handle.destroy();chartHandles.clear();}
  const activeRequests = new Map();
  let requestEpoch=0;
  function abortRequests(){requestEpoch++;for(const [controller,timeout] of activeRequests){clearTimeout(timeout);controller.abort();}activeRequests.clear();}
  let lastAnimationAt = 0, lastPnlBand = null, lastMessageTime = null, lastExpressionTime = null, serviceSeen = new Set(), serviceInitialized = false;
  let state = null, selected = 'CPU', pollTimer, cueTimer, busy = false, polling = false, stopped = false, seen = new Set(), first = true;
  const fullMoney = n => `${Number(n || 0).toLocaleString('zh-CN', {maximumFractionDigits: 8})} 韭币`;
  const money = n => {const value=Number(n || 0),abs=Math.abs(value),scale=abs>=1e8?1e8:abs>=1e4?1e4:1;return `${(value/scale).toLocaleString('zh-CN',{maximumFractionDigits:2})}${scale===1e8?'亿':scale===1e4?'万':''} 韭币`;};
  function setChangeTone(element,value){element.dataset.change=Number.isFinite(value)?value>0?'positive':value<0?'negative':'neutral':'neutral';}
  function showMoney(id,value){$(id).textContent=money(value);$(id).title=fullMoney(value);if(id==='pnl-value')setChangeTone($(id),value);}
  const strategyCopy = {momentum:'顺着已出现的趋势寻找机会，自动挑选信号更强的品种。', dip:'观察回落幅度，在符合条件时分批买入。', dca:'按固定预算积累，避免一次押上全部现金。'};
  const sayings = {
    buy:['小小买一口，留点韭币买布丁。','确认过了！这次先用小仓位。','入场啦，帮我看着这根线！'],
    profit:['今天的布丁，可以加一颗草莓！','涨起来了！先别急着加杠杆。','赢了一小步，开心可以大一点。'],
    sell:['收好这笔，喝口茶再看。','卖掉一点，让心跳慢下来。','落袋啦，今天也要记账。'],
    loss:['呜……先看看哪里判断错了。','这根线有点凶，先把仓位缩小。','亏了也要看账本，不许闭眼。'],
    liquidation:['仓位被强平了……先停下来复盘。','保证金不够了，今天重新学风控。','我的布丁预算……先救账户！']
  };
  function expression(kind, force = false) {
    if (!canPresent()) return;
    if (!force && !['liquidation','loss'].includes(kind) && Date.now() - lastAnimationAt < 5000) return;
    lastAnimationAt = Date.now();
    clearPlay();clearTimeout(cueTimer); $('pet-stage').dataset.idle=''; $('pet-stage').dataset.expression = 'idle';
    void $('pet-stage').offsetWidth;
    $('pet-stage').dataset.expression = reducedMotion.matches?'idle':kind;
    $('pet-stage').dataset.variant = String(Math.floor(Math.random()*3));
    syncMotion();
    const pool = sayings[kind];
    if(pool){const token=say(pool[Math.floor(Math.random()*pool.length)],kind==='liquidation'?3:kind==='loss'?2:1);void autoMeme(kind==='liquidation'?'loss':kind==='sell'?'profit':kind,token);}
    $('pet-mood').textContent = {buy:'认真入场',profit:'开心！',sell:'落袋为安',loss:'有点担心',liquidation:'需要复盘'}[kind] || '观察中';
    cueTimer = setTimeout(() => { $('pet-stage').dataset.expression='idle'; syncMotion();scheduleIdle(); }, 2200);
  }

  function candles(instrument) {
    // Availability must not depend on whether the optional chart library has loaded.
    return [...(instrument.history || []), ...(instrument.currentCandle ? [instrument.currentCandle] : [])].filter(c=>[c.time,c.open,c.high,c.low,c.close].every(Number.isFinite) && c.high>=Math.max(c.open,c.close) && c.low<=Math.min(c.open,c.close));
  }
  function updateChart(container, instrument, mini=false) {
    const rows=state.chartHistory?.timeframe===timeframe?state.chartHistory.markets?.[instrument.id] || []:[];
    const count=rows.length;
    if(desktop || !window.PetCharts || (document.hidden && state !== null))return count;
    if(!chartHandles.has(container))chartHandles.set(container,window.PetCharts.createCandles(container,{mini,viewport}));
    return chartHandles.get(container).update({...instrument,history:rows,currentCandle:null},state.chartHistory?.trades || []);
  }
  function renderPerformance() {
    const perf=state.performance, points=state.chartHistory?.timeframe===timeframe?state.chartHistory.equity || []:[], current=perf?.current || null;
    if(perf?.episode!==undefined && performanceEpisode!==perf.episode){
      performanceEpisode=perf.episode;const old=chartHandles.get($('performance-chart'));if(old){old.destroy();chartHandles.delete($('performance-chart'));}
    }
    const ledger=state.game.bankruptcyLedger || {};
    $('bankruptcy-count').textContent=String(ledger.count || 0);showMoney('settled-loss',ledger.totalCrystallizedLoss || 0);if(ledger.totalsCapped){$('settled-loss').textContent='≥ '+$('settled-loss').textContent;$('settled-loss').title='达到数值显示上限；累计实际亏损不少于此数，并非精确总额。';}
    const previous=perf?.lastRun, record=ledger.records?.at(-1);
    $('previous-round').textContent=previous?`上轮 #${previous.episode}：净收益 ${money(previous.pnl)}，结束权益 ${money(previous.equity)}；旧账保留，不与本轮连线。`:record?`最近平账：已结算亏损 ${money(record.crystallizedLoss)}，豁免债务 ${money(record.forgivenDebt)}。`:'暂无上轮账本';
    $('previous-round').title=previous?`上轮净收益 ${fullMoney(previous.pnl)}；权益 ${fullMoney(previous.equity)}`:record?`已结算亏损 ${fullMoney(record.crystallizedLoss)}；豁免债务 ${fullMoney(record.forgivenDebt)}`:'';
    const baseline=Number.isFinite(perf?.baseline)?perf.baseline:null;
    const percentageAllowed=baseline>0;
    const mode=baseline===0?'equity':performanceMode;
    $('performance-mode').value=mode;
    $('performance-return-option').disabled=!percentageAllowed;
    $('performance-return').textContent=Number.isFinite(current?.returnPct)?`${current.returnPct>=0?'+':''}${current.returnPct.toFixed(2)}%`:'—';
    setChangeTone($('performance-return'),current?.returnPct);setChangeTone($('performance-pnl'),current?.pnl);
    $('performance-pnl').textContent=current?money(current.pnl):'—';$('performance-pnl').title=current?fullMoney(current.pnl):'';
    $('performance-baseline').textContent=baseline!==null?money(baseline):'—';$('performance-baseline').title=baseline!==null?fullMoney(baseline):'';
    const time=value=>new Date(value).toLocaleString('zh-CN',{hour12:false});
    $('performance-range').textContent=points.length?`${time(perf.startedAt ?? points[0].time)} → ${time(points.at(-1).time)}`:'从现在开始记录';
    $('performance-note').textContent=current?.stale?'持仓报价已过期：当前为最后报价估值，恢复采样前不能视作实时收益。':baseline===0?'起始资金为零，仅显示净权益。':'';
    $('performance-note').hidden=!$('performance-note').textContent;
    $('performance-empty').hidden=points.length>0 && !!window.PetCharts;
    $('performance-empty').textContent=chartLoadError?'图表组件未能加载，请检查本地资源。':points.length && !window.PetCharts?'正在加载图表…':'从现在开始记录';
    if(window.PetCharts && !document.hidden) {
      const container=$('performance-chart');
      if(!chartHandles.has(container))chartHandles.set(container,window.PetCharts.createPerformance(container,{viewport}));
      chartHandles.get(container).update(perf,mode,points);
    }
  }
  function sampleFor(i) {
    const metrics={MOUSE_DISTANCE:'mouseDistance',MOUSE_CLICKS:'mouseClicks',KEYBOARD:'keyboard',THREADS:'threads',CONNECTIONS:'connections',DSH:'dshTokens'};
    return state.telemetry?.[metrics[i.id] || i.metric] || null;
  }
  function sourceMeta(i) {
    const sample=sampleFor(i);
    const tokenSource=i.id==='DSH';
    const agent=!tokenSource && (sample?.source==='agent-command-lifecycle' || ['codexActivity','claudeActivity'].includes(i.metric));
    const stale=!!i.stale || sample?.status==='stale';
    const nativeUnits={MOUSE_DISTANCE:'pt/s',MOUSE_CLICKS:'clicks/s',KEYBOARD:'keys/s',THREADS:'线程',CONNECTIONS:'连接',DSH:'tokens/s'};
    const unit=nativeUnits[i.id] || (agent?'活跃 0/1':i.metric==='mouseFrequency'?'events/s':i.metric==='mouseBattery'?'%':i.id==='LOAD'?'load':sample?.unit || (['cpu','memory','mouseBattery'].includes(i.metric)?'%':''));
    let description=agent?`命令生命周期上报 · 运行中 1 / 结束 0 · 非 token 用量${Number.isFinite(sample?.activeSessions)?` · ${sample.activeSessions} 个活跃会话`:''}`:i.id==='LOAD'?'系统一分钟平均负载 · 单位 load':i.metric==='cpu'?'系统 CPU 使用率 · 单位 %':i.metric==='memory'?'系统内存使用率 · 单位 %':`采样单位：${unit || '由数据源定义'}`;
    const reasonLabels={'permission-required':'需要输入监控权限','no-device':'设备未提供电量','unsupported':'系统不支持','read-error':'暂时读取失败'};
    const reason=sample?.status==='unavailable' ? (reasonLabels[sample.reason] || '未接入') : '';
    if(i.metric==='mouseFrequency') description='指针移动事件/秒 · 非硬件回报率 · 含系统合并，可能含触控板'+(sample?.source==='macos-event-counter'?' · macOS 事件计数':'');
    if(i.metric==='mouseBattery') description='鼠标电量 · 单位 %'+(sample?.source==='macos-hid-battery'?' · macOS HID 电量':'');
    const explanations={MOUSE_DISTANCE:'系统指针移动距离 · pt/s · 不是硬件毫米，可能含触控板',MOUSE_CLICKS:'鼠标点击事件 · clicks/s',KEYBOARD:'键盘按键事件 · keys/s · 仅计数，不采集按键内容',THREADS:'线程计数 · 具体采集口径以数据源为准',CONNECTIONS:'系统 TCP 端点数，包含监听及其他状态，并非仅已建立连接',DSH:'DSH 实际输出 token 速率 · tokens/s · 非命令活跃状态'};
    if(explanations[i.id]) description=explanations[i.id]+(sample?.source?` · 来源：${sample.source}`:'');
    if(reason) description += ` · ${reason}`;
    return {agent,stale,unit,description,reason};
  }
  function available(i) {
    const sample=sampleFor(i);
    if(sample && ['unavailable','stale','disconnected'].includes(sample.status)) return false;
    if(i.stale || i.hasSamples===false || i.tradable===false || i.status==='unavailable' || i.status==='waiting') return false;
    return candles(i).length > 0;
  }
  function buildMarkets(instruments) {
    const strip=$('market-strip');
    for(const i of instruments.filter(item=>!hiddenIds.has(item.id))) {
      let tile=Array.from(strip.children).find(el=>el.dataset.id===i.id);
      if(!tile){
        tile=document.createElement('article');tile.className='market-tile';tile.dataset.id=i.id;
        const button=document.createElement('button');button.type='button';button.innerHTML='<strong></strong><span class="tile-status"></span>';
        let pointerStart=null, suppressClick=false;
        tile.addEventListener('pointerdown',event=>{pointerStart={x:event.clientX,y:event.clientY};suppressClick=false;},{capture:true});
        tile.addEventListener('pointermove',event=>{if(pointerStart && Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y)>4)suppressClick=true;},{capture:true});
        tile.addEventListener('pointerup',event=>{if(pointerStart && Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y)>4)suppressClick=true;pointerStart=null;},{capture:true});
        tile.addEventListener('pointercancel',()=>{pointerStart=null;suppressClick=true;},{capture:true});
        tile.addEventListener('wheel',()=>{suppressClick=true;},{capture:true,passive:true});
        const selectTile=event=>{if(event?.defaultPrevented || suppressClick){suppressClick=false;return;}selected=i.id;render();};
        tile.addEventListener('click',selectTile);
        button.addEventListener('click',event=>{event.stopPropagation();selectTile(event);});
        button.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')suppressClick=false;});
        const value=document.createElement('span');value.className='tile-value';
        const plot=document.createElement('div');plot.className='mini-chart';
        const empty=document.createElement('div');empty.className='mini-empty';
        tile.append(button,value,plot,empty);strip.append(tile);
      }
      tile.classList.toggle('selected',i.id===selected);tile.querySelector('button').setAttribute('aria-pressed',String(i.id===selected));
      tile.querySelector('strong').textContent=i.metric==='mouseFrequency'?'指针移动事件/秒':i.name || i.id;
      const ok=available(i), sample=sampleFor(i), meta=sourceMeta(i), hasHistory=candles(i).length>0;
      tile.querySelector('.tile-status').textContent=meta.stale?'已过期':ok?'已接入':sample?.status==='unavailable'?(meta.reason || '未接入'):'等待采样';
      setChangeTone(tile.querySelector('.tile-value'),ok&&!meta.stale?Number(i.changePct):null);
      tile.querySelector('.tile-value').textContent=hasHistory?`${meta.agent?Number(i.price).toFixed(0):Number(i.price).toFixed(2)} ${meta.unit}`:`— ${meta.unit}`;
      const plot=tile.querySelector('.mini-chart'), empty=tile.querySelector('.mini-empty');plot.hidden=!hasHistory;empty.hidden=hasHistory;
      empty.textContent=sample?.status==='unavailable'?(meta.reason || '未接入，不生成行情'):'等待第一笔采样';
      if(hasHistory)updateChart(plot,i,true);
    }
  }
  function consumeEvents(game) {
    const events=game.events || [];
    if(first){events.forEach(e=>seen.add(e.id));first=false;return;}
    for(const e of events){if(seen.has(e.id))continue;seen.add(e.id);
      const p=e.payload || e;let kind;
      if(e.type==='liquidation')kind='liquidation';
      else if(e.type==='trade' || e.type==='auto-trade')kind=p.action==='buy'?'buy':Number(p.realizedPnl)<0?'loss':Number(p.realizedPnl)>0?'profit':'sell';
      if(kind)expression(kind);
    }
    if(seen.size>500)seen=new Set(events.map(e=>e.id));
  }
  function consumeService() {
    if (!serviceInitialized) {
      serviceInitialized = true;
      for (const c of state.cues || []) serviceSeen.add(c.id);
      lastExpressionTime = state.expression?.time ?? null;
      const latestSay = state.message || [...(state.cues || [])].reverse().find(c => c.name === 'say' && c.text);
      if (latestSay) { say(latestSay.text,1,`say:${latestSay.time}`); lastMessageTime = latestSay.time; }
      return;
    }
    const mapping={happy:'profit',excited:'profit',worried:'loss',distressed:'liquidation',working:'buy',grit:'buy',greet:'sell',sleep:'idle',calm:'idle',idle:'idle'};
    for(const c of state.cues || []) {
      if(serviceSeen.has(c.id))continue;serviceSeen.add(c.id);
      if(c.name==='say' && c.text) { say(c.text,1,`say:${c.time}`); lastMessageTime=c.time; }
      else { expression(mapping[c.name] || c.name, true); lastExpressionTime=c.time; }
    }
    if(serviceSeen.size>100)serviceSeen=new Set((state.cues || []).map(c=>c.id));
    if(state.expression && state.expression.time!==lastExpressionTime) {lastExpressionTime=state.expression.time;expression(mapping[state.expression.name] || state.expression.name,true);}
    if(state.message && state.message.time!==lastMessageTime) {lastMessageTime=state.message.time;say(state.message.text,1,`say:${state.message.time}`);}
  }
  function renderLogs() {
    window.PetDiary?.render(state.tradeDiary);
  }
  function reactToFloatingPnl(game) {
    const pnl = Object.values(game.positions || {}).reduce((sum, position) => {
      const instrument = (game.instruments || []).find(i => i.id === position.instrumentId);
      return instrument ? sum + (position.side==='short'?(position.avgPrice-instrument.price)*position.quantity-Number(position.accruedInterest || 0):(instrument.price-position.avgPrice)*position.quantity) : sum;
    }, 0);
    const band = Math.trunc(pnl / Math.max(1, Number(game.initialCash || 10000)) / .02);
    if (lastPnlBand !== null && band !== lastPnlBand && band !== 0) expression(band > 0 ? 'profit' : 'loss');
    lastPnlBand = band;
  }
  function render() {
    if(!state?.game)return;
    if(desktop){consumeEvents(state.game);reactToFloatingPnl(state.game);consumeService();return;}
    const game=state.game,instruments=game.instruments || [];
    if(!instruments.some(i=>i.id===selected && !hiddenIds.has(i.id)))selected=instruments.find(i=>!hiddenIds.has(i.id))?.id;
    if(window.PetCharts){viewport ||= window.PetCharts.createViewport();const history=state.chartHistory;if(history?.timeframe===timeframe){const times=[...Object.values(history.markets || {}).flat(),...(history.equity || [])].map(c=>c.time);viewport.configure(times,history.intervalMs,viewportFrame!==timeframe);viewportFrame=timeframe;}}
    $('history-notice').textContent=state.chartHistory?.notice || '新记录从现在开始；不回填旧成交或空缺行情。';
    buildMarkets(instruments);const i=instruments.find(i=>i.id===selected);if(!i)return;
    const ok=available(i),p=game.positions?.[i.id],meta=sourceMeta(i),hasHistory=candles(i).length>0;
    $('chart-title').textContent=i.metric==='mouseFrequency'?'指针移动事件/秒':i.name || i.id;$('selected-symbol').textContent=i.id;
    $('price-value').textContent=hasHistory?`${meta.agent?Number(i.price).toFixed(0):Number(i.price).toFixed(3)} ${meta.unit}`:'—';
    $('price-change').textContent=ok?`${Number(i.changePct || 0)>=0?'+':''}${(Number(i.changePct || 0)*100).toFixed(2)}%`:'等待采样';
    setChangeTone($('price-change'),ok&&!meta.stale?Number(i.changePct):null);
    if(meta.stale) $('price-change').textContent='已过期 · 最后采样值';
    else if(meta.agent) $('price-change').textContent=ok?(Number(i.price)>0?'运行中':'已结束'):'未接入';
    const count=updateChart($('main-chart'),i);$('candle-count').textContent=`${count} 根采样 K 线`;
    $('chart-empty').hidden=count>0 && !!window.PetCharts;
    $('chart-empty').textContent=!window.PetCharts?(chartLoadError?'图表组件未加载，请检查本地资源。':'正在加载图表…'):ok?'等待第一笔真实采样，不补造历史。':sampleFor(i)?.status==='unavailable'?`${meta.reason || '该数据源尚未接入'}，不生成行情。`:'等待第一笔真实采样，不补造历史。';
    $('chart-source').textContent=`${meta.description} · ${meta.stale?'数据已过期，保留历史，暂停交易':i.currentCandle?'含当前未收盘 K 线':'仅已收盘 K 线'}`;
    const positions=Object.values(game.positions || {}), debt=Number(game.loanBalance || 0)+positions.reduce((v,p)=>v+(p.side==='short'?0:Number(p.debt || 0)),0);
    const assets=positions.reduce((v,p)=>v+Number(p.quantity || 0)*Number(instruments.find(i=>i.id===p.instrumentId)?.price || 0),0);
    const pnl=positions.reduce((v,p)=>v+(p.side==='short'?(p.avgPrice-Number(instruments.find(i=>i.id===p.instrumentId)?.price || 0))*p.quantity-Number(p.accruedInterest || 0):(Number(instruments.find(i=>i.id===p.instrumentId)?.price || 0)-p.avgPrice)*p.quantity),0);
    showMoney('equity-value',state.performance?.current?.equity ?? 0);showMoney('cash-value',game.cash);showMoney('pnl-value',Number.isFinite(state.performance?.current?.pnl)?state.performance.current.pnl:pnl);showMoney('loan-value',debt);
    $('position-summary').textContent=p?`${i.id} · ${p.side==='short'?'空仓':'多仓'} · ${Number(p.quantity).toFixed(3)} 份 · 均价 ${Number(p.avgPrice).toFixed(2)}`:'当前品种暂无持仓';
    $('buy-button').textContent=$('order-side').value==='short'?'卖出开空':'买入做多';$('sell-button').textContent=p?.side==='short'?'买入平空':'卖出平多';
    $('buy-button').disabled=busy || !ok || !(i.price > 0);$('sell-button').disabled=busy || !ok || !p;
    const automation=game.automation || {};$('auto-borrow').checked=automation.autoBorrow===true;$('auto-borrow').disabled=busy;$('bankruptcy-button').disabled=busy;$('auto-toggle').disabled=busy;$('auto-toggle').textContent=automation.enabled?'Ⅱ 暂停投资':'▶ 恢复投资';
    document.querySelectorAll('[data-strategy]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.strategy===automation.strategy));b.disabled=busy;});
    $('strategy-desc').textContent=strategyCopy[automation.strategy] || '等待服务返回当前投资策略。';
    const decision=[...(game.events || [])].reverse().find(e=>e.type==='auto-decision')?.payload || automation.lastDecision || game.lastDecision || {};
    $('decision-symbol').textContent=decision.instrumentId || decision.symbol || decision.selected || '等待策略观察';
    $('decision-reason').textContent=decision.reason || automation.reason || '采样不足时先观望，不凭空生成信号。';
    const at=state.telemetry?.sampledAt; $('sample-time').textContent=at?new Date(at).toLocaleTimeString('zh-CN',{hour12:false}):'尚未采样';
    renderPerformance();
    consumeEvents(game);
    reactToFloatingPnl(game);
    consumeService(); renderLogs(game);
  }
  async function request(path, options) {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),4500);activeRequests.set(controller,timeout);
    try{const res=await fetch(path,{...options,signal:controller.signal,cache:'no-store'});const data=await res.json();if(!res.ok)throw new Error(data.error || `请求失败 ${res.status}`);return data;}finally{clearTimeout(timeout);activeRequests.delete(controller);}
  }
  function connection(ok, text) {document.body.dataset.localConnection=ok?'online':'offline';if(desktop)return;$('connection-dot').classList.toggle('online',ok);$('connection-text').textContent=text;}
  async function poll() {
    // Native WKWebView may be hidden before its first show; hydrate once, then suspend.
    if(polling || stopped || (document.hidden && state !== null) || !nativeVisible || busy)return;polling=true;
    try{const requestedFrame=timeframe,epoch=requestEpoch;const result=await request(desktop?'/api/state':`/api/state?timeframe=${requestedFrame}`);if(stopped||requestedFrame!==timeframe||epoch!==requestEpoch)return;state=result;connection(true,'本地采集在线');render();}catch(error){if(!canPresent())return;connection(false,'服务断开 · 正在重连');if(desktop){say('暂时连接不上，等本地服务回来。',1,'connection-offline');}else{$('trade-feedback').textContent='无法连接本地服务，请从 http://127.0.0.1:8766/pet.html 打开。';document.querySelectorAll('#trade-form button,#auto-toggle').forEach(b=>b.disabled=true);}}finally{polling=false;if(!stopped&&!document.hidden&&nativeVisible)pollTimer=setTimeout(poll,pollInterval);}
  }
  async function action(payload, message, kind) {
    if(busy)return;busy=true;render();clearTimeout(pollTimer);
    try{const previousHistory=state?.chartHistory;state=await request('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(previousHistory?.timeframe===timeframe && state.chartHistory?.timeframe!==timeframe)state.chartHistory=payload.action==='bankruptcy'?{...previousHistory,equity:[]}:previousHistory;connection(true,'本地采集在线');$('trade-feedback').textContent=message;render();if(kind)expression(kind);}catch(error){$('trade-feedback').textContent=`操作未完成：${error.message}`;}finally{busy=false;render();clearTimeout(pollTimer);if(!stopped&&!document.hidden&&nativeVisible)pollTimer=setTimeout(poll,pollInterval);}
  }
  document.querySelectorAll('[data-copy-token]').forEach(button=>button.addEventListener('click',async()=>{
    const text=button.dataset.copyToken==='read'?'node bin/kurumi.cjs tokens':'dsh plugin --profile desktop add /绝对路径/FX-Fighter-Kurumi/plugins/jiuliu-dsh';
    try {await navigator.clipboard.writeText(text);$('agent-copy-status').textContent='命令已复制，请确认项目绝对路径；页面不会执行。';}
    catch {$('agent-copy-status').textContent='无法访问剪贴板，请手动复制。';}
  }));
  $('performance-mode').addEventListener('change',()=>{performanceMode=$('performance-mode').value==='equity'?'equity':'return';if(state)renderPerformance();});
  $('chart-timeframe').addEventListener('change',()=>{timeframe=['minute','hour','day'].includes($('chart-timeframe').value)?$('chart-timeframe').value:'minute';viewportFrame=null;releaseCharts();clearTimeout(pollTimer);poll();});
  $('chart-zoom-in').addEventListener('click',()=>viewport?.zoom(.7));$('chart-zoom-out').addEventListener('click',()=>viewport?.zoom(1.4));$('chart-latest').addEventListener('click',()=>viewport?.latest());
  $('order-side').addEventListener('change',()=>render());
  $('trade-form').addEventListener('submit',e=>{e.preventDefault();if(!state)return;const i=state.game.instruments.find(i=>i.id===selected),amount=$('order-size').valueAsNumber;if(!available(i)||!(i.price>0)||!Number.isFinite(amount)||amount<=0)return;const short=$('order-side').value==='short';action({action:short?'short':'buy',symbol:selected,quantity:amount/(i.price*(1+(short?-1:1)*(i.spread||0))),options:{leverage:Number($('leverage').value)}},short?'开空指令已执行。':'买入指令已执行。');});
  $('sell-button').addEventListener('click',()=>action({action:state?.game.positions?.[selected]?.side==='short'?'cover':'sell',symbol:selected},'当前品种已平仓。'));
  for(const verb of ['borrow','repay'])$(verb+'-button').addEventListener('click',()=>{const input=$(verb==='borrow'?'loan-size':'repay-size');if(!input.reportValidity()||!Number.isFinite(input.valueAsNumber))return;const amount=input.valueAsNumber;if(verb==='borrow'?(amount<100000||amount>3000000):amount<1)return;action({action:verb,amount},verb==='borrow'?'虚拟借款完成。':'还款完成。');});
  document.querySelectorAll('[data-loan]').forEach(button=>button.addEventListener('click',()=>{$('loan-size').value=button.dataset.loan;}));
  $('bankruptcy-button').addEventListener('click',()=>action({action:'bankruptcy'},'游戏内平账完成：现金、持仓、债务已清零，投资暂停，累计亏损保留。'));
  $('auto-borrow').addEventListener('change',()=>action({action:'automation',automation:{autoBorrow:$('auto-borrow').checked}},'自动借款设置已更新。'));
  $('auto-toggle').addEventListener('click',()=>action({action:'automation',automation:{enabled:!state.game.automation?.enabled}},state.game.automation?.enabled?'自主投资已暂停，采集继续。':'自主投资已恢复。'));
  document.querySelectorAll('[data-strategy]').forEach(b=>b.addEventListener('click',()=>action({action:'automation',automation:{strategy:b.dataset.strategy}},'投资策略已更新。')));
  $('personality').addEventListener('change',()=>{const presets={cautious:{riskTolerance:.2,discipline:.9,patience:.9,impulsiveness:.1},balanced:{riskTolerance:.5,discipline:.6,patience:.5,impulsiveness:.4},bold:{riskTolerance:.9,discipline:.2,patience:.2,impulsiveness:.9}};action({action:'personality',personality:presets[$('personality').value]},'性格已更新。');});
  $('instrument-form').addEventListener('submit',e=>{e.preventDefault();action({action:'add',instrument:{id:$('custom-id').value.trim().toUpperCase(),name:$('custom-name').value.trim(),volatility:$('custom-volatility').valueAsNumber/100}},'品种已添加，等待外部真实采样。');});
  window.addEventListener('jiuliu-pet-tap',petTap);
  $('pet-stage').addEventListener('click',petTap);
  $('meme-toggle').addEventListener('click',()=>{if($('meme-popover').hidden)void showMeme();else closeMeme();});
  $('meme-next').addEventListener('click',()=>void showMeme());$('meme-close').addEventListener('click',closeMeme);
  $('meme-share').addEventListener('click',async()=>{
    if(!activeMeme)return;
    const file=activeMeme.path.split('/').pop();
    if(!shareNames.has(file) || activeMeme.path!==`assets/${file}`)return;
    try {
      if(nativeShare()) {nativeShare().postMessage({file});$('meme-status').textContent='已请求系统分享菜单，请自行选择目标。';}
      else if(shareFile && navigator.canShare?.({files:[shareFile]}) && navigator.share) {await navigator.share({files:[shareFile]});$('meme-status').textContent='系统分享已完成。';}
      else $('meme-status').textContent='此环境不支持系统分享，可复制图片。';
    }catch(error){$('meme-status').textContent=error.name==='AbortError'?'已取消分享。':'无法打开系统分享，可复制图片。';}
  });
  $('meme-copy').addEventListener('click',async()=>{
    if(!activeMeme)return;
    try {const response=await fetch(activeMeme.path);if(!response.ok)throw new Error('image');const blob=await response.blob();
      const image=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);image.close();
      const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!png)throw new Error('png');await navigator.clipboard.write([new window.ClipboardItem({'image/png':png})]);$('meme-status').textContent='图片已复制，可自行粘贴。';
    }catch{$('meme-status').textContent='复制失败，可使用保存或打开图片。';}
  });
  window.addEventListener('jiuliu-visibility', event => {
    if (!desktop || typeof event.detail?.visible !== 'boolean') return;
    nativeVisible = event.detail.visible; setSpeechActive(canPresent()); clearTimeout(pollTimer);scheduleIdle();if(!nativeVisible){suspendPlay();abortRequests();}
    if (nativeVisible){syncMotion();poll();}
  });
  document.addEventListener('visibilitychange',()=>{setSpeechActive(canPresent());clearTimeout(pollTimer);scheduleIdle();if(document.hidden){suspendPlay();abortRequests();for(const handle of chartHandles.values())handle.pause();}else{syncMotion();for(const handle of chartHandles.values())handle.resize();if(state)render();poll();}});
  window.addEventListener('pagehide',()=>{stopped=true;setSpeechActive(false);suspendPlay();clearTimeout(idleTimer);clearTimeout(idleResetTimer);clearTimeout(pollTimer);clearTimeout(cueTimer);abortRequests();releaseCharts();});
  window.addEventListener('pageshow',()=>{stopped=false;setSpeechActive(canPresent());syncMotion();clearTimeout(pollTimer);poll();scheduleIdle();});
  if(reducedMotion.addEventListener)reducedMotion.addEventListener('change',()=>{suspendPlay();scheduleIdle();});
  setSpeechActive(canPresent());syncMotion();void loadCharts();poll();scheduleIdle();
})();
