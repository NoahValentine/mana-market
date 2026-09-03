// Alerts without a server.
//
// GitHub Pages can host the app but cannot send you anything, so the nightly
// GitHub Action does the notifying through ntfy.sh: it POSTs to a topic URL and
// the free ntfy app on your phone rings. No account, no keys.
//
// Two kinds of alert, both handled by scripts/send-ntfy.mjs:
//   * spike alerts — any tracked card that jumped or dropped more than N% in a
//     day. Works with no configuration at all.
//   * your own thresholds — the rules you arm on the Watchlist screen. Those
//     live in your browser, so this file can hand you the JSON to paste into
//     alerts.json in the repo, which the nightly job reads.
import { store } from './store.js';

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    // Relative registration keeps the scope correct under a Pages sub-path.
    return await navigator.serviceWorker.register('sw.js', { scope: './' });
  } catch {
    return null;
  }
}

export const ntfyTopic = () => store.get().ntfyTopic || '';

export function setNtfyTopic(topic) {
  store.set({ ntfyTopic: topic.trim().replace(/^https?:\/\/ntfy\.sh\//, '') });
}

/** A random, hard-to-guess topic name — ntfy topics are public if guessed. */
export function suggestTopic() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `mana-market-${[...bytes].map((b) => b.toString(36)).join('').slice(0, 12)}`;
}

/** The exact contents of alerts.json for the nightly job. */
export function alertsJson({ spikePct = 25, minDollars = 5 } = {}) {
  const rules = store.rulesForSync().map((r) => ({
    oid: r.oid, name: r.name, dir: r.dir, cents: r.cents,
  }));
  return `${JSON.stringify({
    ntfy_topic: ntfyTopic() || 'PUT-YOUR-TOPIC-HERE',
    spike_pct: spikePct,
    spike_min_dollars: minDollars,
    rules,
  }, null, 2)}\n`;
}

export async function copyAlertsJson(opts) {
  const text = alertsJson(opts);
  try {
    await navigator.clipboard.writeText(text);
    return { copied: true, text };
  } catch {
    return { copied: false, text };
  }
}

export function downloadAlertsJson(opts) {
  const blob = new Blob([alertsJson(opts)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'alerts.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
