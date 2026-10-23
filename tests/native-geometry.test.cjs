'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function geometry() {
  const source = fs.readFileSync(path.join(__dirname,'../native/Sources/JiuliuPet/main.swift'),'utf8');
  const section = source.slice(source.indexOf('private func updateBodyGeometry'));
  const script = section.match(/let script = """([\s\S]*?)"""/)[1];
  const messages=[], frames=[], observers=[];
  const art={offsetLeft:165,offsetTop:0,offsetWidth:230,offsetHeight:280,
    offsetParent:{getBoundingClientRect:()=>({x:0,y:35})},
    getBoundingClientRect:()=>({x:38,y:21,width:254,height:295})};
  const control=(visible,x)=>({getClientRects:()=>visible?[{}]:[],getBoundingClientRect:()=>({x,y:376,width:80,height:40})});
  const context={document:{documentElement:{},getElementById:()=>art,querySelectorAll:()=>[control(true,100),control(false,0)]},
    getComputedStyle:()=>({visibility:'visible'}),requestAnimationFrame:fn=>frames.push(fn),
    ResizeObserver:class {constructor(fn){observers.push(fn)}observe(){}},MutationObserver:class {constructor(fn){observers.push(fn)}observe(){}},
    window:{webkit:{messageHandlers:{petDragLayout:{postMessage:m=>messages.push(JSON.parse(JSON.stringify(m)))}}},addEventListener(){}}};
  vm.runInNewContext(script,context);
  return {messages,frames,observers,art,report:context.window.__jiuliuNativeDragLayout};
}

test('native body uses stable centered layout rather than animated bounds and excludes visible controls',()=>{
  const h=geometry();
  assert.deepEqual(h.messages[0].body,{x:50,y:35,width:230,height:280});
  assert.deepEqual(h.messages[0].excluded,[{x:100,y:376,width:80,height:40}]);
  h.art.getBoundingClientRect=()=>({x:0,y:-100,width:400,height:500});
  h.report();
  assert.deepEqual(h.messages[1].body,h.messages[0].body);
});

test('native geometry coalesces observer reports and follows actual layout resizing',()=>{
  const h=geometry();
  for(let i=0;i<5;i++)for(const notify of h.observers)notify();
  assert.equal(h.frames.length,1);
  h.art.offsetWidth=200;h.frames.shift()();
  assert.deepEqual(h.messages.at(-1).body,{x:65,y:35,width:200,height:280});
  assert.equal(h.messages.length,2);
});
