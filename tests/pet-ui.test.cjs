'use strict';
// Runs the unmodified UI script with an isolated browser boundary. No network or trades.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'pet-ui.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'pet.html'), 'utf8');
const flush = async () => { for (let n = 0; n < 24; n++) await Promise.resolve(); };

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.listeners = {}; this.style = {}; this.textContent = ''; this.value = ''; this.attributeWrites = [];
    this.classList = { toggle() {}, add() {}, remove() {} }; this.offsetWidth = 200;
  }
  get valueAsNumber(){return Number(this.value);}
  reportValidity(){return true;}
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  removeEventListener(name,callback){this.listeners[name]=(this.listeners[name] || []).filter(fn=>fn!==callback);}
  dispatch(name, detail, fields = {}) { for (const callback of this.listeners[name] || []) callback({ detail, preventDefault() {}, stopPropagation() {}, ...fields }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); this.attributeWrites.push({name,value:String(value)}); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; if(name==='src')delete this.src; }
  set innerHTML(value) {
    assert.equal(value, '<strong></strong><span class="tile-status"></span>');
    const strong = new Element('strong'), status = new Element('span'); status.className = 'tile-status';
    this.children = [strong, status];
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith('.') ? child.className === selector.slice(1) : child.tagName === selector) return child;
      const descendant = child.querySelector(selector); if (descendant) return descendant;
    }
    return null;
  }
}
function snapshot(overrides = {}) {
  return { chartHistory:{timeframe:'minute',intervalMs:60000,markets:{CPU:[{time:1700000000000,open:100,high:100,low:100,close:100}]},equity:[],trades:[]}, game: { initialCash: 10000, cash: 10000, loanBalance: 0, positions: {},
    instruments: [{ id: 'CPU', name: 'CPU', metric: 'cpu', price: 100, hasSamples: true,
      history: [{time: 1700000000000, open:100, high:100, low:100, close:100}] }],
    automation: { enabled: true, strategy: 'momentum' }, events: [] }, cues: [], telemetry: {}, ...overrides };
}
function harness({ desktop = true, hidden = false, initial = snapshot(), random = .1, reducedMotion = false, allowActions = false, memeResponse = null, stateResponse = null } = {}) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  for(const id of ['action-popover','meme-popover','pet-bubble','pet-speech-image'])elements.get(id).hidden=true;
  const root = new Element('unused'), stage = elements.get('pet-stage'); stage.dataset.expression = 'idle';

  const document = new Element('document'); document.hidden = hidden; document.body = new Element('body');
  document.getElementById = id => { assert(elements.has(id), `Missing real HTML id: ${id}`); return elements.get(id); };
  document.querySelectorAll = () => []; document.createElement = tag => new Element(tag); document.head = new Element('head');
  const window = new Element('window'); window.PET_DESKTOP = desktop; const motion=new Element('media');motion.matches=reducedMotion;window.matchMedia=()=>motion;
  const timers = new Map(), calls = [], charts = [], actions = []; let clock = 1700000000000, serial = 0, response = initial;
  class FakeDate extends Date { static now() { return clock; } }
  const math = Object.create(Math); math.random = () => random;
  class ChartStub {
    constructor(canvas, config) {this.canvas=canvas;this.config=config;this.data=config.data;this.options=config.options;this.removed=false;this.paused=false;this.updates=0;charts.push(this);}
    update() {this.updates++;} destroy(){this.removed=true;} stop(){this.paused=true;} resize(){this.paused=false;}
  }
  const context = {window, document, navigator:{}, Chart:ChartStub, console, Date: FakeDate, Math: math, AbortController, File,
    setTimeout(fn, delay) {const id=++serial;timers.set(id,{fn,at:clock+delay,delay});return id;},
    clearTimeout(id) {timers.delete(id);},
    async fetch(url, options) {if(url==='/api/action'){assert(allowActions,'Real actions forbidden');actions.push(JSON.parse(options.body));return {ok:true,json:async()=>structuredClone(response)};}if(url==='assets/meme-generated-profit.png')return {ok:true,blob:async()=>new Blob(['image'],{type:'image/png'})};if(url==='assets/memes.json' && memeResponse)return memeResponse();if(url==='assets/memes.json')return {ok:true,json:async()=>[{id:'laugh',path:'assets/meme-generated-profit.png',caption:'开心一下',type:'profit'}]};assert.match(url,/^\/api\/state(?:\?timeframe=(minute|hour|day))?$/,'Tests must never submit trades');assert.notEqual(options?.method, 'POST');calls.push(url);if(stateResponse)return stateResponse();return {ok:true,json:async()=>structuredClone(response)};}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','pet-animation.js'),'utf8'),context);
  if(!desktop){vm.runInContext(fs.readFileSync(path.join(__dirname,'..','pet-charts.js'),'utf8'),context);window.PetCharts=context.PetCharts;}
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','pet-speech.js'),'utf8'),context);
  vm.runInContext(source, context, {filename:'pet-ui.js'});
  return { elements, root, stage, window, document, calls, charts, timers, actions, motion,
    setResponse(value) {response=value;}, async ready() {await flush();},
    async advance(ms) {
      const end=clock+ms;
      for (;;) {const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
        clock=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}
      clock=end;await flush();
    },
    navigator:context.navigator,
    loadSvg() {elements.get('pet-art').dispatch('load');}
  };
}

