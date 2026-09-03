// Local, per-device state: settings + watchlist + alert rules.
const KEY = 'mm.v1';

const DEFAULTS = {
  basis: 'lo',            // 'lo' = cheapest printing, 'hi' = most expensive
  theme: 'dark',          // 'dark' | 'light'
  watch: {},              // oid -> { n, addedAt, addedCents, alerts: [{dir:'up'|'down', cents}] }
  lastSeenDay: null,      // meta.days last element on previous visit
  pushEndpoint: null,
  ntfyTopic: null,        // ntfy.sh topic the nightly job pushes alerts to
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

let state = read();
const subs = new Set();

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
  subs.forEach((fn) => fn(state));
}

export const store = {
  get: () => state,
  onChange(fn) { subs.add(fn); return () => subs.delete(fn); },

  set(patch) { state = { ...state, ...patch }; persist(); },

  get basis() { return state.basis; },
  setBasis(b) { if (b === 'lo' || b === 'hi') this.set({ basis: b }); },

  get theme() { return state.theme; },
  setTheme(t) {
    this.set({ theme: t });
    document.documentElement.dataset.theme = t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === 'light' ? '#f4f3ef' : '#12120f';
  },

  // --- watchlist ---
  isWatched(oid) { return Boolean(state.watch[oid]); },
  watchCount() { return Object.keys(state.watch).length; },
  watchList() { return Object.entries(state.watch).map(([oid, v]) => ({ oid, ...v })); },
  toggleWatch(oid, name, cents) {
    const w = { ...state.watch };
    if (w[oid]) delete w[oid];
    else w[oid] = { n: name, addedAt: new Date().toISOString().slice(0, 10), addedCents: cents ?? null, alerts: [] };
    this.set({ watch: w });
    return Boolean(w[oid]);
  },
  setAlerts(oid, alerts) {
    if (!state.watch[oid]) return;
    const w = { ...state.watch, [oid]: { ...state.watch[oid], alerts } };
    this.set({ watch: w });
  },
  rulesForSync() {
    const out = [];
    for (const [oid, v] of Object.entries(state.watch)) {
      for (const a of v.alerts || []) out.push({ oid, name: v.n, dir: a.dir, cents: a.cents });
    }
    return out.slice(0, 200);
  },
};

store.setTheme(state.theme);
