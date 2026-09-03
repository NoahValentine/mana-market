// Deck value: paste a list (or a Moxfield link) and price it at cheapest printings.
import { loadPack } from '../data.js';
import { scryfall } from '../scryfall.js';
import { store } from '../store.js';
import { el, esc, money, moneyExact, deltaHTML, statTile, toast } from '../ui.js';

const SECTION = /^(sideboard|commander|companion|maybeboard|deck|main ?deck|considering)\b/i;

export function parseList(text) {
  const out = [];
  const seen = new Map();
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    if (SECTION.test(line) && !/^\d/.test(line)) continue;
    // strip trailing "(SET) 123" and "*F*" / "[foil]" markers
    line = line.replace(/\s*\*[^*]*\*\s*$/g, '').replace(/\s*\[[^\]]*\]\s*$/g, '');
    const m = line.match(/^(\d+)\s*[xX]?\s+(.+)$/) || line.match(/^()(.+)$/);
    if (!m) continue;
    const qty = m[1] ? parseInt(m[1], 10) : 1;
    let name = m[2].trim()
      .replace(/\s*\([A-Za-z0-9]{2,6}\)\s*[A-Za-z0-9-★]*\s*$/, '')
      .replace(/\s+#\d+$/, '')
      .trim();
    if (!name) continue;
    name = name.split(' // ')[0].trim();
    const key = name.toLowerCase();
    if (seen.has(key)) { seen.get(key).qty += qty; continue; }
    const entry = { name, qty };
    seen.set(key, entry);
    out.push(entry);
  }
  return out;
}

