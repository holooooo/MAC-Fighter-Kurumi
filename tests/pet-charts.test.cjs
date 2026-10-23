'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const api = require('../pet-charts.js');
const t = 1700000000000;
const c = (time, open = 0, high = 0, low = 0, close = 0) => ({time, open, high, low, close});
const p = (time, returnPct = 0, stale = false) => ({time, equity:10000 + returnPct * 100, pnl:returnPct * 100, returnPct, stale});

test('zero-valued candles are real observations, not missing data', () => {
  assert.deepEqual(api.candles({history:[c(t)]}), [{x:t,o:0,h:0,l:0,c:0}]);
});
test('empty instruments contain no fabricated history or initial candle', () => {
  assert.deepEqual(api.candles({history:[]}), []);
});
test('current candle updates exact millisecond timestamp instead of duplicating history', () => {
  const data=api.candles({history:[c(t,1,3,0,2),c(t+10000,2,4,1,3)],currentCandle:c(t+10000,2,5,1,4)});
  assert.equal(data.length,2);assert.equal(data[1].c,4);assert.equal(data[1].x,t+10000);
});
test('OHLC does not compress gaps or discard distinct subsecond observations', () => {
  const data=api.candles({history:[c(t+60000),c(t),c(t+500)]});
  assert.deepEqual(data.map(d=>d.x),[t,t+500,t+60000]);
});
test('malformed and nonnumeric OHLC is rejected, not interpolated', () => {
  assert.equal(api.candles({history:[c(t,1,0,0,1),c(t+1,0,1,2,0),c(t+2,NaN),c('1700000000000'),c(t+3)]}).length,1);
});
test('performance is empty until real observations exist; baseline/current do not seed the curve', () => {
  assert.deepEqual(api.performancePoints(undefined),[]);
  assert.deepEqual(api.performancePoints({baseline:10000,current:p(t),points:[]}),[]);
});
test('five means five percent, gaps over twenty seconds split datasets without phantom points', () => {
  const perf={baseline:10000,points:[p(t,0),p(t+10000,5),p(t+30000,-2),p(t+50001,3)]};
  const segments=api.performanceSegments(perf,'return');
  assert.deepEqual(segments.map(s=>s.length),[3,1]);
  assert.equal(segments[0][1].y,5);assert.equal(segments[1][0].x,t+50001);
  assert.equal(segments.flat().length,perf.points.length);
});
test('stale boundary is separate and preserves actual valuations', () => {
  const segments=api.performanceSegments({points:[p(t,1),p(t+10000,1,true),p(t+20000,2)]});
  assert.deepEqual(segments.map(s=>s.length),[1,1,1]);assert.equal(segments[1][0].observation.stale,true);
});
test('zero-baseline null returns stay null; equity retains actual zero and negative values', () => {
  const perf={baseline:0,points:[{time:t,equity:0,pnl:0,returnPct:null},{time:t+10000,equity:-5,pnl:-5,returnPct:null}]};
  assert.deepEqual(api.performanceSegments(perf,'return'),[]);
  assert.deepEqual(api.performanceSegments(perf,'equity')[0].map(d=>d.y),[0,-5]);
});

function chartHarness() {
  const created=[];
  class Chart { constructor(canvas, config) {this.canvas=canvas;this.config=config;this.options=config.options;this.data=config.data;this.updates=0;created.push(this);} update(mode){assert.equal(mode,'none');this.updates++;} destroy(){this.destroyed=true;} stop(){this.stopped=true;} resize(){this.resized=true;} }
  const context={Chart,document:{createElement:()=>({attributes:{},setAttribute(k,v){this.attributes[k]=v;}})}};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'..','pet-charts.js'),'utf8'),context);
  return {api:context.PetCharts,created,container:{children:[],replaceChildren(...children){this.children=children;}}};
}
test('single real candle uses observed y bounds and bounded bar width; time axis keeps real gaps', () => {
  const h=chartHarness(),handle=h.api.createCandles(h.container);
  handle.update({id:'CPU',history:[c(t,82,88,80,85)]});
  const chart=h.created[0];
  assert.equal(chart.config.type,'candlestick');assert.equal(chart.options.scales.x.type,'time');
  assert(chart.options.scales.y.min<80);assert(chart.options.scales.y.max>88);
  assert.equal(chart.data.datasets[0].maxBarThickness,12);
  assert.equal(chart.data.datasets[0].data.length,1);
  assert.equal(chart.options.animation,false);
});
test('mini charts render only available OHLC and perform no hover or animation work', () => {
  const h=chartHarness(),handle=h.api.createCandles(h.container,{mini:true});handle.update({history:[c(t)]});
  const chart=h.created[0];assert.equal(chart.options.events.length,0);assert.equal(chart.options.animation,false);
  assert.equal(chart.data.datasets[0].data.length,1);assert.equal(chart.data.datasets[0].data[0].c,0);
  assert.equal(chart.options.plugins.legend.display,false);
});
test('account candles transform each real OHLC to direct percentage without invented points',()=>{const rows=[c(t,10000,11000,9500,10500)];assert.deepEqual(api.equityCandles(rows,10000,'return'),[{x:t,o:0,h:10,l:-5,c:5}]);assert.equal(api.equityCandles(rows,0,'return')[0].c,10500);const h=chartHarness(),handle=h.api.createPerformance(h.container);handle.update({baseline:10000},'return',rows);assert.equal(h.created[0].config.type,'candlestick');assert.equal(h.created[0].data.datasets[0].data[0].c,5);});
test('updates reuse canvases and skip identical data; destroy is idempotent', () => {
  const h=chartHarness(),handle=h.api.createCandles(h.container),instrument={history:[c(t)]};
  handle.update(instrument);handle.update(instrument);assert.equal(h.created.length,1);assert.equal(h.created[0].updates,1);
  handle.pause();assert.equal(h.created[0].stopped,true);handle.resize();assert.equal(h.created[0].resized,true);
  handle.destroy();handle.destroy();assert.equal(h.created[0].destroyed,true);assert.equal(h.container.children.length,0);
});
test('all pinned downloaded files match manifest hashes and all license files retain MIT grants', () => {
  const manifest=require('../vendor/chart-dependencies.json');assert.equal(manifest.files.length,8);
  for(const entry of manifest.files){const data=fs.readFileSync(path.join(__dirname,'..',entry.file));assert.equal(crypto.createHash('sha256').update(data).digest('hex'),entry.sha256);assert.equal(data.length,entry.bytes);assert.equal(entry.license,'MIT');if(entry.file.endsWith('LICENSE.md'))assert.match(data.toString(),/Permission is hereby granted, free of charge/);}
});
test('UI no longer loads or credits the replaced chart implementation', () => {
  const html=fs.readFileSync(path.join(__dirname,'..','pet.html'),'utf8');
  const ui=fs.readFileSync(path.join(__dirname,'..','pet-ui.js'),'utf8');
  assert.doesNotMatch(html+ui,/TradingView|LightweightCharts|lightweight-charts/);
});

