// Trends: biggest movers per window + the market index.
import { loadPack } from '../data.js';
import { store } from '../store.js';
import { el, esc, money, deltaHTML, lineChart, statTile, rowItem, emptyState, fmtDay } from '../ui.js';

const WINDOWS = [['d1', '24 hours'], ['d7', '7 days'], ['d30', '30 days'], ['d90', '90 days']];
const METRICS = [
  ['top100', 'Top 100 index', 'Combined price of the 100 most expensive cards'],
  ['top1000', 'Top 1000 index', 'Combined price of the 1000 most expensive cards'],
  ['median', 'Median tracked card', 'Median price across every tracked card'],
];

let win = 'd7';
let metric = 'top100';

export async function trendsView(root) {
  root.append(el(`<div class="page-head"><h1>Market trends</h1><p data-sub>loading…</p></div>`));
  const body = el('<div></div>');
  root.append(body);

  const pack = await loadPack();
  const { trends, meta } = pack;
  root.querySelector('[data-sub]').textContent =
    `${meta.days.length} days of history · snapshot ${meta.days[meta.days.length - 1]} · movers need a price of $${(trends.movers_min_cents / 100).toFixed(2)} or more`;

  const tabs = el('<div class="bar" role="tablist" aria-label="Time window" style="margin-bottom:12px"></div>');
  WINDOWS.forEach(([k, l]) => {
    const b = el(`<button type="button" role="tab" class="chip ${win === k ? 'on' : ''}" aria-selected="${win === k}">${l}</button>`);
    b.addEventListener('click', () => {
      win = k;
      tabs.querySelectorAll('button').forEach((x, i) => {
        const on = WINDOWS[i][0] === k;
        x.classList.toggle('on', on);
        x.setAttribute('aria-selected', String(on));
      });
      draw();
    });
    tabs.append(b);
  });
  body.append(tabs);

  const indexBox = el('<div class="card-panel" style="margin-bottom:16px"></div>');
  body.append(indexBox);
  const stats = el('<div class="stats" style="margin:0 0 16px"></div>');
  body.append(stats);
  const lists = el('<div></div>');
  body.append(lists);

  function drawIndex() {
    indexBox.replaceChildren();
    const m = METRICS.find(([k]) => k === metric);
    const head = el(`<div class="row spread" style="margin-bottom:6px">
        <div><h2 class="sec">Market index</h2><div class="fine">${esc(m[2])}</div></div>
      </div>`);
    const sel = el(`<select aria-label="Index metric">${METRICS.map(([k, l]) => `<option value="${k}" ${metric === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
    sel.addEventListener('change', () => { metric = sel.value; drawIndex(); });
    head.append(sel);
    indexBox.append(head);

    const series = trends.index?.[metric] || [];
    const days = trends.index?.days || [];
    const points = days.map((day, i) => ({ day, cents: series[i] })).filter((p) => p.cents != null && p.cents >= 0);
    indexBox.append(lineChart(points, { label: m[1], height: 200 }));

    if (points.length > 1) {
      const first = points[0].cents;
      const last = points[points.length - 1].cents;
      const pct = first ? Math.round(((last - first) / first) * 10000) : null;
      indexBox.append(el(`<div class="row" style="margin-top:8px">
          <span class="mono"><b>${money(last)}</b></span>
          ${deltaHTML(pct)}
          <span class="fine">since ${esc(fmtDay(points[0].day))}</span>
        </div>`));
    }
  }

  function draw() {
    drawIndex();
    const w = trends.windows?.[win] || { gainers: [], losers: [] };
    const label = WINDOWS.find(([k]) => k === win)[1];

    const upCount = trends.index?.movers_up?.slice(-1)[0];
    const downCount = trends.index?.movers_down?.slice(-1)[0];
    stats.replaceChildren(
      statTile(`Top ${label} gain`, w.gainers[0] ? `+${(w.gainers[0][1] / 100).toFixed(1)}%` : '—', esc(nameOf(pack, w.gainers[0]))),
      statTile(`Top ${label} drop`, w.losers[0] ? `${(w.losers[0][1] / 100).toFixed(1)}%` : '—', esc(nameOf(pack, w.losers[0]))),
      statTile('Cards up yesterday', upCount != null ? upCount.toLocaleString() : '—', 'moved more than 5%'),
      statTile('Cards down yesterday', downCount != null ? downCount.toLocaleString() : '—', 'moved more than 5%'),
    );

    lists.replaceChildren();
    lists.append(moversPanel(pack, `Biggest gains · ${label}`, w.gainers));
    lists.append(moversPanel(pack, `Biggest drops · ${label}`, w.losers));

    if (trends.sets?.length) {
      const panel = el(`<div class="card-panel" style="margin-top:16px"><h2 class="sec">Set values <span class="fine">total price of tracked cards, cheapest printings</span></h2></div>`);
      const table = el(`<div class="tablewrap"><table><thead><tr><th>Set</th><th>Code</th><th>Total</th><th>7d</th></tr></thead><tbody></tbody></table></div>`);
      const tb = table.querySelector('tbody');
      trends.sets.slice(0, 40).forEach((s) => {
        tb.append(el(`<tr>
          <td class="wrap"><a href="#/search?q=${encodeURIComponent(`set:${s.code}`)}" style="text-decoration:none">${esc(s.name)}</a></td>
          <td class="mono">${esc(s.code.toUpperCase())}</td>
          <td class="mono">${money(s.total, { compact: true })}</td>
          <td>${deltaHTML(s.d7)}</td>
        </tr>`));
      });
      panel.append(table);
      lists.append(panel);
    }

    const watched = store.watchList();
    if (watched.length) {
      const moves = watched
        .map((w2) => pack.byOid.get(w2.oid))
        .filter((c) => c && c[win] != null)
        .sort((a, b) => Math.abs(b[win]) - Math.abs(a[win]))
        .slice(0, 6);
      if (moves.length) {
        const panel = el(`<div class="card-panel" style="margin-top:16px"><h2 class="sec">Your watchlist · ${esc(label)}</h2></div>`);
        const rl = el('<div class="rowlist"></div>');
        moves.forEach((c) => rl.append(rowItem(c, { window: win })));
        panel.append(rl);
        lists.append(panel);
      }
    }
  }

  draw();
  store.onChange(() => draw());
}

function nameOf(pack, entry) {
  if (!entry) return '—';
  return pack.byOid.get(entry[0])?.name || '—';
}

function moversPanel(pack, title, entries) {
  const panel = el(`<div class="card-panel" style="margin-bottom:16px"><h2 class="sec">${esc(title)}</h2></div>`);
  if (!entries?.length) {
    panel.append(el('<div class="notice">No movers in this window yet. The nightly snapshot fills these in.</div>'));
    return panel;
  }
  const list = el('<div class="rowlist"></div>');
  entries.slice(0, 25).forEach(([oid, pct, now, then]) => {
    const card = pack.byOid.get(oid);
    if (!card) return;
    const node = rowItem(card, { window: 'd7', then });
    // Override the delta with the window-specific value from the leaderboard.
    node.querySelector('.pr').innerHTML = `<b class="mono">${money(now)}</b>${deltaHTML(pct)}`;
    node.querySelector('.sb').textContent = `${card.loS.toUpperCase()} · was ${money(then)}`;
    list.append(node);
  });
  panel.append(list);
  if (!list.children.length) {
    panel.append(el('<div class="notice">Leaderboard cards are not in the current pack.</div>'));
  }
  return panel;
}

export { emptyState };