export async function deckView(root) {
  root.append(el(`<div class="page-head"><h1>Deck value</h1><p>Every card priced at its cheapest printing, the way you would actually buy it.</p></div>`));

  const form = el(`<div class="card-panel" style="margin-bottom:16px">
      <label class="fine" for="dk">Paste a decklist — Moxfield, Archidekt, MTGA and plain "1 Sol Ring" all work</label>
      <textarea id="dk" spellcheck="false" placeholder="1 Sol Ring&#10;1 Mana Crypt&#10;1x Rhystic Study (CMR) 456&#10;..."></textarea>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-primary" type="button" data-price>Price this deck</button>
        <input type="text" data-mox placeholder="or a Moxfield deck URL" style="flex:1;min-width:180px">
        <button class="btn" type="button" data-fetch>Fetch</button>
      </div>
    </div>`);
  root.append(form);
  const out = el('<div></div>');
  root.append(out);

  const ta = form.querySelector('textarea');
  const pack = await loadPack().catch(() => null);

  form.querySelector('[data-price]').addEventListener('click', () => price(ta.value));
  form.querySelector('[data-fetch]').addEventListener('click', async () => {
    const url = form.querySelector('[data-mox]').value.trim();
    const id = url.match(/moxfield\.com\/decks\/([\w-]+)/)?.[1];
    if (!id) { toast('That does not look like a Moxfield deck URL'); return; }
    toast('Asking Moxfield…');
    try {
      const res = await fetch(`https://api2.moxfield.com/v3/decks/all/${id}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const deck = await res.json();
      const names = [];
      const boards = deck.boards || {};
      for (const board of Object.values(boards)) {
        for (const c of Object.values(board.cards || {})) {
          names.push(`${c.quantity} ${c.card?.name || ''}`);
        }
      }
      ta.value = names.join('\n');
      price(ta.value);
    } catch {
      out.replaceChildren(el(`<div class="notice warn">Moxfield blocks requests from other sites, so the link could not be read from your browser.
        Open the deck, choose <b>Export</b>, copy the list and paste it above — that always works.</div>`));
    }
  });

  async function price(text) {
    const entries = parseList(text);
    if (!entries.length) { out.replaceChildren(el('<div class="notice">No card names found in that list.</div>')); return; }
    out.replaceChildren(el('<div class="notice">Pricing…</div>'));

    const rows = [];
    const missing = [];
    for (const e of entries) {
      const c = pack?.byName.get(e.name.toLowerCase()) || null;
      if (c) rows.push({ ...e, card: c, lo: c.lo, hi: c.hi, src: 'pack' });
      else missing.push(e);
    }

    // Cards below the tracking threshold: one collection call per 75.
    for (let i = 0; i < missing.length; i += 75) {
      const batch = missing.slice(i, i + 75);
      try {
        const res = await scryfall.collection(batch.map((b) => ({ name: b.name })));
        const found = new Map((res.data || []).map((c) => [c.name.toLowerCase(), c]));
        batch.forEach((b) => {
          const c = found.get(b.name.toLowerCase()) || found.get(b.name.split(' // ')[0].toLowerCase());
          const cents = c?.prices?.usd ? Math.round(parseFloat(c.prices.usd) * 100) : null;
          rows.push({ ...b, card: null, lo: cents, hi: cents, src: c ? 'scryfall' : 'notfound', sf: c || null });
        });
      } catch {
        batch.forEach((b) => rows.push({ ...b, card: null, lo: null, hi: null, src: 'error' }));
      }
    }

    const total = rows.reduce((a, r) => a + (r.lo || 0) * r.qty, 0);
    const totalHi = rows.reduce((a, r) => a + (r.hi || r.lo || 0) * r.qty, 0);
    const cards = rows.reduce((a, r) => a + r.qty, 0);
    const unpriced = rows.filter((r) => r.lo == null);
    const d7 = rows.filter((r) => r.card?.d7 != null);
    const weighted = d7.length
      ? Math.round(d7.reduce((a, r) => a + r.card.d7 * (r.lo * r.qty), 0) / d7.reduce((a, r) => a + r.lo * r.qty, 0))
      : null;

    out.replaceChildren();
    const stats = el('<div class="stats" style="margin-bottom:14px"></div>');
    stats.append(
      statTile('Deck value', money(total), `${cards} cards, cheapest printings`),
      statTile('If you bought the pricey printings', money(totalHi), `${money(totalHi - total)} more`),
      statTile('7-day move', deltaHTML(weighted), 'value weighted'),
      statTile('Most expensive card', money(Math.max(...rows.map((r) => r.lo || 0))), esc(rows.slice().sort((a, b) => (b.lo || 0) - (a.lo || 0))[0]?.name || '—')),
    );
    out.append(stats);

    const table = el(`<div class="tablewrap"><table>
        <thead><tr><th>Qty</th><th class="wrap">Card</th><th>Cheapest</th><th>Line total</th><th>7d</th><th>Priciest print</th></tr></thead>
        <tbody></tbody></table></div>`);
    const tb = table.querySelector('tbody');
    rows.sort((a, b) => (b.lo || 0) * b.qty - (a.lo || 0) * a.qty).forEach((r) => {
      const href = r.card ? `#/card/${encodeURIComponent(r.card.loId)}` : (r.sf ? `#/card/${encodeURIComponent(r.sf.id)}` : null);
      tb.append(el(`<tr>
          <td class="mono">${r.qty}</td>
          <td class="wrap">${href ? `<a href="${href}" style="text-decoration:none">${esc(r.name)}</a>` : esc(r.name)}
            ${r.src === 'notfound' ? '<span class="badge">not found</span>' : ''}
            ${r.card ? `<div class="fine">${esc(r.card.loS.toUpperCase())}</div>` : ''}</td>
          <td class="mono">${r.lo != null ? moneyExact(r.lo) : '—'}</td>
          <td class="mono">${r.lo != null ? moneyExact(r.lo * r.qty) : '—'}</td>
          <td>${deltaHTML(r.card?.d7 ?? null)}</td>
          <td class="mono">${r.hi != null && r.card ? moneyExact(r.hi) : '—'}</td>
        </tr>`));
    });
    out.append(table);

    if (unpriced.length) {
      out.append(el(`<div class="notice" style="margin-top:12px">${unpriced.length} card${unpriced.length === 1 ? '' : 's'} had no USD price: ${esc(unpriced.slice(0, 8).map((r) => r.name).join(', '))}${unpriced.length > 8 ? '…' : ''}</div>`));
    }
    const save = el('<button type="button" class="btn" style="margin-top:12px">Watch the 10 priciest</button>');
    save.addEventListener('click', () => {
      rows.filter((r) => r.card).slice(0, 10).forEach((r) => {
        if (!store.isWatched(r.card.oid)) store.toggleWatch(r.card.oid, r.card.name, r.card.lo);
      });
      toast('Added to watchlist');
    });
    out.append(save);
  }
}