test('MAX_VALUE scale padding clamps finitely without modifying observed OHLC',()=>{for(const [low,high] of [[0,Number.MAX_VALUE],[Number.MAX_VALUE,Number.MAX_VALUE],[-Number.MAX_VALUE,Number.MAX_VALUE],[-Number.MAX_VALUE,-Number.MAX_VALUE],[0,0]]){const bounds=api.priceBounds(low,high);assert(Number.isFinite(bounds.min));assert(Number.isFinite(bounds.max));assert(bounds.min<=low);assert(bounds.max>=high);assert(bounds.min<bounds.max);}const bounds=api.priceBounds(0,Number.MAX_VALUE);assert.equal(bounds.max,Number.MAX_VALUE);const h=chartHarness(),handle=h.api.createCandles(h.container);handle.update({history:[c(t,0,Number.MAX_VALUE,0,Number.MAX_VALUE)]});assert.equal(h.created[0].data.datasets[0].data[0].h,Number.MAX_VALUE);assert.equal(h.created[0].options.scales.y.max,Number.MAX_VALUE);assert(Number.isFinite(h.created[0].options.scales.y.min));});

test('shared viewport follows exact timestamps and clamps zoom to three bars',()=>{const v=api.createViewport(),ranges=[];v.subscribe(r=>ranges.push(r));v.configure(Array.from({length:180},(_,i)=>t+i*60000),60000,true);const first=v.range;v.zoom(.00001);assert.equal(v.range.max-v.range.min,180000);v.pan(-10000);assert(v.range.min>=t-120000);v.zoom(100000);assert(v.range.max-v.range.min<=183*60000);v.latest();assert.deepEqual(v.range,first);assert(ranges.length>=4);});
test('all chart instances share identical range when any viewport is changed',()=>{const h=chartHarness(),v=h.api.createViewport();v.configure([t,t+3600000],60000,true);const a=h.api.createCandles(h.container,{viewport:v}),b=h.api.createPerformance({replaceChildren(){}},{viewport:v});a.update({history:[c(t)]});b.update({baseline:10000},'equity',[c(t,10000,10000,10000,10000)]);v.zoom(.5);for(const chart of h.created){assert.equal(chart.options.scales.x.min,v.range.min);assert.equal(chart.options.scales.x.max,v.range.max);}a.destroy();b.destroy();});
test('candles and B/S markers use red rise/buy and green fall/sell',()=>{const h=chartHarness(),handle=h.api.createCandles(h.container);handle.update({id:'CPU',history:[c(t,1,3,0,2)]},['buy','sell','short','cover'].map(action=>({action,instrumentId:'CPU',time:t,price:2,quantity:1})));const chart=h.created[0];assert.equal(chart.data.datasets[0].backgroundColors.up,'#c84b5f');assert.equal(chart.data.datasets[0].backgroundColors.down,'#278268');assert.deepEqual(Array.from(chart.data.datasets[1].pointBackgroundColor),['#c84b5f','#278268','#278268','#c84b5f']);handle.destroy();});

test('B/S preserves exact fill coordinates and cover/short direction',()=>{const trades=['buy','sell','short','cover'].map((action,i)=>({id:String(i),instrumentId:'CPU',action,time:t+123,price:12.5,quantity:2,side:i>1?'short':'long',realizedPnl:4}));const marks=api.tradePoints(trades,'CPU');assert.deepEqual(marks.map(m=>m.mark),['B','S','S','B']);assert(marks.every(m=>m.x===t+123&&m.y===12.5));assert.equal(marks[3].trade.quantity,2);assert.equal(api.tradePoints(trades,'OTHER').length,0);});
