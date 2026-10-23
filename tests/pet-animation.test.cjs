'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const durations={idle:2000,wave:1600,stretch:1600,look:1600,press:320,dragging:1000,landing:360,profit:2200,buy:2200,sell:2200,loss:2200,liquidation:2200,sleep:2600,blink:1600,sway:1600};
function setup(){
  const handlers={},attrs={},writes=[];
  const image={dataset:{},getAttribute:k=>attrs[k],setAttribute(k,v){attrs[k]=v;writes.push(v);},addEventListener(k,fn){handlers[k]=fn;},removeEventListener(k){delete handlers[k];}};
  const forbidden=()=>assert.fail('Animation playback must not fetch a manifest or schedule its own timers');
  const context={window:{fetch:forbidden,setTimeout:forbidden,setInterval:forbidden,requestAnimationFrame:forbidden},fetch:forbidden,setTimeout:forbidden,setInterval:forbidden,requestAnimationFrame:forbidden};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','pet-animation.js'),'utf8'),context);
  return {player:context.window.PetAnimation.create(image),api:context.window.PetAnimation,image,writes,handlers};
}
test('all fifteen runtime actions use local APNG PNG assets without manifest fetch or playback timers',()=>{
  const h=setup();
  for(const name of Object.keys(durations)){h.player.update(name);assert.match(h.image.getAttribute('src'),new RegExp(`^assets/kurumi-apng/${name}\\.png\\?play=\\d+$`));assert.equal(h.image.dataset.animation,name);}
  assert.equal(h.writes.length,15);
});
test('same idle or action is not reloaded by poll; only explicit repeat restarts',()=>{
  const h=setup();h.player.update('idle');const idle=h.image.getAttribute('src');
  for(let n=0;n<20;n++)h.player.update('idle');assert.equal(h.writes.length,1);assert.equal(h.image.getAttribute('src'),idle);
  h.player.update('wave');const wave=h.image.getAttribute('src');
  for(let n=0;n<20;n++)h.player.update('wave');assert.equal(h.writes.length,2);assert.equal(h.image.getAttribute('src'),wave);
  h.player.update('wave',{restart:true});assert.equal(h.writes.length,3);assert.notEqual(h.image.getAttribute('src'),wave);assert.match(h.image.getAttribute('src'),/wave\.png\?play=3$/);
});
test('hidden and reduced states replace APNG with static PNG and restore only requested state',()=>{const h=setup();h.player.update('buy');h.player.update('buy',{active:false});assert.equal(h.image.getAttribute('src'),'assets/kurumi-generated-idle.png');h.player.update('sleep',{reduced:true});assert.equal(h.writes.length,2);h.player.update('idle');assert.match(h.image.getAttribute('src'),/idle\.png/);});
test('stop replaces APNG with static PNG without repeated source writes',()=>{const h=setup();h.player.update('sleep');h.player.stop();assert.equal(h.image.getAttribute('src'),'assets/kurumi-generated-idle.png');const count=h.writes.length;h.player.stop();assert.equal(h.writes.length,count);});
test('failed APNG stays static for that state without retrying on every poll',()=>{const h=setup();h.player.update('profit');h.handlers.error();assert.equal(h.image.dataset.animation,'static');const count=h.writes.length;h.player.update('profit');h.player.update('profit');assert.equal(h.writes.length,count);h.handlers.error();assert.equal(h.writes.length,count);h.player.update('wave');assert.match(h.image.getAttribute('src'),/wave\.png/);});
test('arbitrary paths cannot become image sources and destroy stops playback',()=>{const h=setup();h.player.update('https://example.com/tracker');assert.match(h.image.getAttribute('src'),/^assets\/kurumi-apng\/idle\.png/);h.player.destroy();assert.equal(h.image.getAttribute('src'),'assets/kurumi-generated-idle.png');const count=h.writes.length;h.player.update('buy');h.player.destroy();assert.equal(h.writes.length,count);assert.equal(h.image.dataset.animation,'static');assert.equal(h.handlers.error,undefined);});
test('all action durations retain the generated animation timing contract',()=>{const h=setup();assert.deepEqual({...h.api.durations},durations);assert.equal(Object.isFrozen(h.api.durations),true);});
