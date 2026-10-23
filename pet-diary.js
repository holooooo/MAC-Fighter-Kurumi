/* Read-only service-backed trade diary. No storage, requests, or trading actions. */
(function (root, factory) {
  const api = factory(root.document);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetDiary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (defaultDocument) {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const number = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
  const date = value => finite(value) && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
  const actions = { buy: '买入开多', sell: '卖出平多', short: '卖出开空', cover: '买回平空' };
  function outcome(entry) {
    if (entry.action === 'buy' || entry.action === 'short') return { label: '未结算', tone: 'neutral' };
    if (!finite(entry.realizedPnl)) return { label: '收益依据不足', tone: 'neutral' };
    const net = entry.pnlBasis === 'net-position-interest';
    const value = entry.realizedPnl;
    return { label: `${net ? '净收益' : '旧口径收益'} ${value > 0 ? '+' : ''}${number(value)}`, tone: value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral' };
  }
  function fields(entry) {
    const rows = [];
    const definitions = [['quantity','数量'],['price','成交价'],['notional','成交额'],['leverage','杠杆倍数'],['margin','投入保证金'],['costBasis','成本'],['interest','仓位利息'],['grossPnl','价差收益'],['marginReleased','释放保证金'],['debtRepaid','偿还融资'],['episode','局数'],['deficit','强平穿仓差额']];
    for (const [key, label] of definitions) if (finite(entry[key])) rows.push([label, number(entry[key])]);
    rows.push(['结算', outcome(entry).label]);
    if (typeof entry.liquidated === 'boolean') rows.push(['强平', entry.liquidated ? '是' : '否']);
    return rows;
  }
  function sortedEntries(diary) {
    const seen = new Set();
    return (Array.isArray(diary?.entries) ? diary.entries : []).filter(entry => entry && typeof entry.id === 'string' && Object.hasOwn(actions, entry.action))
      .slice().sort((a,b) => (finite(b.time) ? b.time : -Infinity) - (finite(a.time) ? a.time : -Infinity))
      .filter(entry => { if (seen.has(entry.id)) return false; seen.add(entry.id); return true; }).slice(0,500);
  }
  function createRenderer(document) {
    let loaded = 12, currentDiary = null;
    const expanded = new Set();
    let previousList = null;
    function node(tag, text, className) {
      const element = document.createElement(tag);
      if (text !== undefined) element.textContent = String(text);
      if (className) element.className = className;
      return element;
    }
    function render(diary) {
      if (!document) return;
      const list = document.getElementById('activity-log');
      if (!list) return;
      // Read the DOM before replacement too: a toggle event may still be queued.
      if (list === previousList) for (const details of list.querySelectorAll('details[data-diary-id]')) {
        if (details.open) expanded.add(details.dataset.diaryId); else expanded.delete(details.dataset.diaryId);
      }
      previousList = list; currentDiary = diary;
      const entries = sortedEntries(diary);
      const validIds = new Set(entries.map(entry => entry.id));
      for (const id of expanded) if (!validIds.has(id)) expanded.delete(id);
      const count = document.getElementById('activity-count');
      if (count) count.textContent = String(entries.length);
      let notice = document.getElementById('diary-notice');
      if (!notice && list.parentNode) {
        notice = node('p'); notice.id = 'diary-notice'; list.parentNode.insertBefore(notice, list);
      }
      if (notice) notice.textContent = `服务本地存档 · 最多保留最近500笔${diary?.truncated ? ' · 历史已截断' : ''}${diary?.partialHistory ? ' · 部分历史，旧记录不保证完整' : ''}${finite(diary?.startedAt) ? ` · 开始记录：${date(diary.startedAt)}` : ' · 尚无记录起点'}${finite(diary?.oldestRetainedAt) ? ` · 最早保留：${date(diary.oldestRetainedAt)}` : ''}`;
      list.replaceChildren();
      if (!entries.length) list.appendChild(node('li', diary ? '还没有交易日记。成交后会自动记录；查看日记不会下单。' : '等待服务提供交易日记。', 'diary-empty'));
      for (const entry of entries.slice(0, loaded)) {
        const item = node('li', undefined, 'diary-entry');
        const details = node('details'); details.dataset.diaryId = entry.id; details.open = expanded.has(entry.id);
        const summary = node('summary');
        summary.appendChild(node('span', `${date(entry.time)} · ${String(entry.instrumentId ?? '未知品种')} · ${actions[entry.action]}${entry.liquidated ? ' · 强平' : ''} `));
        const result = outcome(entry), pnl = node('span', result.label, `diary-pnl diary-pnl-${result.tone}`);
        // Explicit signed text as well as requested red-profit/green-loss coloring.
        pnl.style.color = result.tone === 'positive' ? '#b53d53' : result.tone === 'negative' ? '#237653' : '#756b72';
        summary.appendChild(pnl); details.appendChild(summary);
        const dl = node('dl');
        for (const [label,value] of fields(entry)) { dl.appendChild(node('dt', label)); dl.appendChild(node('dd', value)); }
        details.appendChild(dl);
        details.appendChild(node('p', '净收益仅按已知仓位成本与利息计算；个人贷款利息未分摊。旧口径或缺失字段不补算。数据来自服务本地存档，非浏览器 localStorage。', 'diary-footnote'));
        item.appendChild(details); list.appendChild(item);
      }
      if (entries.length > loaded) {
        const item = node('li', undefined, 'diary-pagination');
        const button = node('button', `加载更多（还有${entries.length - loaded}笔）`); button.type = 'button';
        button.addEventListener('click', () => { loaded += 12; render(currentDiary); });
        item.appendChild(button); list.appendChild(item);
      }
    }
    return { render };
  }
  const renderer = createRenderer(defaultDocument);
  return { render: renderer.render, createRenderer, outcome, fields, sortedEntries };
});
