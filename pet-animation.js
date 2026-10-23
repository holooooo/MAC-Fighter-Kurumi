"use strict";
// Fixed local assets only. The UI owns action durations and priorities.
window.PetAnimation = (() => {
  const names = new Set(['idle','wave','stretch','look','press','dragging','landing','profit','buy','sell','loss','liquidation','sleep','blink','sway']);
  const durations = Object.freeze({idle:2000,wave:1600,stretch:1600,look:1600,press:320,dragging:1000,landing:360,profit:2200,buy:2200,sell:2200,loss:2200,liquidation:2200,sleep:2600,blink:1600,sway:1600});
  const still = 'assets/kurumi-generated-idle.png';
  function create(image) {
    let current=null, sequence=0, disposed=false;
    const failed = new Set();
    function assign(src){if(image.getAttribute('src')!==src)image.setAttribute('src',src);}
    function update(name='idle', {active=true,reduced=false,restart=false}={}) {
      if(disposed)return;
      if(!names.has(name))name='idle';
      const next=active&&!reduced&&!failed.has(name)?name:'static';
      if(next===current&&!restart)return;
      current=next;image.dataset.animation=next;
      assign(next==='static'?still:`assets/kurumi-apng/${next}.png?play=${++sequence}`);
    }
    function error(){if(current&&current!=='static')failed.add(current);current='static';image.dataset.animation='static';assign(still);}
    image.addEventListener('error',error);
    return {update,stop(){update('idle',{active:false});},destroy(){if(disposed)return;update('idle',{active:false});disposed=true;image.removeEventListener('error',error);}};
  }
  return {create,durations};
})();
