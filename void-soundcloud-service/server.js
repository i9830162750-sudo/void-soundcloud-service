'use strict';

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const compression = require('compression');
const rateLimit  = require('express-rate-limit');
const sc         = require('./soundcloud');

const app  = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: '*', methods: ['GET', 'OPTIONS'] }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down.' },
}));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'void-soundcloud' }));

// ── Search  GET /search?q=query&limit=15 ─────────────────────────────────────
app.get('/search', async (req, res, next) => {
  try {
    const q     = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '15'), 30);
    if (!q) return res.status(400).json({ error: 'Missing query parameter: q' });

    const results = await sc.search(q, limit);
    res.json({ items: results, source: 'soundcloud' });
  } catch (e) {
    console.error('[SC search]', e.message);
    next(e);
  }
});

// ── Stream  GET /stream?id=TRACK_ID ──────────────────────────────────────────
// Returns { url, mimeType } — same contract as the JioSaavn service
app.get('/stream', async (req, res, next) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const result = await sc.getStreamUrl(id);
    if (!result.url) return res.status(502).json({ error: 'No stream URL found' });

    res.json(result); // { url, mimeType }
  } catch (e) {
    console.error('[SC stream]', e.message);
    next(e);
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[void-soundcloud] Running on port ${PORT}`);
});

module.exports = app;
