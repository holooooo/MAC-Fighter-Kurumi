/* Local Chart.js integration. No synthetic samples and no branding overlays. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetCharts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const finite = Number.isFinite;
  const colors = { up: '#c84b5f', down: '#278268', unchanged: '#a08c98' };
  const number = value => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false });

  // Chart.js time adapters use milliseconds. Do not round away separate real samples.
  function candles(instrument = {}) {
    const rows = [...(instrument.history || [])];
    if (instrument.currentCandle) rows.push(instrument.currentCandle);
    const sorted = new Map();
    for (const c of rows) {
      if (![c.time, c.open, c.high, c.low, c.close].every(finite)) continue;
      if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.high < c.low) continue;
      sorted.set(c.time, { x: c.time, o: c.open, h: c.high, l: c.low, c: c.close });
    }
    return [...sorted.values()].sort((a, b) => a.x - b.x);
  }
  function performancePoints(performance) {
    const sorted = new Map();
    for (const p of performance?.points || []) {
      if (![p.time, p.equity, p.pnl].every(finite)) continue;
      if (p.returnPct !== null && !finite(p.returnPct)) continue;
      sorted.set(p.time, { ...p, stale: p.stale === true });
    }
    return [...sorted.values()].sort((a, b) => a.time - b.time);
  }
  function performanceSegments(performance, mode = 'return') {
    const points = performancePoints(performance), segments = [];
    let segment = [], previous = null;
    for (const p of points) {
      const y = mode === 'equity' ? p.equity : p.returnPct;
      if (!finite(y)) { if (segment.length) segments.push(segment); segment = []; previous = null; continue; }
      if (previous && (p.time - previous.time > 20000 || p.stale !== previous.stale)) {
        if (segment.length) segments.push(segment); segment = [];
      }
      segment.push({ x: p.time, y, observation: p }); previous = p;
    }
    if (segment.length) segments.push(segment);
    return segments;
  }
  function timeBounds(data) {
    if (!data.length) return {};
    const first = data[0].x, last = data[data.length - 1].x;
    // Whitespace is axis padding, not invented candles or account history.
    if (first === last) return { min: first - 30000, max: last + 30000 };
    const pad = Math.max(1000, Math.min(10000, (last - first) * .035));
    return { min: first - pad, max: last + pad };
  }
  function priceBounds(low, high) {
    // Scale arithmetic must stay finite even when real observations approach MAX_VALUE.
    const span = high - low;
    const spanPad = Number.isFinite(span) ? span * .12 : Number.MAX_VALUE * .12;
    const pad = Math.max(spanPad, Math.max(Math.abs(low), Math.abs(high)) * .005, .01);
    const lower = low - pad, upper = high + pad;
    return { min: Number.isFinite(lower) ? lower : -Number.MAX_VALUE,
      max: Number.isFinite(upper) ? upper : Number.MAX_VALUE };
  }
  function equityCandles(rows, baseline, mode) {
    const data=candles({history:rows || []});
    if(mode!=='return' || !(baseline>0))return data;
    return data.map(c=>({...c,o:(c.o-baseline)/baseline*100,h:(c.h-baseline)/baseline*100,l:(c.l-baseline)/baseline*100,c:(c.c-baseline)/baseline*100}));
  }
  function tradePoints(trades,id){return (trades || []).filter(t=>t.instrumentId===id && finite(t.time)&&finite(t.price)&&['buy','sell','short','cover'].includes(t.action)).map(t=>({x:t.time,y:t.price,trade:t,mark:['buy','cover'].includes(t.action)?'B':'S'}));}
  function createViewport(){
    let range=null,extent=null,interval=60000,following=true,frame=null,lastEmitted='';const subscribers=new Set();
    function clamp(min,max){if(!extent)return null;const left=extent.min-interval*2,right=extent.max+interval*2,span=Math.min(Math.max(max-min,interval*3),Math.max(interval*3,right-left));min=Math.max(left,Math.min(min,right-span));return {min,max:min+span};}
    function emit(){const key=JSON.stringify(range);if(key===lastEmitted)return;lastEmitted=key;if(root.requestAnimationFrame){if(frame!==null)return;frame=root.requestAnimationFrame(()=>{frame=null;for(const fn of subscribers)fn(range);});}else for(const fn of subscribers)fn(range);}
    return {get range(){return range;},subscribe(fn){subscribers.add(fn);return()=>{subscribers.delete(fn);if(!subscribers.size&&frame!==null){root.cancelAnimationFrame(frame);frame=null;}};},
      configure(times,step,reset=false){interval=step || 60000;const valid=times.filter(finite);if(!valid.length){if(reset){range=null;extent=null;emit();}return;}extent={min:Math.min(...valid),max:Math.max(...valid)};if(reset||!range||following)range=clamp(extent.max-interval*59,extent.max+interval);else range=clamp(range.min,range.max);emit();},
      zoom(factor,anchor=.5){if(!range)return;following=false;const point=range.min+(range.max-range.min)*anchor,span=(range.max-range.min)*factor;range=clamp(point-span*anchor,point+span*(1-anchor));emit();},
      pan(fraction){if(!range)return;following=false;const shift=(range.max-range.min)*fraction;range=clamp(range.min+shift,range.max+shift);emit();},
      latest(){following=true;if(extent){range=clamp(extent.max-interval*59,extent.max+interval);emit();}}
    };
  }
  const tradeLabels={id:'petTradeLabels',afterDatasetsDraw(chart){const occupied=new Map();chart.data.datasets.forEach((dataset,index)=>{if(!dataset.petTrades)return;const meta=chart.getDatasetMeta(index),ctx=chart.ctx;ctx.save();ctx.font='bold 10px sans-serif';dataset.data.forEach((point,n)=>{const element=meta.data[n];if(!element||element.x<chart.chartArea.left||element.x>chart.chartArea.right)return;const bucket=Math.round(element.x/18),offset=occupied.get(bucket)||0;occupied.set(bucket,offset+1);ctx.fillStyle=point.mark==='B'?colors.up:colors.down;ctx.fillText(point.mark,element.x+4,Math.max(chart.chartArea.top+10,element.y-7-offset*11));});ctx.restore();});}};
  function options(mini) {
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      parsing: false, normalized: true,
      events: mini ? [] : ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
      interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { display: false }, tooltip: { enabled: !mini, displayColors: false, backgroundColor: '#5b4050', titleFont: { size: 11 }, bodyFont: { size: 11 } } },
      scales: {
        x: { type: 'time', offset: false, display: !mini, adapters: { date: { locale: 'zh-CN' } },
          time: { displayFormats: { second: 'HH:mm:ss', minute: 'HH:mm', hour: 'HH:mm' } },
          ticks: { maxTicksLimit: 6, maxRotation: 0, color: '#9a8491', font: { size: 10 } },
          grid: { display: !mini, color: '#f3edf0' }, border: { display: false } },
        y: { type: 'linear', display: !mini, position: 'right',
          ticks: { color: '#9a8491', font: { size: 10 }, maxTicksLimit: 5 },
          grid: { display: !mini, color: '#f3edf0' }, border: { display: false } }
      }
    };
  }
  function mount(container, type, config, mini) {
    if (!root.Chart) throw new Error('Chart.js is not loaded');
    const canvas = root.document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', type === 'candlestick' ? '真实采样 OHLC K 线图' : '真实账户收益曲线');
    container.replaceChildren(canvas);
    const chart = new root.Chart(canvas, { type, data: { datasets: [] }, options: config, plugins:[tradeLabels] });
    let cache = '', destroyed = false, paused=false, unsubscribe=()=>{}, dispose=()=>{}, cancelPointer=()=>{};
    return {
      chart, canvas,
      commit(datasets, label, bounds, extraKey = '') {
        if (destroyed) return;
        const key = JSON.stringify([datasets, label, bounds, extraKey]);
        if (cache === key) return;
        cache = key; chart.data.datasets = datasets;
        delete chart.options.scales.x.min; delete chart.options.scales.x.max;
        Object.assign(chart.options.scales.x, bounds);
        canvas.setAttribute('aria-label', label);
        chart.update('none');
      },
      bind(viewport){
        if(!viewport)return;
        unsubscribe=viewport.subscribe(range=>{if(!destroyed&&!paused&&range){Object.assign(chart.options.scales.x,range);cache='';chart.update('none');}});
        if(!canvas.addEventListener)return;
        let pointer=null,moved=false;const events=chart.options.events;
        const handlers={pointerdown:e=>{if(paused||e.button>0)return;pointer={id:e.pointerId,x:e.clientX};moved=false;chart.options.events=[];canvas.setPointerCapture?.(e.pointerId);},pointermove:e=>{if(paused||!pointer||pointer.id!==e.pointerId)return;const delta=e.clientX-pointer.x;if(Math.abs(delta)>2)moved=true;viewport.pan(-delta/Math.max(canvas.getBoundingClientRect().width,1));pointer.x=e.clientX;},pointerup:e=>{if(pointer)canvas.releasePointerCapture?.(pointer.id);pointer=null;chart.options.events=events;},pointercancel:()=>{pointer=null;chart.options.events=events;},wheel:e=>{if(paused)return;e.preventDefault();const rect=canvas.getBoundingClientRect();viewport.zoom(Math.exp(Math.max(-1,Math.min(1,e.deltaY*.002))),Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)));},click:e=>{if(moved){e.stopPropagation();moved=false;}}};
        for(const [name,fn] of Object.entries(handlers))canvas.addEventListener(name,fn,name==='wheel'?{passive:false}:undefined);
        cancelPointer=handlers.pointerup;dispose=()=>{handlers.pointerup();for(const [name,fn] of Object.entries(handlers))canvas.removeEventListener(name,fn);};
        canvas.style.touchAction='pan-y';
      },
      pause() { paused=true;cancelPointer();if (!destroyed) chart.stop(); },
      resize() { paused=false;if (!destroyed) chart.resize(); },
      destroy() { if (destroyed) return; destroyed = true;unsubscribe();dispose();chart.destroy(); container.replaceChildren(); }
    };
  }
  function createCandles(container, { mini = false, viewport = null } = {}) {
    const config = options(mini);
    config.plugins.tooltip.callbacks = {
      title: items => items.length ? date(items[0].raw.x) : '',
      label: item => { const c = item.raw;if(c.trade){const t=c.trade;return [`${c.mark} · ${t.action} · ${t.side || 'long'}`,`成交 ${number(t.price)} · 数量 ${number(t.quantity)}`,...(finite(t.realizedPnl)?[`已实现盈亏 ${number(t.realizedPnl)}`]:[])];} return [`开 ${number(c.o)}  高 ${number(c.h)}`, `低 ${number(c.l)}  收 ${number(c.c)}`]; }
    };
    const handle = mount(container, 'candlestick', config, mini);handle.bind(viewport);
    return Object.assign(handle, {
      update(instrument, trades=[]) {
        const data = candles(instrument).slice(-180);
        const dataset = { data, backgroundColors: { ...colors }, borderColors: { ...colors }, maxBarThickness: mini ? 5 : 12, barPercentage: .65, categoryPercentage: .8 };
        // financial 0.2.1 defaults a single candle's range to 0..1; derive real bounds instead.
        if (data.length) {
          const low = Math.min(...data.map(c => c.l)), high = Math.max(...data.map(c => c.h));
          Object.assign(handle.chart.options.scales.y, priceBounds(low, high));
        } else { delete handle.chart.options.scales.y.min; delete handle.chart.options.scales.y.max; }
        const marks=tradePoints(trades,instrument.id);const datasets=[dataset];if(marks.length)datasets.push({type:'scatter',petTrades:!mini,data:marks,pointRadius:mini?2:4,pointHoverRadius:6,pointBackgroundColor:marks.map(p=>p.mark==='B'?colors.up:colors.down),showLine:false});
        handle.commit(datasets, `${instrument.name || instrument.id || ''}：${data.length} 根真实 OHLC K 线`, viewport?.range || timeBounds(data));
        return data.length;
      }
    });
  }
  function createPerformance(container,{viewport=null}={}) {
    const handle=createCandles(container,{viewport});const update=handle.update;
    return Object.assign(handle,{update(performance,mode='return',rows=[]){
      if(!(performance?.baseline>0))mode='equity';
      const data=equityCandles(rows,performance?.baseline,mode);
      handle.chart.options.scales.y.ticks.callback=value=>number(value)+(mode==='return'?'%':'');
      return update({name:mode==='return'?'账户收益率':'账户净权益',history:data.map(c=>({time:c.x,open:c.o,high:c.h,low:c.l,close:c.c}))});
    }});
  }
  return { createViewport, equityCandles, tradePoints, candles, performancePoints, performanceSegments, timeBounds, priceBounds, createCandles, createPerformance };
});
