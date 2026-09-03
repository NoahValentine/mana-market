// Shared rendering helpers: money, deltas, card tiles, sparklines, line charts.
import { store } from './store.js';
import { imgUrl, finishName } from './data.js';

export const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export function money(cents, { compact = false } = {}) {
  if (cents == null || Number.isNaN(cents)) return '—';
  const d = cents / 100;
  if (compact && d >= 1000) {
    return `$${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}k`;
  }
  return `$${d.toLocaleString('en-US', { minimumFractionDigits: d < 100 ? 2 : 0, maximumFractionDigits: d < 100 ? 2 : 0 })}`;
}

export function moneyExact(cents) {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Percent stored ×100. Colour is never the only signal: sign + arrow always. */
export function deltaHTML(pct, { size = '' } = {}) {
  if (pct == null) return `<span class="delta flat" title="not enough price history">· n/a</span>`;
  const v = pct / 100;
  if (Math.abs(v) < 0.05) return `<span class="delta flat">— 0.0%</span>`;
  const up = v > 0;
  return `<span class="delta ${up ? 'up' : 'down'} ${size}">${up ? '▲ +' : '▼ '}${v.toFixed(1)}%</span>`;
}

export function toast(msg) {
  const box = document.querySelector('[data-toasts]');
  if (!box) return;
  const t = el(`<div class="toast">${esc(msg)}</div>`);
  box.append(t);
  setTimeout(() => t.remove(), 3200);
}

const STAR = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4 2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

export function starButton(card, cents) {
  const on = store.isWatched(card.oid);
  const b = el(`<button type="button" class="tile-star ${on ? 'on' : ''}" aria-pressed="${on}"
      aria-label="${on ? 'Remove from' : 'Add to'} watchlist">${STAR}</button>`);
  b.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none');
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const nowOn = store.toggleWatch(card.oid, card.name, cents);
    b.classList.toggle('on', nowOn);
    b.setAttribute('aria-pressed', String(nowOn));
    b.querySelector('svg').setAttribute('fill', nowOn ? 'currentColor' : 'none');
    toast(nowOn ? `${card.name} added to watchlist` : `${card.name} removed`);
  });
  return b;
}

/**
 * Card tile: full card image + price + delta. Image is the whole card, never cropped
 * art, because that is what people recognise.
 */
export function cardTile(card, { basis = store.basis, window: win = 'd7', rank = null, showAlt = true } = {}) {
  const price = basis === 'hi' ? card.hi : card.lo;
  const alt = basis === 'hi' ? card.lo : card.hi;
  const printing = basis === 'hi' ? { set: card.hiS, f: card.hiF, id: card.hiId } : { set: card.loS, f: card.loF, id: card.loId };
  const src = imgUrl(card.img, 'normal');
  const node = el(`
    <a class="tile" href="#/card/${encodeURIComponent(printing.id || card.loId)}">
      <div class="tile-img">
        ${rank != null ? `<span class="tile-rank">#${rank}</span>` : ''}
        ${src
          ? `<img src="${esc(src)}" alt="${esc(card.name)}" loading="lazy" decoding="async" width="488" height="680">`
          : `<div class="empty fine" style="padding:20px 8px">${esc(card.name)}</div>`}
      </div>
      <div class="tile-meta">
        <div class="tile-name">${esc(card.name)}</div>
        <div class="tile-sub">${esc(printing.set || '')} · ${esc(finishName(printing.f))}${card.np > 1 ? ` · ${card.np} printings` : ''}</div>
        <div class="tile-price">
          <b class="mono">${money(price)}</b>
          ${deltaHTML(card[win])}
        </div>
        ${showAlt && alt != null && alt !== price
          ? `<div class="tile-alt mono">${basis === 'hi' ? 'cheapest' : 'priciest'} ${money(alt, { compact: true })}</div>`
          : ''}
      </div>
    </a>`);
  node.querySelector('.tile-img').append(starButton(card, price));
  return node;
}

export function rowItem(card, { basis = store.basis, window: win = 'd7', then = null } = {}) {
  const price = basis === 'hi' ? card.hi : card.lo;
  const src = imgUrl(card.img, 'small');
  return el(`
    <a class="rowitem" href="#/card/${encodeURIComponent(card.loId)}">
      <div class="thumb">${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ''}</div>
      <div>
        <div class="nm">${esc(card.name)}</div>
        <div class="sb">${esc(card.loS?.toUpperCase() || '')} · ${finishName(card.loF)}${then != null ? ` · was ${money(then)}` : ''}</div>
      </div>
      <div class="pr">
        <b class="mono">${money(price)}</b>
        ${deltaHTML(card[win])}
      </div>
    </a>`);
}

export function skeletonGrid(n = 12) {
  const g = el('<div class="grid"></div>');
  for (let i = 0; i < n; i += 1) {
    g.append(el('<div><div class="skel" style="aspect-ratio:488/680;border-radius:10px"></div><div class="skel" style="height:12px;margin-top:8px"></div><div class="skel" style="height:12px;margin-top:6px;width:60%"></div></div>'));
  }
  return g;
}

export function emptyState(title, body) {
  return el(`<div class="empty"><h2>${esc(title)}</h2><p>${esc(body)}</p></div>`);
}

// ---------------------------------------------------------------- sparkline
export function sparkline(points, { width = 74, height = 26 } = {}) {
  if (!points || points.length < 2) return el('<span class="fine">—</span>');
  const vals = points.map((p) => p.cents);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${(height - ((v - min) / span) * (height - 3) - 1.5).toFixed(1)}`).join(' ');
  const rising = vals[vals.length - 1] >= vals[0];
  const svg = el(`<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path d="${d}"/></svg>`);
  svg.querySelector('path').setAttribute('stroke', rising ? 'var(--gain)' : 'var(--loss)');
  return svg;
}

