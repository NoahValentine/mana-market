// Card detail: everything about one card, with the market front and centre.
import { scryfall, imageOf, hasBack, printingPrices, ScryfallError } from '../scryfall.js';
import { loadPack, seriesFor, finishName } from '../data.js';
import { store } from '../store.js';
import { el, esc, money, moneyExact, deltaHTML, lineChart, statTile, emptyState, toast, fmtDay } from '../ui.js';

const FORMATS = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper', 'brawl', 'premodern', 'oldschool'];

export async function cardView(root, params, id) {
  root.append(el('<div class="detail"><div><div class="skel" style="aspect-ratio:488/680;border-radius:12px;max-width:360px"></div></div><div><div class="skel" style="height:28px;width:60%"></div><div class="skel" style="height:14px;margin-top:10px"></div><div class="skel" style="height:120px;margin-top:10px"></div></div></div>'));

  let card;
  try {
    card = id.includes('/') ? await scryfall.card(id) : await scryfall.card(id);
  } catch (err) {
    root.replaceChildren(emptyState('Card not found',
      err instanceof ScryfallError ? err.message : 'Scryfall could not load this card.'));
    return;
  }

  const pack = await loadPack().catch(() => null);
  const packCard = pack?.byOid.get(card.oracle_id) || null;
  document.title = `${card.name} — Mana Market`;

  root.replaceChildren();
  const wrap = el('<div class="detail"></div>');
  root.append(wrap);

  // ---------------- left column: art + this printing's prices
  const left = el('<div class="detail-art"></div>');
  let face = 0;
  const imgBox = el('<div class="tile-img"></div>');
  const img = el(`<img alt="${esc(card.name)}" width="488" height="680" decoding="async">`);
  img.src = imageOf(card, 'normal', 0) || '';
  imgBox.append(img);
  left.append(imgBox);

  if (hasBack(card)) {
    const flip = el('<button type="button" class="btn">Flip card ⟳</button>');
    flip.addEventListener('click', () => {
      face = face ? 0 : 1;
      img.src = imageOf(card, 'normal', face) || img.src;
      img.alt = `${card.name} (face ${face + 1})`;
    });
    left.append(flip);
  }

  const prices = printingPrices(card);
  const thisPanel = el(`<div class="card-panel"><h2 class="sec">This printing <span class="fine">${esc(card.set.toUpperCase())} #${esc(card.collector_number)}</span></h2></div>`);
  if (prices.length) {
    const rows = el('<div class="rowlist"></div>');
    prices.forEach((p) => rows.append(el(`<div class="rowitem" style="grid-template-columns:1fr auto">
        <div><div class="nm">${esc(p.finish)}</div><div class="sb">TCGplayer market</div></div>
        <div class="pr"><b class="mono">${moneyExact(p.cents)}</b></div>
      </div>`)));
    thisPanel.append(rows);
  } else {
    thisPanel.append(el('<div class="notice">No USD price for this printing right now.</div>'));
  }
  if (card.prices?.eur || card.prices?.tix) {
    thisPanel.append(el(`<p class="fine" style="margin-top:8px">Also: ${[
      card.prices.eur ? `€${card.prices.eur} Cardmarket` : null,
      card.prices.eur_foil ? `€${card.prices.eur_foil} foil` : null,
      card.prices.tix ? `${card.prices.tix} tix MTGO` : null,
    ].filter(Boolean).join(' · ')}</p>`));
  }
  left.append(thisPanel);

  // buy links
  const buys = Object.entries(card.purchase_uris || {});
  if (buys.length) {
    const box = el('<div class="buylinks"></div>');
    const NAMES = { tcgplayer: 'Buy on TCGplayer', cardmarket: 'Buy on Cardmarket', cardhoarder: 'Buy on Cardhoarder' };
    buys.forEach(([k, url]) => box.append(el(`<a class="btn ${k === 'tcgplayer' ? 'btn-primary' : ''}" href="${esc(url)}" target="_blank" rel="noopener nofollow">${esc(NAMES[k] || k)}</a>`)));
    left.append(box);
  }
  wrap.append(left);

  // ---------------- right column
  const right = el('<div></div>');
  wrap.append(right);

  const head = el(`<div class="page-head" style="margin-bottom:8px">
      <div style="flex:1;min-width:0">
        <h1>${esc(card.name)}</h1>
        <p>${esc(card.type_line || '')}${card.mana_cost ? ` · ${esc(card.mana_cost)}` : ''}</p>
      </div>
    </div>`);
  right.append(head);

  const badges = el('<div class="badges" style="margin-bottom:12px"></div>');
  const b = (t, cls = '') => badges.append(el(`<span class="badge ${cls}">${esc(t)}</span>`));
  b(`${card.set_name} (${card.set.toUpperCase()})`);
  b(card.rarity);
  if (card.reserved) b('Reserved List', 'hot');
  if (card.promo) b('Promo');
  if (card.foil && !card.nonfoil) b('Foil only');
  if (card.finishes?.includes('etched')) b('Etched available');
  if (card.released_at) b(card.released_at.slice(0, 4));
  if (card.edhrec_rank) b(`EDHREC #${card.edhrec_rank}`);
  if (card.artist) b(card.artist);
  if (card.lang && card.lang !== 'en') b(card.lang.toUpperCase());
  right.append(badges);

  // market summary across all printings
  const marketPanel = el('<div class="card-panel" style="margin-bottom:16px"></div>');
  right.append(marketPanel);

  const watchRow = el('<div class="row" style="margin-bottom:16px"></div>');
  right.append(watchRow);

  // oracle text
  const faces = card.card_faces?.length ? card.card_faces : [card];
  const oracle = el('<div class="oracle" style="margin-bottom:16px"></div>');
  faces.forEach((f, i) => {
    if (i) oracle.append(el('<hr style="border:0;border-top:1px solid var(--line);margin:12px 0">'));
    oracle.append(el(`<div><b>${esc(f.name || card.name)}</b>${f.mana_cost ? ` <span class="fine">${esc(f.mana_cost)}</span>` : ''}
        <div class="fine" style="margin:2px 0 6px">${esc(f.type_line || '')}</div>
        <div>${esc(f.oracle_text || '')}</div>
        ${f.power ? `<div style="margin-top:6px"><b>${esc(f.power)}/${esc(f.toughness)}</b></div>` : ''}
        ${f.loyalty ? `<div style="margin-top:6px"><b>Loyalty ${esc(f.loyalty)}</b></div>` : ''}
        ${f.flavor_text ? `<span class="flavor">${esc(f.flavor_text)}</span>` : ''}
      </div>`));
  });
  right.append(oracle);

  // history chart
  const histPanel = el('<div class="card-panel" style="margin-bottom:16px"><h2 class="sec">Price history <span class="fine">cheapest printing, any finish</span></h2></div>');
  right.append(histPanel);

  // printings
  const printsPanel = el('<div class="card-panel" style="margin-bottom:16px"><h2 class="sec">All printings</h2><div class="notice">Loading printings…</div></div>');
  right.append(printsPanel);

  // legalities
  if (card.legalities) {
    const legal = el('<div class="card-panel" style="margin-bottom:16px"><h2 class="sec">Legality</h2></div>');
    const grid = el('<div class="legal"></div>');
    FORMATS.forEach((fmt) => {
      const v = card.legalities[fmt];
      if (!v) return;
      const cls = v === 'legal' ? 'yes' : v === 'restricted' ? 'res' : 'no';
      grid.append(el(`<div><span>${esc(fmt)}</span><span class="${cls}">${esc(v.replace('_', ' '))}</span></div>`));
    });
    legal.append(grid);
    right.append(legal);
  }

  // rulings + links
  const links = el(`<div class="card-panel">
      <h2 class="sec">Elsewhere</h2>
      <div class="buylinks">
        <a class="btn" href="${esc(card.scryfall_uri)}" target="_blank" rel="noopener">Scryfall page</a>
        ${card.related_uris?.edhrec ? `<a class="btn" href="${esc(card.related_uris.edhrec)}" target="_blank" rel="noopener">EDHREC</a>` : ''}
        ${card.related_uris?.gatherer ? `<a class="btn" href="${esc(card.related_uris.gatherer)}" target="_blank" rel="noopener">Gatherer</a>` : ''}
      </div>
    </div>`);
  right.append(links);

  const rulingsPanel = el('<div class="card-panel" style="margin:0 0 16px"><h2 class="sec">Rulings</h2></div>');
  const rulingsBtn = el('<button type="button" class="btn btn-ghost">Show rulings</button>');
  rulingsBtn.addEventListener('click', async () => {
    rulingsBtn.disabled = true;
    try {
      const r = await scryfall.rulings(card.id);
      rulingsPanel.replaceChildren(el('<h2 class="sec">Rulings</h2>'));
      if (!r.data?.length) rulingsPanel.append(el('<div class="notice">No rulings for this card.</div>'));
      r.data?.forEach((x) => rulingsPanel.append(el(`<p class="fine" style="color:var(--ink-2)"><b>${esc(x.published_at)}</b> — ${esc(x.comment)}</p>`)));
    } catch {
      rulingsPanel.append(el('<div class="notice">Could not load rulings.</div>'));
    }
  });
  rulingsPanel.append(rulingsBtn);
  right.insertBefore(rulingsPanel, links);

  // ---------------- async fills
  drawMarket();
  drawWatch();
  drawHistory();
  drawPrintings();

  function drawMarket() {
    marketPanel.replaceChildren(el('<h2 class="sec">Market <span class="fine">across every paper printing</span></h2>'));
    if (!packCard) {
      marketPanel.append(el('<div class="notice">This card is below the tracking threshold, so it has no stored history. Prices above come live from Scryfall.</div>'));
      return;
    }
    const stats = el('<div class="stats"></div>');
    stats.append(statTile('Cheapest printing', money(packCard.lo), `${packCard.loS.toUpperCase()} · ${finishName(packCard.loF)}`));
    stats.append(statTile('Most expensive', money(packCard.hi), `${packCard.hiS.toUpperCase()} · ${finishName(packCard.hiF)}`));
    stats.append(statTile('Spread', money(packCard.hi - packCard.lo), `${packCard.np} printings`));
    marketPanel.append(stats);
    const deltas = el('<div class="row" style="margin-top:10px;gap:14px"></div>');
    [['d1', '24h'], ['d7', '7d'], ['d30', '30d'], ['d90', '90d']].forEach(([k, l]) => {
      deltas.append(el(`<span class="fine">${l} ${deltaHTML(packCard[k])}</span>`));
    });
    marketPanel.append(deltas);
  }

  function drawWatch() {
    watchRow.replaceChildren();
    const oid = card.oracle_id;
    const on = store.isWatched(oid);
    const star = el(`<button type="button" class="btn ${on ? 'btn-primary' : ''}">${on ? '★ On watchlist' : '☆ Add to watchlist'}</button>`);
    star.addEventListener('click', () => {
      store.toggleWatch(oid, card.name, packCard?.lo ?? prices[0]?.cents ?? null);
      drawWatch();
      toast(store.isWatched(oid) ? 'Added to watchlist' : 'Removed from watchlist');
    });
    watchRow.append(star);

    if (on) {
      const alertBtn = el('<button type="button" class="btn btn-ghost">Set a price alert</button>');
      alertBtn.addEventListener('click', () => {
        const current = (packCard?.lo ?? prices[0]?.cents ?? 0) / 100;
        const input = window.prompt(`Alert me when the cheapest printing of ${card.name} crosses this price (in dollars).\nCurrent: $${current.toFixed(2)}\nPrefix with < for a drop alert, e.g. <20`, `${(current * 1.2).toFixed(2)}`);
        if (!input) return;
        const down = input.trim().startsWith('<');
        const value = Number(input.replace(/[^0-9.]/g, ''));
        if (!value) { toast('Could not read that price'); return; }
        const rules = (store.get().watch[oid]?.alerts || []).concat({ dir: down ? 'down' : 'up', cents: Math.round(value * 100) });
        store.setAlerts(oid, rules);
        toast(`Alert set: ${down ? 'below' : 'above'} $${value.toFixed(2)}`);
        drawWatch();
      });
      watchRow.append(alertBtn);
      const rules = store.get().watch[oid]?.alerts || [];
      rules.forEach((r, i) => {
        const chip = el(`<button type="button" class="chip on" title="Remove this alert">${r.dir === 'up' ? '≥' : '≤'} ${moneyExact(r.cents)} ✕</button>`);
        chip.addEventListener('click', () => {
          const next = rules.slice(); next.splice(i, 1);
          store.setAlerts(oid, next); drawWatch();
        });
        watchRow.append(chip);
      });
    }
  }

  async function drawHistory() {
    if (!packCard) {
      histPanel.append(el('<div class="notice">No stored history for this card yet.</div>'));
      return;
    }
    const series = await seriesFor(pack, packCard);
    if (!series || series.length < 2) {
      histPanel.append(el('<div class="notice">Not enough snapshots yet for a chart.</div>'));
      return;
    }
    histPanel.append(lineChart(series, { label: `${card.name} cheapest printing`, height: 200 }));
    const first = series[0];
    const last = series[series.length - 1];
    const peak = series.reduce((a, p) => (p.cents > a.cents ? p : a), series[0]);
    const low = series.reduce((a, p) => (p.cents < a.cents ? p : a), series[0]);
    histPanel.append(el(`<div class="stats" style="margin-top:10px">
        <div class="stat"><div class="k">Now</div><div class="v mono">${money(last.cents)}</div><div class="fine">${esc(fmtDay(last.day))}</div></div>
        <div class="stat"><div class="k">${series.length}-day high</div><div class="v mono">${money(peak.cents)}</div><div class="fine">${esc(fmtDay(peak.day))}</div></div>
        <div class="stat"><div class="k">${series.length}-day low</div><div class="v mono">${money(low.cents)}</div><div class="fine">${esc(fmtDay(low.day))}</div></div>
        <div class="stat"><div class="k">Since ${esc(fmtDay(first.day))}</div><div class="v mono">${deltaHTML(first.cents ? Math.round(((last.cents - first.cents) / first.cents) * 10000) : null)}</div></div>
      </div>`));
  }

  async function drawPrintings() {
    try {
      const res = await scryfall.printings(card.oracle_id);
      const rows = res.data
        .map((p) => ({ p, prices: printingPrices(p) }))
        .filter((x) => x.prices.length);
      const cheapest = rows.reduce((a, x) => (!a || x.prices[0].cents < a.prices[0].cents ? x : a), null);
      printsPanel.replaceChildren(el(`<h2 class="sec">All printings <span class="fine">${res.total_cards} paper printings · cheapest highlighted</span></h2>`));
      const table = el(`<div class="tablewrap"><table>
          <thead><tr><th>Set</th><th>#</th><th>Rarity</th><th>Nonfoil</th><th>Foil</th><th>Etched</th></tr></thead>
          <tbody></tbody></table></div>`);
      const tb = table.querySelector('tbody');
      rows.sort((a, b) => a.prices[0].cents - b.prices[0].cents).forEach(({ p, prices: pp }) => {
        const get = (f) => pp.find((x) => x.finish === f);
        const tr = el(`<tr class="${p.id === card.id ? 'is-current' : ''} ${cheapest && p.id === cheapest.p.id ? 'is-cheapest' : ''}">
            <td class="wrap"><a href="#/card/${encodeURIComponent(p.id)}" style="text-decoration:none">${esc(p.set_name)}</a> <span class="fine">${esc(p.set.toUpperCase())}</span>${p.id === card.id ? ' <span class="badge">viewing</span>' : ''}</td>
            <td class="mono">${esc(p.collector_number)}</td>
            <td>${esc(p.rarity)}</td>
            <td class="mono">${get('nonfoil') ? moneyExact(get('nonfoil').cents) : '—'}</td>
            <td class="mono">${get('foil') ? moneyExact(get('foil').cents) : '—'}</td>
            <td class="mono">${get('etched') ? moneyExact(get('etched').cents) : '—'}</td>
          </tr>`);
        tb.append(tr);
      });
      printsPanel.append(table);
      if (res.has_more) printsPanel.append(el('<p class="fine" style="margin-top:8px">Showing the first 175 printings.</p>'));
    } catch (err) {
      printsPanel.replaceChildren(el('<h2 class="sec">All printings</h2>'), el(`<div class="notice">Could not load printings: ${esc(err.message)}</div>`));
    }
  }
}
