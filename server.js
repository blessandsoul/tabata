import express from 'express';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Pretend to be Safari so SoundCloud serves us the regular response.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.6 Safari/605.1.15';

// SoundCloud closed new app registrations in 2021. The only way to talk to
// their public API is with a client_id scraped from soundcloud.com's own
// JS bundle. Rotate via the SC_CLIENT_ID env var if all of these stop
// working — open any soundcloud.com page, view source, grep for
// "client_id=".
const SC_FALLBACK_IDS = [
  process.env.SC_CLIENT_ID,
  'iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX',
  '2t9loNQH90kzJcsFCODdigxfp325aq4z',
  'T5R4kgWS2PRf6lzLyIravUMnKlbIxQag',
  'a3e059563d7fd3372b49b37f00a00bcf',
].filter(Boolean);

let workingId = null;
let scrapedId = null;
let scrapedAt = 0;
const SCRAPE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Scrape a current client_id straight from soundcloud.com's own JS bundle.
// This is how every unofficial SoundCloud library stays alive when SC
// rotates keys.
async function scrapeClientId(force = false) {
  if (!force && scrapedId && Date.now() - scrapedAt < SCRAPE_TTL_MS) {
    return scrapedId;
  }
  try {
    const r = await fetch('https://soundcloud.com/discover', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    });
    if (!r.ok) return scrapedId;
    const html = await r.text();
    const urls = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1]);
    // Last script tends to be the main bundle with the client_id.
    for (const u of urls.reverse()) {
      try {
        const sr = await fetch(u, { headers: { 'User-Agent': UA } });
        if (!sr.ok) continue;
        const js = await sr.text();
        const m = js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
        if (m) {
          scrapedId = m[1];
          scrapedAt = Date.now();
          console.log(`SC: scraped fresh client_id ${scrapedId.slice(0, 6)}…`);
          return scrapedId;
        }
      } catch {}
    }
  } catch (e) {
    console.warn('SC scrape error:', e.message);
  }
  return scrapedId;
}

async function scFetch(url, cid) {
  const sep = url.includes('?') ? '&' : '?';
  return fetch(`${url}${sep}client_id=${cid}`, {
    headers: { 'User-Agent': UA, 'Accept': '*/*' },
  });
}

async function attemptResolve(scUrl, cid) {
  const r = await scFetch(
    `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(scUrl)}`,
    cid
  );
  if (r.status === 401 || r.status === 403) {
    const err = new Error(`client_id rejected (${r.status})`);
    err.rejected = true;
    throw err;
  }
  if (!r.ok) throw new Error(`resolve status ${r.status}`);

  const track = await r.json();
  if (track.kind !== 'track') throw new Error('URL is not a single track');
  if (!track.media || !Array.isArray(track.media.transcodings) || !track.media.transcodings.length) {
    throw new Error('no streams available');
  }

  const tr =
    track.media.transcodings.find((t) => t.format && t.format.protocol === 'progressive') ||
    track.media.transcodings.find((t) => t.format && t.format.protocol === 'hls');
  if (!tr) throw new Error('no usable transcoding');

  const sr = await scFetch(tr.url, cid);
  if (sr.status === 401 || sr.status === 403) {
    const err = new Error(`client_id rejected on stream (${sr.status})`);
    err.rejected = true;
    throw err;
  }
  if (!sr.ok) throw new Error(`stream-url status ${sr.status}`);
  const body = await sr.json();
  if (!body || !body.url) throw new Error('empty stream url');

  return {
    streamUrl: body.url,
    protocol: tr.format.protocol,
    title: track.title,
    artist: track.user && track.user.username,
    duration: Math.round((track.duration || 0) / 1000),
  };
}

async function resolveTrack(scUrl) {
  let lastErr = null;
  const tried = new Set();

  const tryId = async (cid, label) => {
    if (!cid || tried.has(cid)) return null;
    tried.add(cid);
    try {
      const result = await attemptResolve(scUrl, cid);
      workingId = cid;
      return result;
    } catch (e) {
      lastErr = e;
      if (e.rejected && workingId === cid) workingId = null;
      console.warn(`SC: ${label} ${cid.slice(0, 6)}… → ${e.message}`);
      return null;
    }
  };

  // 1) freshly scraped (cached up to TTL)
  let result = await tryId(await scrapeClientId(false), 'scraped');
  if (result) return result;

  // 2) last known working
  result = await tryId(workingId, 'working');
  if (result) return result;

  // 3) hardcoded fallbacks
  for (const cid of SC_FALLBACK_IDS) {
    result = await tryId(cid, 'fallback');
    if (result) return result;
  }

  // 4) force a fresh scrape (cache likely stale) and retry once
  const fresh = await scrapeClientId(true);
  if (fresh) {
    result = await tryId(fresh, 'scrape-retry');
    if (result) return result;
  }

  throw lastErr || new Error('all client_ids failed');
}

app.get('/api/sc/resolve', async (req, res) => {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).json({ error: 'missing url' });
  try {
    const t = await resolveTrack(url);
    const proxyPath = t.protocol === 'hls' ? '/api/sc/playlist' : '/api/sc/stream';
    res.json({
      title: t.title,
      artist: t.artist,
      duration: t.duration,
      protocol: t.protocol,
      streamProxyUrl: `${proxyPath}?u=${encodeURIComponent(t.streamUrl)}`,
    });
  } catch (e) {
    res.status(502).json({ error: e.message || 'resolve failed' });
  }
});

app.get('/api/sc/stream', async (req, res) => {
  const url = String(req.query.u || '');
  if (!url) return res.status(400).end();

  const headers = { 'User-Agent': UA, 'Accept': '*/*' };
  if (req.headers.range) headers.range = req.headers.range;

  try {
    const upstream = await fetch(url, { headers });
    res.status(upstream.status);

    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch {
    res.status(502).end();
  }
});

app.get('/api/sc/playlist', async (req, res) => {
  const url = String(req.query.u || '');
  if (!url) return res.status(400).end();

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
    });
    if (!upstream.ok) return res.status(upstream.status).end();

    let text = await upstream.text();
    // Rewrite absolute http(s) segment URLs to go through our stream proxy.
    text = text.replace(/^(https?:\/\/[^\s]+)$/gm, (m) =>
      `/api/sc/stream?u=${encodeURIComponent(m)}`
    );

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(text);
  } catch {
    res.status(502).end();
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/sc/clientid', async (req, res) => {
  const force = req.query.force === '1';
  const id = await scrapeClientId(force);
  res.json({
    scraped: id ? id.slice(0, 6) + '…' : null,
    working: workingId ? workingId.slice(0, 6) + '…' : null,
    scrapedAtMs: scrapedAt,
    fallbacks: SC_FALLBACK_IDS.length,
  });
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`tabata server listening on 0.0.0.0:${port}`);
  // Warm the SoundCloud client_id cache so the first request is fast.
  scrapeClientId(true).catch((e) => console.warn('SC warmup failed:', e.message));
});