for (const kind of ['buy','sell','profit','loss','liquidation']) {
  test(`${kind}: fresh service cues choose three variants/quotes, update APNG, and settle after 2200ms`, async () => {
    const quotes = new Set();
    for (const [variant, random] of [0.01,.45,.99].entries()) {
      const h=harness({random}); await h.ready();
      h.setResponse(snapshot({cues:[{id:`${kind}:new`,name:kind,time:1700000002000}]}));
      await h.advance(2000);
      assert.equal(h.stage.dataset.expression,kind);assert.equal(h.stage.dataset.variant,String(variant));
      assert.equal(h.elements.get('pet-art').dataset.animation,kind);
      const quote=h.elements.get('pet-speech').textContent;assert(quote.length>8);quotes.add(quote);
      await h.advance(2199);assert.equal(h.stage.dataset.expression,kind);
      await h.advance(1);assert.equal(h.stage.dataset.expression,'idle');assert.equal(h.elements.get('pet-art').dataset.animation,'idle');
      h.window.dispatch('pagehide');
    }
    assert.equal(quotes.size,3,'Random draws should reach three distinct user-facing lines');
  });
}

test('historical engine trades do not replay on initial snapshot or subsequent identical polls', async()=>{
  const initial=snapshot();initial.game.events=[{id:'old',type:'trade',payload:{action:'buy'},time:1}];
  const h=harness({initial});await h.ready();await h.advance(4000);
  assert.equal(h.stage.dataset.expression,'idle');assert.equal(h.elements.get('pet-speech').textContent,'');h.window.dispatch('pagehide');
});

test('desktop never loads chart script or instantiates charts',async()=>{
  const h=harness();await h.ready();await h.advance(4000);
  assert.equal(h.document.body.dataset.localConnection,'online');assert.equal(h.document.head.children.length,0);assert.equal(h.charts.length,0);
  assert.equal(h.elements.get('market-strip').children.length,0);assert.equal(h.calls.length,3);h.window.dispatch('pagehide');
});

test('initially hidden page hydrates once; visibility resumes a single polling chain',async()=>{
  const h=harness({hidden:true});await h.ready();assert.equal(h.calls.length,1);await h.advance(5000);assert.equal(h.calls.length,1);
  h.document.hidden=false;h.document.dispatch('visibilitychange');await h.ready();assert.equal(h.calls.length,2);
  await h.advance(2000);assert.equal(h.calls.length,3);h.document.hidden=true;h.document.dispatch('visibilitychange');
  await h.advance(5000);assert.equal(h.calls.length,3);h.window.dispatch('pagehide');
});

test('native hidden event stops polling and native show resumes it',async()=>{
  const h=harness();await h.ready();h.window.dispatch('jiuliu-visibility',{visible:false});await h.advance(8000);assert.equal(h.calls.length,1);
  h.window.dispatch('jiuliu-visibility',{visible:true});await h.ready();assert.equal(h.calls.length,2);await h.advance(2000);assert.equal(h.calls.length,3);h.window.dispatch('pagehide');
});

test('pagehide removes charts/timers; pageshow recreates charts with only one polling chain',async()=>{
  const h=harness({desktop:false});await h.ready();assert.equal(h.charts.length,3);
  h.window.dispatch('pagehide');assert(h.charts.every(c=>c.removed));assert.equal(h.timers.size,0);
  h.window.dispatch('pageshow');await h.ready();assert.equal(h.charts.length,6);assert.equal(h.calls.length,2);
  await h.advance(1000);assert.equal(h.calls.length,3);h.window.dispatch('pagehide');
});

test('initial historical service cues must not replay old animation', async()=>{
  const h=harness({initial:snapshot({cues:[{id:'old-cli',name:'buy',time:1}]})});await h.ready();
  assert.equal(h.stage.dataset.expression,'idle');
});

test('Image loaded during a cue must return to idle with its host',async()=>{
  const h=harness({svgLoaded:false});await h.ready();h.setResponse(snapshot({cues:[{id:'new',name:'buy',time:1700000002000}]}));
  await h.advance(2000);h.loadSvg();assert.equal(h.elements.get('pet-art').dataset.animation,'buy');await h.advance(2200);
  assert.equal(h.stage.dataset.expression,'idle');assert.equal(h.elements.get('pet-art').dataset.animation,'idle');
});

test('desktop receives floating-profit threshold reactions without opening the dashboard',async()=>{
  const initial=snapshot();initial.game.positions.CPU={instrumentId:'CPU',quantity:10,avgPrice:100,debt:0};
  const h=harness({initial});await h.ready();const next=structuredClone(initial);next.game.instruments[0].price=130;
  h.setResponse(next);await h.advance(2000);assert.equal(h.stage.dataset.expression,'profit');
});

 test('initial service history displays latest speech without replaying expressions',async()=>{
  const h=harness({initial:snapshot({cues:[{id:'old',name:'buy',time:1},{id:'say',name:'say',text:'最近的台词',time:2}],expression:{name:'happy',time:1},message:{text:'最近的台词',time:2}})});await h.ready();
  assert.equal(h.stage.dataset.expression,'idle');assert.equal(h.elements.get('pet-speech').textContent,'最近的台词');await h.advance(4000);assert.equal(h.stage.dataset.expression,'idle');h.window.dispatch('pagehide');
});