// --------------------------------------------------------------- line chart
/**
 * One-series time chart with a crosshair + tooltip. Single series, so no legend:
 * the caller's heading names it.
 * points: [{ day:'YYYY-MM-DD', cents:Number }]
 */
export function lineChart(points, { height = 190, label = 'price', format = money } = {}) {
  const wrap = el('<div class="chartwrap"></div>');
  if (!points || points.length < 2) {
    wrap.append(el('<div class="notice">Not enough price history yet — this fills in as daily snapshots accumulate.</div>'));
    return wrap;
  }
  const W = 720;
  const H = height;
  const pad = { t: 10, r: 46, b: 22, l: 8 };
  const vals = points.map((p) => p.cents);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) { min -= 100; max += 100; }
  const padY = (max - min) * 0.08;
  min = Math.max(0, min - padY);
  max += padY;
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (points.length - 1);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.cents).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${y(min).toFixed(1)} L${x(0).toFixed(1)} ${y(min).toFixed(1)} Z`;

  const ticks = 4;
  const gridLines = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = min + ((max - min) * i) / ticks;
    return `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
            <text class="axis-label" x="${W - pad.r + 6}" y="${(y(v) + 3.5).toFixed(1)}">${format(v)}</text>`;
  }).join('');

  const first = points[0].day;
  const last = points[points.length - 1].day;
  const svg = el(`
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} history from ${first} to ${last}">
      ${gridLines}
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
      <g data-hover hidden>
        <line class="crosshair" y1="${pad.t}" y2="${H - pad.b}"/>
        <circle class="dot" r="4.5"/>
      </g>
      <text class="axis-label" x="${pad.l}" y="${H - 6}">${esc(fmtDay(first))}</text>
      <text class="axis-label" x="${W - pad.r}" y="${H - 6}" text-anchor="end">${esc(fmtDay(last))}</text>
    </svg>`);
  wrap.append(svg);

  const tip = el('<div class="chart-tip" hidden></div>');
  wrap.append(tip);
  const hover = svg.querySelector('[data-hover]');
  const dot = svg.querySelector('.dot');
  const cross = svg.querySelector('.crosshair');

  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const ratio = Math.min(1, Math.max(0, (px / rect.width * W - pad.l) / (W - pad.l - pad.r)));
    const i = Math.round(ratio * (points.length - 1));
    const p = points[i];
    hover.hidden = false;
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(p.cents));
    tip.hidden = false;
    tip.innerHTML = `<b class="mono">${format(p.cents)}</b> <span class="fine">${fmtDay(p.day)}</span>`;
    tip.style.left = `${(x(i) / W) * rect.width}px`;
    tip.style.top = `${(y(p.cents) / H) * rect.height}px`;
  };
  const leave = () => { hover.hidden = true; tip.hidden = true; };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('touchmove', move, { passive: true });
  return wrap;
}

export function fmtDay(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${Number(day)}${new Date().getFullYear() !== Number(y) ? ` ’${y.slice(2)}` : ''}`;
}

/**
 * Cheapest / priciest printing switch. The header carries one on wide screens;
 * views render this inline copy for phones, where the header has no room.
 */
export function basisToggle(onChange) {
  const wrap = el(`<div class="basis inline only-mobile" role="group" aria-label="Price basis">
      <button type="button" data-b="lo">Cheapest</button>
      <button type="button" data-b="hi">Priciest</button>
    </div>`);
  const paint = () => wrap.querySelectorAll('button').forEach((b) => {
    const on = b.dataset.b === store.basis;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  wrap.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    store.setBasis(b.dataset.b);
    paint();
    document.querySelectorAll('[data-basis]').forEach((x) => x.classList.toggle('on', x.dataset.basis === store.basis));
    if (onChange) onChange();
  }));
  paint();
  return wrap;
}

export function statTile(k, v, extra = '') {
  return el(`<div class="stat"><div class="k">${esc(k)}</div><div class="v mono">${v}</div>${extra ? `<div class="fine">${extra}</div>` : ''}</div>`);
}
