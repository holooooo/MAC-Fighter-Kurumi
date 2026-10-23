'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const diary = require('../pet-diary.js');
class Element {
  constructor(tag) { this.tagName=tag; this.children=[]; this.dataset={}; this.style={}; this.listeners={}; this.open=false; this._text=''; }
  set innerHTML(_) { throw new Error('HTML injection API forbidden'); }
  set textContent(value) { this._text=String(value); this.children=[]; }
  get textContent() { return this._text+this.children.map(child=>child.textContent).join(''); }
  appendChild(child) { child.parentNode=this; this.children.push(child); return child; }
  insertBefore(child,before) { child.parentNode=this; this.children.splice(this.children.indexOf(before),0,child); }
  replaceChildren() { this.children=[]; this._text=''; }
  addEventListener(type,fn) { this.listeners[type]=fn; }
  all() { return this.children.flatMap(child=>[child,...child.all()]); }
  querySelectorAll(selector) { assert.equal(selector,'details[data-diary-id]'); return this.all().filter(el=>el.tagName==='details' && el.dataset.diaryId!==undefined); }
}
function fixture() {
  const root=new Element('section');
  const list=root.appendChild(new Element('ol')); list.id='activity-log';
  const count=root.appendChild(new Element('span')); count.id='activity-count';
  const document={createElement:tag=>new Element(tag),getElementById:id=>root.all().find(el=>el.id===id)};
  return {root,list,count,document,renderer:diary.createRenderer(document)};
}
const entry=(n,extra={})=>({id:String(n),time:1700000000000+n,instrumentId:'CPU',action:'sell',side:'long',price:20,quantity:2,...extra});
test('open never claims realized net profit; closes require a known basis',()=>{
 assert.deepEqual(diary.outcome(entry(1,{action:'buy',realizedPnl:20,pnlBasis:'net-position-interest'})),{label:'未结算',tone:'neutral'});
 assert.equal(diary.outcome(entry(1,{action:'short'})).label,'未结算');
 assert.equal(diary.outcome(entry(1,{realizedPnl:20,pnlBasis:'net-position-interest'})).label,'净收益 +20');
 assert.equal(diary.outcome(entry(1)).label,'收益依据不足');
 assert.equal(diary.outcome(entry(1,{realizedPnl:0,pnlBasis:'unknown'})).label,'旧口径收益 0');
 assert.equal(diary.outcome(entry(1,{realizedPnl:12})).label,'旧口径收益 +12');
});
test('known fields are retained including zero, absent fields never synthesized',()=>{
 const rows=diary.fields(entry(1,{interest:0,liquidated:true,episode:2}));
 assert(rows.some(([label,value])=>label==='仓位利息'&&value==='0'));
 assert(rows.some(([label,value])=>label==='强平'&&value==='是'));
 assert(!rows.some(([label])=>label==='成交额'));
 assert(!rows.some(([label])=>label==='释放保证金'));
});
test('sort is descending, input unchanged, duplicate ids removed and history bounded',()=>{
 const entries=[entry(1),entry(3),entry(2),entry(3)];
 assert.deepEqual(diary.sortedEntries({entries}).map(e=>e.id),['3','2','1']);
 assert.equal(entries[0].id,'1');
 assert.equal(diary.sortedEntries({entries:Array.from({length:600},(_,n)=>entry(n))}).length,500);
});
test('render colors positive red negative green with signed accessible text',()=>{
 const f=fixture(); f.renderer.render({entries:[entry(1,{realizedPnl:-9,pnlBasis:'net-position-interest'}),entry(2,{realizedPnl:8,pnlBasis:'net-position-interest'})]});
 const values=f.list.all().filter(el=>el.className?.startsWith('diary-pnl '));
 assert.deepEqual(values.map(el=>el.style.color),['#b53d53','#237653']);
 assert.deepEqual(values.map(el=>el.textContent),['净收益 +8','净收益 -9']);
});
test('local pagination and expanded ids survive refresh with newer transactions',()=>{
 const f=fixture(),entries=Array.from({length:30},(_,n)=>entry(n));
 f.renderer.render({entries});
 assert.equal(f.list.querySelectorAll('details[data-diary-id]').length,12);
 const opened=f.list.querySelectorAll('details[data-diary-id]')[0]; opened.open=true;
 f.list.all().find(el=>el.tagName==='button').listeners.click();
 assert.equal(f.list.querySelectorAll('details[data-diary-id]').length,24);
 f.renderer.render({entries:[...entries,entry(31)]});
 assert.equal(f.list.querySelectorAll('details[data-diary-id]').length,24);
 assert.equal(f.list.querySelectorAll('details[data-diary-id]').find(el=>el.dataset.diaryId===opened.dataset.diaryId).open,true);
 f.list.querySelectorAll('details[data-diary-id]').find(el=>el.dataset.diaryId===opened.dataset.diaryId).open=false;
 f.renderer.render({entries});
 assert.equal(f.list.querySelectorAll('details[data-diary-id]')[0].open,false);
});
test('untrusted markup remains literal text and notice is created only once',()=>{
 const f=fixture(),attack='<img src=x onerror=alert(1)>';
 const data={entries:[entry(1,{instrumentId:attack,id:attack})],partialHistory:true,truncated:true,startedAt:1700000000000};
 f.renderer.render(data); f.renderer.render(data);
 assert(f.list.textContent.includes(attack));
 assert.equal(f.root.all().filter(el=>el.tagName==='img').length,0);
 assert.equal(f.root.all().filter(el=>el.id==='diary-notice').length,1);
 assert(f.document.getElementById('diary-notice').textContent.includes('历史已截断'));
 assert(f.list.textContent.includes('个人贷款利息未分摊'));
});
test('empty and unavailable histories are explicit and module tolerates absent targets',()=>{
 const f=fixture(); f.renderer.render(null); assert(f.list.textContent.includes('等待服务')); assert.equal(f.count.textContent,'0');
 f.renderer.render({entries:[]}); assert(f.list.textContent.includes('还没有交易日记'));
 assert.doesNotThrow(()=>diary.render({entries:[]}));
 assert.doesNotThrow(()=>diary.createRenderer({getElementById:()=>null}).render({entries:[]}));
});