test('native pet tap produces visible reaction and finite idle restoration',async()=>{const h=harness({random:.5});await h.ready();h.window.dispatch('jiuliu-pet-tap');assert.equal(h.stage.dataset.expression,'idle');assert.equal(h.stage.dataset.interaction,'press');assert.match(h.elements.get('pet-speech').textContent,/摸摸/);await h.advance(320);assert.equal(h.stage.dataset.expression,'idle');h.window.dispatch('pagehide');});
test('idle gesture is scheduled within 6–12s, ends after 1600ms, and stops when hidden',async()=>{const h=harness({random:.5});await h.ready();await h.advance(9000);assert.equal(h.stage.dataset.idle,'look');await h.advance(1600);assert.equal(h.stage.dataset.idle,'');h.window.dispatch('jiuliu-visibility',{visible:false});const calls=h.calls.length;await h.advance(60000);assert.equal(h.stage.dataset.idle,'');assert.equal(h.calls.length,calls);h.window.dispatch('pagehide');});
test('reduced motion schedules no idle gestures',async()=>{const h=harness({reducedMotion:true});await h.ready();await h.advance(60000);assert(!h.stage.dataset.idle);assert(![...h.timers.values()].some(t=>t.delay>=15000));h.window.dispatch('pagehide');});
test('local meme picker loads small index and offers image paths without posting trades',async()=>{const h=harness({random:.5});await h.ready();h.elements.get('meme-popover').hidden=true;h.elements.get('meme-toggle').dispatch('click');await h.ready();assert.equal(h.elements.get('meme-popover').hidden,false);assert.equal(h.elements.get('meme-image').src,'assets/meme-generated-profit.png');assert.equal(h.elements.get('meme-open').href,'assets/meme-generated-profit.png');assert.equal(h.elements.get('meme-copy').hidden,true);h.elements.get('meme-close').dispatch('click');assert.equal(h.elements.get('meme-popover').hidden,true);h.window.dispatch('pagehide');});

test('new native sources expose honest units while old agent and mouse cards stay hidden',async()=>{const initial=snapshot();const base=initial.game.instruments[0];initial.game.instruments=['MOUSE_DISTANCE','MOUSE_CLICKS','KEYBOARD','THREADS','CONNECTIONS','DSH','CODEX','CLAUDE','MOUSE_BATTERY','MOUSE_FREQUENCY'].map(id=>({...base,id,name:id,metric:id==='DSH'?'dshTokens':'test'}));const h=harness({desktop:false,initial});await h.ready();const tiles=h.elements.get('market-strip').children;assert.equal(tiles.length,6);for(const [id,unit] of Object.entries({MOUSE_DISTANCE:'pt/s',MOUSE_CLICKS:'clicks/s',KEYBOARD:'keys/s',THREADS:'线程',CONNECTIONS:'连接',DSH:'tokens/s'})){const tile=tiles.find(t=>t.dataset.id===id);assert(tile);assert(tile.querySelector('.tile-value').textContent.includes(unit));}h.window.dispatch('pagehide');});

test('kernel TCP count is described as endpoints rather than established connections',async()=>{const initial=snapshot();initial.game.instruments[0].id='CONNECTIONS';initial.telemetry.connections={source:'macos-kernel-tcp-count',status:'available'};const h=harness({desktop:false,initial});await h.ready();assert.match(h.elements.get('chart-source').textContent,/包含监听及其他状态，并非仅已建立连接/);assert.match(h.elements.get('chart-source').textContent,/macos-kernel-tcp-count/);h.window.dispatch('pagehide');});

test('new instrument IDs resolve telemetry without metric and show actual source and permission reason',async()=>{const initial=snapshot();initial.game.instruments=[{id:'MOUSE_DISTANCE',name:'指针距离',price:0,history:[],hasSamples:false}];initial.telemetry.mouseDistance={status:'unavailable',reason:'permission-required',source:'native-pointer-events'};const h=harness({desktop:false,initial});await h.ready();const tile=h.elements.get('market-strip').children[0];assert.equal(tile.querySelector('.tile-status').textContent,'需要输入监控权限');assert.match(h.elements.get('chart-source').textContent,/native-pointer-events/);assert.match(h.elements.get('chart-source').textContent,/需要输入监控权限/);h.window.dispatch('pagehide');});

test('native meme sharing is explicit and posts only the allowlisted basename',async()=>{const h=harness({random:.5}),sent=[];h.window.webkit={messageHandlers:{petMemeShare:{postMessage(value){sent.push(value);}}}};await h.ready();h.elements.get('meme-popover').hidden=true;h.elements.get('meme-toggle').dispatch('click');await h.ready();assert.equal(h.elements.get('meme-share').hidden,false);assert.equal(sent.length,0);h.elements.get('meme-share').dispatch('click');await h.ready();assert.equal(sent.length,1);assert.equal(sent[0].file,'meme-generated-profit.png');assert.deepEqual(Object.keys(sent[0]),['file']);h.window.dispatch('pagehide');});
test('unsupported browser exposes fallback text and no share button',async()=>{const h=harness({random:.5});await h.ready();h.elements.get('meme-popover').hidden=true;h.elements.get('meme-toggle').dispatch('click');await h.ready();assert.equal(h.elements.get('meme-share').hidden,true);assert.match(h.elements.get('meme-status').textContent,/不支持系统分享/);h.window.dispatch('pagehide');});

