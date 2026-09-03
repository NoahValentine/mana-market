// UI smoke test + screenshots. Runs the app against the local dev server with
// Scryfall mocked, exercises every view, and fails on any console/page error.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMocks } from './mock-scryfall.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(ROOT, 'screenshots');
const PORT = 8791;
// Deployed under a GitHub Pages project path, so test that shape too.
const BASE_PATH = process.env.BASE_PATH ?? '/mana-market';
const BASE = `http://localhost:${PORT}${BASE_PATH}`;

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
  { name: 'desktop', width: 1440, height: 950, isMobile: false, deviceScaleFactor: 1 },
];

const errors = [];
const IGNORE = [/favicon/i, /Failed to load resource: the server responded with a status of 404 \(Not Found\)/i];

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(path.join(SHOTS, 'full'), { recursive: true });

const server = spawn(process.execPath, [path.join(HERE, 'serve.mjs')], {
  env: { ...process.env, PORT: String(PORT), BASE_PATH }, stdio: 'ignore',
});
const wait = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${BASE}/`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('dev server never came up');
};

// Viewport screenshots only: a full-page shot of a 60k-pixel search result eats
// hundreds of MB. A couple of named views get a full-page copy for review.
const FULL = new Set(['desktop-01-market', 'desktop-04-trends', 'desktop-06-card', 'mobile-06-card']);
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
  if (FULL.has(name)) await page.screenshot({ path: path.join(SHOTS, 'full', `${name}.png`), fullPage: true });
};

/** No view may scroll sideways — the #1 mobile layout bug. */
const noSideScroll = async (page, vp, where) => {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  if (w.sw > w.iw + 1) errors.push(`[${vp.name}] ${where} scrolls sideways: content ${w.sw}px in a ${w.iw}px viewport`);
};

try {
  await wait();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
      hasTouch: vp.isMobile,
      serviceWorkers: 'block',
    });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' && !IGNORE.some((re) => re.test(m.text()))) errors.push(`[${vp.name}] console: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`[${vp.name}] pageerror: ${e.message}`));
    await installMocks(page);

    // ---- market
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.tile', { timeout: 8000 });
    const tiles = await page.locator('.tile').count();
    if (tiles < 5) errors.push(`[${vp.name}] market rendered only ${tiles} tiles`);
    await shot(page, `${vp.name}-01-market`);
    await noSideScroll(page, vp, 'market');

    // price range + sort — the bounds come from the pack so the assertion is real
    const prices = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'cards.json'), 'utf8'))
      .rows.map((r) => r[2]).sort((a, b) => a - b);
    const lo = Math.floor(prices[Math.floor(prices.length * 0.2)] / 100);
    const hi = Math.ceil(prices[Math.floor(prices.length * 0.8)] / 100);
    await page.locator('#mm-min').fill(String(lo));
    await page.locator('#mm-max').fill(String(hi));
    await page.locator('#mm-min').blur();
    await page.waitForTimeout(250);
    const filtered = await page.locator('.tile').count();
    if (filtered === 0) errors.push(`[${vp.name}] price range ${lo}-${hi} matched nothing`);
    const shownPrices = await page.locator('.tile-price b').allTextContents();
    const outOfRange = shownPrices.map((t) => Number(t.replace(/[^0-9.]/g, '')))
      .filter((v) => v < lo - 0.01 || v > hi + 0.01);
    if (outOfRange.length) errors.push(`[${vp.name}] ${outOfRange.length} card(s) outside the ${lo}-${hi} range: ${outOfRange.slice(0, 3)}`);
    // star a card while the grid is filtered — do it before touching the native
    // <select>, whose emulated popup eats the next tap in mobile emulation
    await page.locator('.tile-star').first().click();
    await page.waitForTimeout(200);
    const starred = await page.evaluate(() => {
      try { return Object.keys(JSON.parse(localStorage.getItem('mm.v1')).watch).length; } catch { return 0; }
    });
    if (starred < 1) {
      const raw = await page.evaluate(() => localStorage.getItem('mm.v1'));
      const cls = await page.locator('.tile-star').first().getAttribute('class');
      errors.push(`[${vp.name}] tapping the star did not save the card (storage=${raw} firstStarClass=${cls})`);
    }

    await page.locator('select').first().selectOption('d7-desc');
    await page.waitForTimeout(250);
    await shot(page, `${vp.name}-02-market-filtered`);

    // basis toggle (desktop only control) + star a card
    if (!vp.isMobile) {
      await page.locator('[data-basis="hi"]').click();
      await page.waitForTimeout(250);
      const label = await page.locator('[data-count]').textContent();
      if (!/priciest printing/.test(label)) errors.push(`[${vp.name}] basis toggle did not switch the market label`);
      await shot(page, `${vp.name}-03-market-priciest`);
      await page.locator('[data-basis="lo"]').click();
      await page.waitForTimeout(200);
    }

    // ---- trends
    await page.goto(`${BASE}/#/trends`, { waitUntil: 'networkidle' });
    await page.waitForSelector('svg.chart', { timeout: 8000 });
    if (await page.locator('.rowitem').count() === 0) errors.push(`[${vp.name}] trends has no movers`);
    await page.locator('[role="tab"]').first().click();
    await page.waitForTimeout(250);
    // hover the chart to prove the crosshair works
    const box = await page.locator('svg.chart').first().boundingBox();
    if (box) await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
    await page.waitForTimeout(150);
    await shot(page, `${vp.name}-04-trends`);
    await noSideScroll(page, vp, 'trends');

    // ---- search
    await page.goto(`${BASE}/#/search`, { waitUntil: 'networkidle' });
    await page.locator('[data-q]').fill('');
    await page.locator('[data-go]').click();
    await page.waitForSelector('.tile', { timeout: 8000 });
    const built = await page.locator('.notice').first().textContent();
    if (!/game:paper/.test(built) || !/prefer:usd-low/.test(built)) errors.push(`[${vp.name}] built query missing defaults: ${built}`);
    await shot(page, `${vp.name}-05-search`);
    await noSideScroll(page, vp, 'search');

    // ---- card detail
    await page.locator('.tile').first().click();
    await page.waitForSelector('.detail', { timeout: 8000 });
    await page.waitForSelector('.tablewrap table tbody tr', { timeout: 8000 });
    if (await page.locator('.detail-art img').count() === 0) errors.push(`[${vp.name}] card page has no image`);
    const rulingsBtn = page.locator('button:has-text("Show rulings")');
    // Assert the button really is the topmost element at its own centre (the a11y
    // question), then fire the handler directly — Playwright's auto-scroll fights
    // the sticky header / fixed bottom nav on the long card page.
    await rulingsBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const topmost = await rulingsBtn.evaluate((n) => {
      const r = n.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === n;
    });
    if (!topmost) errors.push(`[${vp.name}] rulings button is covered by another element`);
    await rulingsBtn.evaluate((n) => n.click());
    await page.waitForTimeout(400);
    await shot(page, `${vp.name}-06-card`);
    await noSideScroll(page, vp, 'card page');

    // ---- watchlist (the card starred on the market page must be here)
    await page.goto(`${BASE}/#/watchlist`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const watchRows = await page.locator('tbody tr').count();
    if (watchRows < 1) errors.push(`[${vp.name}] starring a card did not add it to the watchlist`);
    const navVisible = await page.locator('.bottomnav').isVisible();
    if (vp.isMobile && !navVisible) errors.push(`[${vp.name}] bottom nav missing on the watchlist`);
    await shot(page, `${vp.name}-07-watchlist`);
    await noSideScroll(page, vp, 'watchlist');

    // ---- deck
    await page.goto(`${BASE}/#/deck`, { waitUntil: 'networkidle' });
    const names = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'cards.json'), 'utf8'))
      .rows.slice(0, 6).map((r) => r[1]);
    await page.locator('#dk').fill(names.map((n, i) => `${i % 3 + 1}x ${n}`).join('\n') + '\n1 Nonexistent Fixture Card');
    await page.locator('[data-price]').click();
    await page.waitForSelector('.stats .stat', { timeout: 8000 });
    const deckTotal = await page.locator('.stats .stat .v').first().textContent();
    if (!/\$/.test(deckTotal)) errors.push(`[${vp.name}] deck total did not price: ${deckTotal}`);
    await shot(page, `${vp.name}-08-deck`);
    await noSideScroll(page, vp, 'deck');

    // ---- light theme, on the market
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.locator('[data-theme-toggle]').click();
    await page.waitForTimeout(400);
    await shot(page, `${vp.name}-09-market-light`);
    await page.locator('[data-theme-toggle]').click();

    // ---- 404
    await page.goto(`${BASE}/#/nope`, { waitUntil: 'networkidle' });
    if (!(await page.locator('.empty h2').textContent()).includes('not found')) errors.push(`[${vp.name}] missing 404 view`);

    await ctx.close();
  }
  await browser.close();
} finally {
  server.kill();
}

if (errors.length) {
  console.error(`\nUI test FAILED with ${errors.length} problem(s):`);
  errors.forEach((e) => console.error(` - ${e}`));
  process.exit(1);
}
console.log(`UI test passed. Screenshots in ${SHOTS}`);
