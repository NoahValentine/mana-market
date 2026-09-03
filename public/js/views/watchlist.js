// Watchlist: what you own or hunt, with your own gain/loss and price alerts.
import { loadPack } from '../data.js';
import { scryfall, printingPrices } from '../scryfall.js';
import { store } from '../store.js';
import { el, esc, money, moneyExact, deltaHTML, statTile, emptyState, toast, sparkline } from '../ui.js';
import { seriesFor } from '../data.js';
import { ntfyTopic, setNtfyTopic, suggestTopic, copyAlertsJson, downloadAlertsJson } from '../alerts.js';

export async function watchlistView(root) {
  root.append(el(`<div class="page-head"><h1>Watchlist</h1><p>Saved on this device. Alerts fire after the nightly price sync.</p></div>`));
  const pushBox = el('<div style="margin-bottom:14px"></div>');
  root.append(pushBox);
  const stats = el('<div class="stats" style="margin-bottom:14px"></div>');
  root.append(stats);
  const body = el('<div></div>');
  root.append(body);
  const tools = el('<div class="row" style="margin-top:16px"></div>');
  root.append(tools);

  const pack = await loadPack().catch(() => null);
  renderPush();
  render();

  function renderPush() {
    pushBox.replaceChildren();
    const panel = el(`<div class="card-panel"><h2 class="sec">Phone alerts <span class="fine">free, via ntfy.sh — no account</span></h2></div>`);
    const topic = ntfyTopic();

    const row = el('<div class="row" style="margin-bottom:10px"></div>');
    const input = el('<input type="text" placeholder="your ntfy topic" style="flex:1;min-width:180px" spellcheck="false">');
    input.value = topic;
    const gen = el('<button type="button" class="btn">Make one up</button>');
    gen.addEventListener('click', () => { input.value = suggestTopic(); setNtfyTopic(input.value); renderPush(); });
    input.addEventListener('change', () => { setNtfyTopic(input.value); renderPush(); });
    row.append(input, gen);
    panel.append(row);

    if (topic) {
      panel.append(el(`<p class="fine" style="margin:0 0 10px">
          Install the <b>ntfy</b> app (App Store / Play Store), subscribe to the topic
          <b>${esc(topic)}</b>, and the nightly job will push movers to your phone.
          Treat the topic name like a password — anyone who guesses it can read your alerts.
        </p>`));
    } else {
      panel.append(el('<p class="fine" style="margin:0 0 10px">Pick a topic name (or tap "Make one up"), then subscribe to it in the free ntfy app on your phone.</p>'));
    }

    const tools = el('<div class="row"></div>');
    const copy = el('<button type="button" class="btn btn-primary">Copy alerts.json</button>');
    copy.addEventListener('click', async () => {
      const { copied } = await copyAlertsJson();
      toast(copied ? 'alerts.json copied — paste it into the repo' : 'Clipboard blocked, downloading instead');
      if (!copied) downloadAlertsJson();
    });
    const dl = el('<button type="button" class="btn">Download alerts.json</button>');
    dl.addEventListener('click', () => downloadAlertsJson());
    tools.append(copy, dl);
    panel.append(tools);
    panel.append(el(`<p class="fine" style="margin:10px 0 0">
        Commit that file to the repo root and the nightly job picks up your thresholds.
        Big daily spikes are alerted anyway, with or without it.
      </p>`));
    pushBox.append(panel);
  }

  function render() {
    const items = store.watchList();
    body.replaceChildren();
    tools.replaceChildren();
    if (!items.length) {
      stats.replaceChildren();
      body.append(emptyState('Nothing on the watchlist yet', 'Tap the star on any card to track it here.'));
      return;
    }

    const rows = items.map((w) => {
      const c = pack?.byOid.get(w.oid) || null;
      const now = c?.lo ?? null;
      const since = (w.addedCents && now) ? Math.round(((now - w.addedCents) / w.addedCents) * 10000) : null;
      return { ...w, card: c, now, since };
    });

    const total = rows.reduce((a, r) => a + (r.now || 0), 0);
    const totalAdded = rows.reduce((a, r) => a + (r.addedCents || 0), 0);
    const totalPct = totalAdded ? Math.round(((total - totalAdded) / totalAdded) * 10000) : null;
    const alerts = rows.reduce((a, r) => a + (r.alerts?.length || 0), 0);
    stats.replaceChildren(
      statTile('Cards tracked', String(rows.length)),
      statTile('Value now', money(total), 'cheapest printings'),
      statTile('Since you added', deltaHTML(totalPct), totalAdded ? `was ${money(totalAdded)}` : ''),
      statTile('Alerts armed', String(alerts)),
    );

    const table = el(`<div class="tablewrap"><table>
        <thead><tr><th class="wrap">Card</th><th>Trend</th><th>Now</th><th>24h</th><th>7d</th><th>Since added</th><th>Alerts</th><th></th></tr></thead>
        <tbody></tbody></table></div>`);
    const tb = table.querySelector('tbody');

    rows.sort((a, b) => (b.now || 0) - (a.now || 0)).forEach((r) => {
      const tr = el(`<tr>
          <td class="wrap">${r.card
    ? `<a href="#/card/${encodeURIComponent(r.card.loId)}" style="text-decoration:none"><b>${esc(r.n)}</b></a><div class="fine">${esc(r.card.loS.toUpperCase())} · added ${esc(r.addedAt)}</div>`
    : `<b>${esc(r.n)}</b><div class="fine">below tracking threshold · added ${esc(r.addedAt)}</div>`}</td>
          <td data-spark></td>
          <td class="mono">${money(r.now)}</td>
          <td>${deltaHTML(r.card?.d1 ?? null)}</td>
          <td>${deltaHTML(r.card?.d7 ?? null)}</td>
          <td>${deltaHTML(r.since)}${r.addedCents ? `<div class="fine mono">from ${moneyExact(r.addedCents)}</div>` : ''}</td>
          <td>${(r.alerts || []).map((a) => `<span class="badge">${a.dir === 'up' ? '≥' : '≤'} ${moneyExact(a.cents)}</span>`).join(' ') || '<span class="fine">none</span>'}</td>
          <td></td>
        </tr>`);
      const rm = el('<button type="button" class="btn btn-ghost" aria-label="Remove">✕</button>');
      rm.addEventListener('click', () => { store.toggleWatch(r.oid, r.n); render(); });
      tr.lastElementChild.append(rm);
      tb.append(tr);
      if (r.card && pack) {
        seriesFor(pack, r.card).then((s) => {
          if (s && s.length > 1) tr.querySelector('[data-spark]').append(sparkline(s.slice(-30)));
        }).catch(() => {});
      }
      if (!r.card) {
        // Fill in a live price for cards outside the pack.
        scryfall.search({ q: `oracleid:${r.oid} game:paper prefer:usd-low`, unique: 'cards', order: 'usd', dir: 'asc' })
          .then((res) => {
            const p = printingPrices(res.data[0] || {})[0];
            if (p) tr.children[2].textContent = moneyExact(p.cents);
          }).catch(() => {});
      }
    });
    body.append(table);

    const exp = el('<button type="button" class="btn">Export watchlist</button>');
    exp.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(store.get().watch, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'mana-market-watchlist.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    const imp = el('<label class="btn">Import<input type="file" accept="application/json" hidden></label>');
    imp.querySelector('input').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        store.set({ watch: { ...store.get().watch, ...data } });
        toast('Watchlist imported');
        render();
      } catch { toast('That file was not a watchlist export'); }
    });
    tools.append(exp, imp);
  }

  store.onChange(() => { /* re-render is explicit here to avoid loops */ });
}
