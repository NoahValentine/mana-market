// worker/index.js
//
// Mana Market's Cloudflare Worker: push-subscription + watchlist sync API
// only (`/api/*`). Everything else is served as static assets from
// `public/` via the `[assets]` binding in wrangler.toml -- this fetch
// handler only ever runs for `/api/*` requests (Cloudflare routes static
// asset requests to the assets binding before this code runs, per the
// current "assets + Worker" pattern; see wrangler.toml for the routing
// config and a note on the one key we couldn't verify).
//
// Storage: KV namespace `SUBS`, key = sha256(endpoint) hex, value = the
// JSON-encoded subscribe body. We only ever key by the *hash* of the
// endpoint and never log the endpoint itself (push endpoints are
// effectively bearer-token URLs).

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const MAX_RULES = 200;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, { status = 200, origin } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin) },
  });
}

function badRequest(message, origin) {
  return json({ ok: false, error: message }, { status: 400, origin });
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish string compare: always walks the full max length. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function requireAdmin(request, env) {
  const token = request.headers.get('X-Admin-Token') || '';
  return safeEqual(token, env.ADMIN_TOKEN || '');
}

// ---- validation -----------------------------------------------------------

function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function validateSubscribeBody(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!isHttpsUrl(body.endpoint)) return 'endpoint must be an https URL';
  if (!body.keys || typeof body.keys !== 'object') return 'keys is required';
  if (typeof body.keys.p256dh !== 'string' || body.keys.p256dh.length === 0) {
    return 'keys.p256dh is required';
  }
  if (typeof body.keys.auth !== 'string' || body.keys.auth.length === 0) {
    return 'keys.auth is required';
  }
  if (!Array.isArray(body.rules)) return 'rules must be an array';
  if (body.rules.length > MAX_RULES) return `rules must have at most ${MAX_RULES} entries`;
  for (const rule of body.rules) {
    if (!rule || typeof rule !== 'object') return 'each rule must be an object';
    if (typeof rule.oid !== 'string' || rule.oid.length === 0) return 'rule.oid is required';
    if (typeof rule.name !== 'string') return 'rule.name is required';
    if (rule.dir !== 'up' && rule.dir !== 'down') return 'rule.dir must be "up" or "down"';
    if (!isPositiveInt(rule.cents)) return 'rule.cents must be a positive integer';
  }
  return null;
}

// ---- route handlers ---------------------------------------------------

async function handleVapid(env, origin) {
  return json({ publicKey: env.VAPID_PUBLIC_KEY || '' }, { origin });
}

async function handleSubscribe(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('invalid JSON body', origin);
  }
  const err = validateSubscribeBody(body);
  if (err) return badRequest(err, origin);

  const id = await sha256Hex(body.endpoint);
  const record = {
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    rules: body.rules,
    updated_at: new Date().toISOString(),
  };
  await env.SUBS.put(id, JSON.stringify(record));
  return json({ ok: true, id }, { origin });
}

async function handleUnsubscribe(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('invalid JSON body', origin);
  }
  if (!isHttpsUrl(body?.endpoint)) return badRequest('endpoint must be an https URL', origin);
  const id = await sha256Hex(body.endpoint);
  await env.SUBS.delete(id);
  return json({ ok: true }, { origin });
}

async function handleSubs(request, env, origin) {
  if (!requireAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, { status: 401, origin });

  const lines = [];
  let cursor;
  do {
    const page = await env.SUBS.list({ cursor });
    for (const key of page.keys) {
      const value = await env.SUBS.get(key.name);
      if (value) lines.push(value);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return new Response(lines.join('\n') + (lines.length ? '\n' : ''), {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      ...corsHeaders(origin),
    },
  });
}

async function handleSent(request, env, origin) {
  if (!requireAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, { status: 401, origin });
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('invalid JSON body', origin);
  }
  if (!Array.isArray(body?.dead)) return badRequest('dead must be an array of endpoints', origin);
  for (const endpoint of body.dead) {
    if (!isHttpsUrl(endpoint)) continue;
    const id = await sha256Hex(endpoint);
    await env.SUBS.delete(id);
  }
  return json({ ok: true }, { origin });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (!url.pathname.startsWith('/api/')) {
      // Static assets are matched before this handler runs, so anything that
      // arrives here is a path with no file behind it. Hand navigations the
      // app shell (so /trends typed by hand still works) and 404 the rest.
      const wantsHtml = (request.headers.get('Accept') || '').includes('text/html');
      if (env.ASSETS && request.method === 'GET' && wantsHtml) {
        return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
      }
      return new Response('Not found', { status: 404 });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === '/api/vapid' && request.method === 'GET') {
        return handleVapid(env, origin);
      }
      if (url.pathname === '/api/subscribe' && request.method === 'POST') {
        return handleSubscribe(request, env, origin);
      }
      if (url.pathname === '/api/unsubscribe' && request.method === 'POST') {
        return handleUnsubscribe(request, env, origin);
      }
      if (url.pathname === '/api/subs' && request.method === 'GET') {
        return handleSubs(request, env, origin);
      }
      if (url.pathname === '/api/sent' && request.method === 'POST') {
        return handleSent(request, env, origin);
      }
    } catch (err) {
      // Never log request bodies/endpoints; a stack trace here is safe.
      console.error('worker error', err && err.stack ? err.stack : String(err));
      return json({ ok: false, error: 'internal error' }, { status: 500, origin });
    }

    return json({ ok: false, error: 'not found' }, { status: 404, origin });
  },
};