test('browser file sharing is capability-checked and invoked only on click',async()=>{const h=harness({random:.5}),sent=[];h.navigator.canShare=({files})=>files.length===1&&files[0].name==='meme-generated-profit.png';h.navigator.share=async payload=>{sent.push(payload);};await h.ready();h.elements.get('meme-popover').hidden=true;h.elements.get('meme-toggle').dispatch('click');await h.ready();assert.equal(h.elements.get('meme-share').hidden,false);assert.equal(sent.length,0);h.elements.get('meme-share').dispatch('click');await h.ready();assert.equal(sent.length,1);assert.equal(sent[0].files[0].name,'meme-generated-profit.png');h.window.dispatch('pagehide');});

test('missing performance stays empty without inventing an initial balance point',async()=>{const h=harness({desktop:false});await h.ready();assert.equal(h.elements.get('performance-empty').textContent,'从现在开始记录');assert.equal(h.elements.get('performance-empty').hidden,false);assert.equal(h.charts.at(-1).data.datasets[0].data.length,0);h.window.dispatch('pagehide');});
test('performance contract uses direct percentage and real net income, with stale valuation notice',async()=>{const p={time:1700000000000,equity:10500,pnl:500,returnPct:5,stale:true};const h=harness({desktop:false,initial:snapshot({chartHistory:{timeframe:'minute',intervalMs:60000,markets:{},equity:[{time:p.time,open:10500,high:10500,low:10500,close:10500}],trades:[]},performance:{baseline:10000,startedAt:p.time,points:[p],current:p}})});await h.ready();assert.equal(h.elements.get('performance-return').textContent,'+5.00%');assert.match(h.elements.get('performance-pnl').textContent,/500/);assert.match(h.elements.get('performance-note').textContent,/持仓报价已过期/);assert.equal(h.charts.at(-1).data.datasets[0].data[0].c,5);h.window.dispatch('pagehide');});
test('zero baseline disables percentage and displays raw equity',async()=>{const p={time:1700000000000,equity:20,pnl:20,returnPct:null,stale:false};const h=harness({desktop:false,initial:snapshot({chartHistory:{timeframe:'minute',intervalMs:60000,markets:{},equity:[{time:p.time,open:20,high:20,low:20,close:20}],trades:[]},performance:{baseline:0,startedAt:p.time,points:[p],current:p}})});await h.ready();assert.equal(h.elements.get('performance-return-option').disabled,true);assert.equal(h.elements.get('performance-mode').value,'equity');assert.equal(h.charts.at(-1).data.datasets[0].data[0].c,20);h.window.dispatch('pagehide');});
test('hidden main view stops chart activity and restores existing instances',async()=>{const h=harness({desktop:false});await h.ready();h.document.hidden=true;h.document.dispatch('visibilitychange');assert(h.charts.every(c=>c.paused));const length=h.charts.length,calls=h.calls.length;await h.advance(10000);assert.equal(h.calls.length,calls);h.document.hidden=false;h.document.dispatch('visibilitychange');await h.ready();assert.equal(h.charts.length,length);assert(h.charts.every(c=>!c.paused));h.window.dispatch('pagehide');});

test('late first performance response retains default return-rate view',async()=>{const h=harness({desktop:false});await h.ready();const p={time:1700000000000,equity:10500,pnl:500,returnPct:5,stale:false};h.setResponse(snapshot({chartHistory:{timeframe:'minute',intervalMs:60000,markets:{},equity:[{time:p.time,open:10500,high:10500,low:10500,close:10500}],trades:[]},performance:{baseline:10000,startedAt:p.time,points:[p],current:p}}));await h.advance(1000);assert.equal(h.elements.get('performance-mode').value,'return');assert.equal(h.charts.at(-1).data.datasets[0].data[0].c,5);h.window.dispatch('pagehide');});

