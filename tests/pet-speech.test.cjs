'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {create, duration} = require('../pet-speech.js');

function harness({reduced = false} = {}) {
  let clock = 0, serial = 0, commits = 0;
  const timers = new Map(), classes = new Set();
  const root = {hidden:true, dataset:{}, classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}}, get offsetWidth(){commits++;return 200;}};
  const text = {textContent:''}, attributes = {};
  const image = {hidden:true, alt:'', getAttribute:name=>attributes[name], setAttribute(name,value){attributes[name]=value;}, removeAttribute(name){delete attributes[name];}};
  const speech = create({root,text,image,now:()=>clock,reducedMotion:()=>reduced,
    setTimer(fn,delay){const id=++serial;timers.set(id,{fn,at:clock+delay,delay});return id;},clearTimer:id=>timers.delete(id)});
  return {speech,root,text,image,attributes,timers,classes,get commits(){return commits;},
    reduce(value){reduced=value;},advance(ms){const end=clock+ms;for(;;){const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;clock=next[1].at;timers.delete(next[0]);next[1].fn();}clock=end;}};
}

test('speech duration stays between 6 and 10 seconds and counts Unicode code points',()=>{
  assert.equal(duration('短句'),6000);assert.equal(duration('x'.repeat(1000)),10000);assert.equal(duration('🙂'.repeat(20)),6300);
});
test('one text/image slot fades in and preserves outgoing content for exactly 250ms',()=>{
  const h=harness(),token=h.speech.show({id:'first',text:'头顶的一句话'});
  assert.equal(h.root.hidden,false);assert.equal(h.root.dataset.state,'visible');assert.equal(h.commits,1);
  assert.equal(h.speech.attachImage(token,'assets/01-laugh.jpg','笑一笑'),true);assert(h.classes.has('has-image'));
  h.advance(6000);assert.equal(h.root.dataset.state,'leaving');assert.equal(h.root.hidden,false);assert.equal(h.text.textContent,'头顶的一句话');
  h.advance(249);assert.equal(h.image.hidden,false);h.advance(1);assert.equal(h.root.hidden,true);assert.equal(h.text.textContent,'');assert.equal(h.image.hidden,true);assert.equal(h.attributes.src,undefined);assert.equal(h.timers.size,0);
});
test('higher priorities win and bounded seen IDs cannot replay a dismissed message',()=>{
  const h=harness();const token=h.speech.show({id:'risk',text:'先复盘',priority:3});
  assert.equal(h.speech.show({id:'hello',text:'摸摸',priority:0}),null);assert.equal(h.text.textContent,'先复盘');
  assert.equal(h.speech.attachImage(token,'assets/01-laugh.jpg'),true);h.speech.dismiss();h.advance(250);
  assert.equal(h.speech.show({id:'risk',text:'重复风险',priority:3}),null);
  assert.notEqual(h.speech.show({id:'hello',text:'现在可以摸摸',priority:0}),null);
  for(let n=0;n<129;n++)h.speech.show({id:n,text:'新句'});
  assert.notEqual(h.speech.show({id:'risk',text:'超出有界去重窗口'}),null);h.speech.destroy();
});
test('new message cancels stale fade and old async image tokens',()=>{
  const h=harness(),old=h.speech.show({text:'旧消息'});h.advance(6000);const current=h.speech.show({text:'新消息'});
  assert.notEqual(current,old);assert.equal(h.speech.attachImage(old,'assets/01-laugh.jpg'),false);h.advance(250);assert.equal(h.root.hidden,false);assert.equal(h.text.textContent,'新消息');assert.equal(h.timers.size,1);h.speech.destroy();
});
test('manual meme cover pauses the timer then resumes its remaining lifetime',()=>{
  const h=harness(),token=h.speech.show({text:'稍后继续看',image:'assets/01-laugh.jpg'});h.advance(2000);h.speech.setCovered(true);
  assert.equal(h.root.hidden,true);assert.equal(h.attributes.src,undefined);assert.equal(h.timers.size,0);h.advance(20000);
  h.speech.attachImage(token,'assets/03-gritted-teeth.jpg');assert.equal(h.attributes.src,undefined);
  h.speech.setCovered(false);assert.equal(h.text.textContent,'稍后继续看');assert.equal(h.attributes.src,'assets/03-gritted-teeth.jpg');h.advance(3999);assert.equal(h.root.dataset.state,'visible');h.advance(1);assert.equal(h.root.dataset.state,'leaving');h.speech.destroy();
});
test('speech arriving while covered starts a full finite duration on uncover',()=>{
  const h=harness();h.speech.setCovered(true);h.speech.show({text:'覆盖期间的新句'});h.speech.setCovered(true);assert.equal(h.timers.size,0);h.advance(20000);h.speech.setCovered(false);h.advance(5999);assert.equal(h.root.hidden,false);h.advance(251);assert.equal(h.root.hidden,true);
});
test('hidden and destroyed controllers remove timers and invalidate images permanently',()=>{
  const h=harness(),token=h.speech.show({id:'once',text:'暂停时清除',image:'assets/01-laugh.jpg'});h.speech.setActive(false);
  assert.equal(h.timers.size,0);assert.equal(h.attributes.src,undefined);assert.equal(h.speech.attachImage(token,'assets/01-laugh.jpg'),false);assert.equal(h.speech.show({text:'隐藏时'}),null);
  h.speech.setActive(true);assert.equal(h.root.hidden,true);assert.equal(h.speech.show({id:'once',text:'不重放'}),null);h.speech.show({text:'恢复后新句'});h.speech.destroy();h.speech.setActive(true);assert.equal(h.speech.show({text:'销毁不能恢复'}),null);assert.equal(h.timers.size,0);
});
test('reduced motion skips layout animation and the fade timer',()=>{
  const h=harness({reduced:true});h.speech.show({text:'减少动态'});assert.equal(h.commits,0);h.advance(6000);assert.equal(h.root.hidden,true);assert.equal(h.timers.size,0);
  h.speech.show({text:'变化前'});h.reduce(false);h.advance(6000);assert.equal(h.root.dataset.state,'leaving');h.speech.setActive(false);assert.equal(h.timers.size,0);
});
test('invalid text and non-local image paths never reach the DOM',()=>{
  const h=harness();for(const text of [null,undefined,42,'','  '])assert.equal(h.speech.show({text}),null);
  const token=h.speech.show({text:'🙂'.repeat(300),image:'https://example.com/track.jpg'});assert.equal(Array.from(h.text.textContent).length,280);assert.equal(h.attributes.src,undefined);
  for(const path of ['../assets/x.jpg','assets/../x.jpg','assets/x.svg','https://example.com/x.jpg','assets/x.jpg?track=1'])assert.equal(h.speech.attachImage(token,path),false);
  assert.equal(h.speech.attachImage(token,'assets/local.jpeg'),true);h.speech.destroy();
});