test('borrow requires 100k to 3m while repayment independently permits one',async()=>{const h=harness({desktop:false,allowActions:true});await h.ready();h.elements.get('loan-size').value='500';h.elements.get('borrow-button').dispatch('click');await h.ready();assert.equal(h.actions.length,0);h.elements.get('loan-size').value='100000';h.elements.get('borrow-button').dispatch('click');await h.ready();assert.deepEqual(h.actions[0],{action:'borrow',amount:100000});h.elements.get('repay-size').value='1';h.elements.get('repay-button').dispatch('click');await h.ready();assert.deepEqual(h.actions[1],{action:'repay',amount:1});h.window.dispatch('pagehide');});
test('bankruptcy is one explicit action and autoBorrow uses server state',async()=>{const initial=snapshot();initial.game.automation.autoBorrow=true;const h=harness({desktop:false,allowActions:true,initial});await h.ready();assert.equal(h.elements.get('auto-borrow').checked,true);assert.equal(h.actions.length,0);h.elements.get('bankruptcy-button').dispatch('click');await h.ready();assert.deepEqual(h.actions,[{action:'bankruptcy'}]);h.elements.get('auto-borrow').checked=false;h.elements.get('auto-borrow').dispatch('change');await h.ready();assert.deepEqual(h.actions[1],{action:'automation',automation:{autoBorrow:false}});h.window.dispatch('pagehide');});
test('bankruptcy episode replaces curve, retains loss ledger and never plots old-run points',async()=>{const point={time:1700000000000,equity:10000,pnl:0,returnPct:0};const h=harness({desktop:false,initial:snapshot({performance:{episode:1,baseline:10000,points:[point],current:point}})});await h.ready();const old=h.charts.at(-1),next=snapshot({performance:{episode:2,baseline:0,points:[],current:{...point,equity:0,pnl:0,returnPct:null},lastRun:{episode:1,equity:-100000000000,pnl:-100000010000,points:[point]}}});next.game.bankruptcyLedger={count:1,totalCrystallizedLoss:100000010000,records:[]};h.setResponse(next);await h.advance(1000);assert.equal(old.removed,true);assert.equal(h.charts.at(-1).data.datasets[0].data.length,0);assert.equal(h.elements.get('performance-mode').value,'equity');assert.equal(h.elements.get('bankruptcy-count').textContent,'1');assert.match(h.elements.get('settled-loss').textContent,/亿/);assert.match(h.elements.get('settled-loss').title,/100,000,010,000/);assert.match(h.elements.get('previous-round').textContent,/上轮 #1/);h.window.dispatch('pagehide');});

test('drag cancels play, suppresses tap, lands within 400ms, never emits buy',async()=>{const h=harness();await h.ready();h.window.dispatch('jiuliu-pet-action',{name:'stretch'});assert.equal(h.stage.dataset.idle,'stretch');h.window.dispatch('jiuliu-pet-drag',{phase:'start'});assert.equal(h.stage.dataset.idle,'');assert.equal(h.stage.dataset.interaction,'dragging');h.window.dispatch('jiuliu-pet-tap');assert.equal(h.stage.dataset.expression,'idle');assert.equal(h.stage.dataset.interaction,'dragging');h.window.dispatch('jiuliu-pet-drag',{phase:'end'});assert.equal(h.stage.dataset.interaction,'landing');h.window.dispatch('jiuliu-pet-tap');assert.equal(h.stage.dataset.interaction,'landing');await h.advance(360);assert.equal(h.stage.dataset.interaction,'');assert.equal(h.elements.get('pet-art').dataset.animation,'idle');h.window.dispatch('pagehide');assert.equal(h.timers.size,0);});
test('trade cue preempts play, and menu play cannot override active trade',async()=>{const h=harness();await h.ready();h.window.dispatch('jiuliu-pet-action',{name:'sleep'});const next=snapshot({cues:[{id:'fresh-play',time:1700000002000,name:'buy',text:'trade'}]});h.setResponse(next);await h.advance(2000);assert.equal(h.stage.dataset.idle,'');assert.equal(h.stage.dataset.expression,'buy');h.window.dispatch('jiuliu-pet-action',{name:'wave'});assert.equal(h.stage.dataset.expression,'buy');assert.equal(h.stage.dataset.idle,'');h.window.dispatch('pagehide');});
test('idle choices do not repeat and hidden cancels drag and APNG motion',async()=>{const h=harness({random:.5});await h.ready();await h.advance(9000);const first=h.stage.dataset.idle;await h.advance(1600+9000);assert.notEqual(h.stage.dataset.idle,first);h.window.dispatch('jiuliu-pet-drag',{phase:'start'});h.window.dispatch('jiuliu-visibility',{visible:false});assert.equal(h.stage.dataset.interaction,'');assert.equal(h.elements.get('pet-art').dataset.animation,'static');await h.advance(20000);assert.equal(h.stage.dataset.idle,'');h.window.dispatch('pagehide');});
test('reduced motion tap/menu/drag speak without local animation',async()=>{const h=harness({reducedMotion:true});await h.ready();for(const name of ['wave','stretch','sleep']){h.window.dispatch('jiuliu-pet-action',{name});assert(!h.stage.dataset.idle);assert(!h.stage.dataset.interaction);}h.window.dispatch('jiuliu-pet-tap');assert.match(h.elements.get('pet-speech').textContent,/摸摸/);assert.equal(h.stage.dataset.expression,'idle');h.window.dispatch('jiuliu-pet-drag',{phase:'start'});assert(!h.stage.dataset.interaction);h.window.dispatch('jiuliu-pet-drag',{phase:'end'});h.window.dispatch('pagehide');assert.equal(h.timers.size,0);});

test('short UI submits short/cover and displays authoritative equity without long asset math',async()=>{const initial=snapshot({performance:{current:{equity:123,pnl:-5,returnPct:-1},baseline:10000}});initial.game.positions.CPU={instrumentId:'CPU',side:'short',quantity:2,avgPrice:110,margin:50,accruedInterest:3};const h=harness({desktop:false,initial,allowActions:true});await h.ready();assert.match(h.elements.get('equity-value').textContent,/123/);assert.match(h.elements.get('position-summary').textContent,/空仓/);h.elements.get('order-side').value='short';h.elements.get('order-size').value='100';h.elements.get('leverage').value='2';h.elements.get('trade-form').dispatch('submit');await h.ready();assert.equal(h.actions[0].action,'short');h.elements.get('sell-button').dispatch('click');await h.ready();assert.equal(h.actions[1].action,'cover');h.window.dispatch('pagehide');});
test('timeframe selector requests only the selected frame',async()=>{const h=harness({desktop:false});await h.ready();h.elements.get('chart-timeframe').value='hour';h.elements.get('chart-timeframe').dispatch('change');await h.ready();assert.equal(h.calls.at(-1),'/api/state?timeframe=hour');h.window.dispatch('pagehide');});
test('saturated ledger states lower bound rather than exact cumulative loss',async()=>{const initial=snapshot();initial.game.bankruptcyLedger={count:2,totalCrystallizedLoss:Number.MAX_SAFE_INTEGER,totalsCapped:true};const h=harness({desktop:false,initial});await h.ready();assert.match(h.elements.get('settled-loss').textContent,/^≥/);assert.match(h.elements.get('settled-loss').title,/并非精确/);h.window.dispatch('pagehide');});

test('whole market card selects while pointer dragging or wheel does not select',async()=>{const initial=snapshot();initial.game.instruments.push({...initial.game.instruments[0],id:'MEM',name:'内存'});const h=harness({desktop:false,initial});await h.ready();const tile=h.elements.get('market-strip').children[1];tile.dispatch('pointerdown',null,{clientX:10,clientY:10});tile.dispatch('pointermove',null,{clientX:30,clientY:10});tile.dispatch('pointerup',null,{clientX:30,clientY:10});tile.dispatch('click');assert.equal(h.elements.get('selected-symbol').textContent,'CPU');tile.dispatch('wheel');tile.dispatch('click');assert.equal(h.elements.get('selected-symbol').textContent,'CPU');tile.dispatch('pointerdown',null,{clientX:10,clientY:10});tile.dispatch('pointerup',null,{clientX:10,clientY:10});tile.dispatch('click');assert.equal(h.elements.get('selected-symbol').textContent,'MEM');h.window.dispatch('pagehide');});
test('market title retains keyboard selection after wheel interaction',async()=>{const initial=snapshot();initial.game.instruments.push({...initial.game.instruments[0],id:'MEM'});const h=harness({desktop:false,initial});await h.ready();const tile=h.elements.get('market-strip').children[1];tile.dispatch('wheel');tile.querySelector('button').dispatch('keydown',null,{key:'Enter'});tile.querySelector('button').dispatch('click');assert.equal(h.elements.get('selected-symbol').textContent,'MEM');h.window.dispatch('pagehide');});
test('quote and net-income signs use positive red negative green semantics including neutral zero',async()=>{const initial=snapshot({performance:{baseline:10000,current:{equity:10100,pnl:100,returnPct:1}}});initial.game.instruments[0].changePct=.1;const h=harness({desktop:false,initial});await h.ready();for(const id of ['price-change','pnl-value','performance-pnl','performance-return'])assert.equal(h.elements.get(id).dataset.change,'positive');initial.game.instruments[0].changePct=-.1;initial.performance.current={equity:9900,pnl:-100,returnPct:-1};h.setResponse(initial);await h.advance(1000);for(const id of ['price-change','pnl-value','performance-pnl','performance-return'])assert.equal(h.elements.get(id).dataset.change,'negative');initial.game.instruments[0].changePct=0;initial.performance.current={equity:10000,pnl:0,returnPct:0};h.setResponse(initial);await h.advance(1000);assert.equal(h.elements.get('performance-return').dataset.change,'neutral');h.window.dispatch('pagehide');});
test('removed explanatory copy never reappears after normal polling',async()=>{assert.doesNotMatch(html,/离线图表 · MIT|仅游戏内一键平账，不是法律程序/);assert.doesNotMatch(source,/真实账户OHLC，所有图共享时间窗口/);const h=harness({desktop:false,initial:snapshot({performance:{baseline:10000,current:{equity:10000,pnl:0,returnPct:0}}})});await h.ready();assert.equal(h.elements.get('performance-note').hidden,true);assert.equal(h.elements.get('performance-note').textContent,'');await h.advance(1000);assert.equal(h.elements.get('performance-note').hidden,true);h.window.dispatch('pagehide');});

test('demo actions play APNG and speech without posting financial actions',async()=>{const h=harness({allowActions:true});await h.ready();h.window.dispatch('jiuliu-pet-action',{name:'demo'});assert.equal(h.elements.get('action-popover').hidden,false);h.elements.get('action-buy').dispatch('click');assert.match(h.elements.get('pet-art').getAttribute('src'),/^assets\/kurumi-apng\/buy\.png\?play=\d+$/);assert.match(h.elements.get('pet-speech').textContent,/演给你看/);assert.equal(h.actions.length,0);assert.equal(h.stage.dataset.expression,'idle');await h.advance(2200);assert.equal(h.elements.get('pet-art').dataset.animation,'idle');h.window.dispatch('pagehide');assert.equal(h.elements.get('pet-art').dataset.animation,'static');});
test('ordinary polls never reload the stable idle APNG image',async()=>{
  const h=harness();await h.ready();const image=h.elements.get('pet-art'),src=image.getAttribute('src');
  assert.match(src,/^assets\/kurumi-apng\/idle\.png\?play=\d+$/);const writes=image.attributeWrites.filter(x=>x.name==='src').length;
  await h.advance(4000);assert.equal(h.elements.get('pet-art'),image);assert.equal(image.getAttribute('src'),src);assert.equal(image.attributeWrites.filter(x=>x.name==='src').length,writes);h.window.dispatch('pagehide');
});
test('identical service cue polls never reload an active APNG action',async()=>{
  const h=harness({random:.5});await h.ready();h.setResponse(snapshot({cues:[{id:'stable-action',name:'buy',time:1700000002000}]}));await h.advance(2000);
  const image=h.elements.get('pet-art'),src=image.getAttribute('src'),writes=image.attributeWrites.filter(x=>x.name==='src').length;assert.match(src,/^assets\/kurumi-apng\/buy\.png\?play=\d+$/);
  await h.advance(2000);assert.equal(h.stage.dataset.expression,'buy');assert.equal(h.elements.get('pet-art'),image);assert.equal(image.getAttribute('src'),src);assert.equal(image.attributeWrites.filter(x=>x.name==='src').length,writes);
  await h.advance(200);assert.equal(image.dataset.animation,'idle');h.window.dispatch('pagehide');
});
for(const lifecycle of ['document-hidden','native-hidden','reduced-motion','pagehide'])test(`${lifecycle} stops APNG decoding with the static PNG and restores only idle`,async()=>{
  const h=harness({random:.5});await h.ready();const image=h.elements.get('pet-art');h.window.dispatch('jiuliu-pet-action',{name:'sleep'});assert.match(image.getAttribute('src'),/kurumi-apng\/sleep\.png/);
  if(lifecycle==='document-hidden'){h.document.hidden=true;h.document.dispatch('visibilitychange');}
  else if(lifecycle==='native-hidden')h.window.dispatch('jiuliu-visibility',{visible:false});
  else if(lifecycle==='reduced-motion'){h.motion.matches=true;h.motion.dispatch('change');}
  else h.window.dispatch('pagehide');
  assert.equal(image.getAttribute('src'),'assets/kurumi-generated-idle.png');assert.equal(image.dataset.animation,'static');const writes=image.attributeWrites.filter(x=>x.name==='src').length;
  await h.advance(4000);assert.equal(image.getAttribute('src'),'assets/kurumi-generated-idle.png');assert.equal(image.attributeWrites.filter(x=>x.name==='src').length,writes);
  if(lifecycle==='document-hidden'){h.document.hidden=false;h.document.dispatch('visibilitychange');}
  else if(lifecycle==='native-hidden')h.window.dispatch('jiuliu-visibility',{visible:true});
  else if(lifecycle==='reduced-motion'){h.motion.matches=false;h.motion.dispatch('change');}
  else h.window.dispatch('pageshow');
  await h.ready();assert.equal(h.elements.get('pet-art'),image);assert.equal(image.dataset.animation,'idle');assert.match(image.getAttribute('src'),/^assets\/kurumi-apng\/idle\.png\?play=\d+$/);h.window.dispatch('pagehide');assert.equal(image.getAttribute('src'),'assets/kurumi-generated-idle.png');assert.equal(h.timers.size,0);
});
test('runtime has no SVG object fallback',()=>{assert.doesNotMatch(source,/contentDocument/);assert.doesNotMatch(html,/<object|jiuliu-chibi.svg/);assert.match(html,/<img id="pet-art"/);});


test('initial speech expires once across identical polls without resetting its deadline',async()=>{
  const h=harness({initial:snapshot({message:{text:'读完就收起，不一直占着',time:1}})});await h.ready();
  assert.equal(h.elements.get('pet-bubble').hidden,false);await h.advance(5999);assert.equal(h.elements.get('pet-bubble').dataset.state,'visible');
  await h.advance(1);assert.equal(h.elements.get('pet-bubble').dataset.state,'leaving');await h.advance(250);assert.equal(h.elements.get('pet-bubble').hidden,true);assert.equal(h.elements.get('pet-speech').textContent,'');h.window.dispatch('pagehide');assert.equal(h.timers.size,0);
});
test('manual meme picker covers speech and resumes its remaining display time',async()=>{
  const h=harness({initial:snapshot({message:{text:'关掉表情包后继续看',time:1}})});await h.ready();await h.advance(2000);
  h.elements.get('meme-toggle').dispatch('click');assert.equal(h.elements.get('pet-bubble').hidden,true);await h.ready();assert.equal(h.elements.get('meme-popover').hidden,false);
  await h.advance(10000);h.elements.get('meme-close').dispatch('click');assert.equal(h.elements.get('meme-image').getAttribute('src'),undefined);assert.equal(h.elements.get('pet-bubble').hidden,false);
  await h.advance(3999);assert.equal(h.elements.get('pet-bubble').dataset.state,'visible');await h.advance(251);assert.equal(h.elements.get('pet-bubble').hidden,true);h.window.dispatch('pagehide');
});
for(const random of [.199,.2])test(`automatic meme uses a strict 20% probability boundary (${random})`,async()=>{
  const h=harness({random});await h.ready();h.setResponse(snapshot({cues:[{id:'reaction',name:'buy',time:2}]}));await h.advance(2000);
  assert.equal(h.elements.get('pet-speech-image').hidden,random>=.2);assert.equal(h.elements.get('pet-bubble').hidden,false);assert.equal(h.elements.get('meme-popover').hidden,true);h.window.dispatch('pagehide');
});
test('automatic meme cooldown allows another image only after twelve seconds',async()=>{
  const h=harness({random:.1});await h.ready();h.setResponse(snapshot({cues:[{id:'first-image',name:'buy',time:2}]}));await h.advance(2000);assert.equal(h.elements.get('pet-speech-image').hidden,false);
  h.setResponse(snapshot({cues:[{id:'too-soon',name:'buy',time:4}]}));await h.advance(2000);assert.equal(h.elements.get('pet-speech-image').hidden,true);
  await h.advance(8000);h.setResponse(snapshot({cues:[{id:'next-image',name:'buy',time:14}]}));await h.advance(2000);assert.equal(h.elements.get('pet-speech-image').hidden,false);h.window.dispatch('pagehide');
});
for(const lifecycle of ['hidden','pagehide'])test(`late automatic image and manual picker cannot resurrect after ${lifecycle}`,async()=>{
  let resolveIndex;const pending=new Promise(resolve=>{resolveIndex=resolve;});const h=harness({random:.1,memeResponse:()=>pending});await h.ready();
  h.setResponse(snapshot({cues:[{id:'delayed',name:'buy',time:2}]}));await h.advance(2000);h.elements.get('meme-toggle').dispatch('click');
  if(lifecycle==='hidden'){h.document.hidden=true;h.document.dispatch('visibilitychange');}else h.window.dispatch('pagehide');
  assert.equal(h.timers.size,0);resolveIndex({ok:true,json:async()=>[{path:'assets/meme-generated-profit.png',caption:'延迟图片',type:'buy'}]});await h.ready();
  assert.equal(h.timers.size,0);assert.equal(h.elements.get('pet-bubble').hidden,true);assert.equal(h.elements.get('pet-speech-image').getAttribute('src'),undefined);assert.equal(h.elements.get('meme-image').getAttribute('src'),undefined);assert.equal(h.elements.get('meme-popover').hidden,true);h.window.dispatch('pagehide');
});
test('manual picker invalidates an earlier automatic image even when reopened and closed before loading',async()=>{
  let resolveIndex;const pending=new Promise(resolve=>{resolveIndex=resolve;});const h=harness({random:.1,memeResponse:()=>pending});await h.ready();h.setResponse(snapshot({cues:[{id:'auto-delayed',name:'buy',time:2}]}));await h.advance(2000);
  h.elements.get('meme-toggle').dispatch('click');h.elements.get('meme-close').dispatch('click');resolveIndex({ok:true,json:async()=>[{path:'assets/meme-generated-profit.png',caption:'延迟图片',type:'buy'}]});await h.ready();
  assert.equal(h.elements.get('meme-popover').hidden,true);assert.equal(h.elements.get('pet-speech-image').hidden,true);assert.equal(h.elements.get('pet-bubble').hidden,false);h.window.dispatch('pagehide');
});
test('superseded speech rejects its delayed automatic image',async()=>{
  let resolveIndex;const pending=new Promise(resolve=>{resolveIndex=resolve;});const h=harness({random:.1,memeResponse:()=>pending});await h.ready();h.setResponse(snapshot({cues:[{id:'auto-old',name:'buy',time:2}]}));await h.advance(2000);
  h.setResponse(snapshot({message:{text:'更新的文字单独显示',time:4}}));await h.advance(2000);resolveIndex({ok:true,json:async()=>[{path:'assets/meme-generated-profit.png',caption:'旧图片',type:'buy'}]});await h.ready();assert.equal(h.elements.get('pet-speech').textContent,'更新的文字单独显示');assert.equal(h.elements.get('pet-speech-image').hidden,true);h.window.dispatch('pagehide');
});
test('late poll has no timers or speech after hide and never replays after show',async()=>{
  let resolveState;const pending=new Promise(resolve=>{resolveState=resolve;});const h=harness({stateResponse:()=>pending});
  h.document.hidden=true;h.document.dispatch('visibilitychange');assert.equal(h.timers.size,0);
  resolveState({ok:true,json:async()=>snapshot({message:{text:'隐藏期间的旧消息',time:1},cues:[{id:'hidden-cue',name:'buy',time:2}]})});await h.ready();
  assert.equal(h.timers.size,0);assert.equal(h.elements.get('pet-bubble').hidden,true);assert.equal(h.stage.dataset.expression,'idle');h.window.dispatch('pagehide');
});
test('desktop bubble geometry stays within the compact DOM and preserves reduced-motion styling',()=>{
  const css=fs.readFileSync(path.join(__dirname,'..','pet.css'),'utf8');
  assert.match(css,/\.desktop-mode \.workspace\{height:416px\}/);assert.match(css,/\.desktop-mode #pet-stage\{inset:145px 0 auto;height:240px/);assert.match(css,/\.desktop-mode \.pet-tools\{top:388px\}/);
  assert.match(css,/\.desktop-mode \.pet-bubble\{bottom:calc\(100% - 7px\);[^}]*max-height:146px/);assert.match(css,/transition:opacity \.25s ease/);assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\.pet-bubble\{transition:none/);
  assert.equal((html.match(/id="pet-bubble"/g)||[]).length,1);assert.match(html,/<div id="pet-bubble"[^>]*>[\s\S]*?id="pet-speech-image"[\s\S]*?id="pet-speech"/);
});
