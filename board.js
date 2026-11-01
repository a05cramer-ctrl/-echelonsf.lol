'use strict';
// GET /api/board?engine=<pubkey>
// Newest "ECHELON-BOARD|<t>|<cid>" memo PAID by the engine wallet -> board JSON from IPFS (+ cid, sig).
// env HELIUS_API_KEY
const L = require('./_lib');

let cache = null; // { engine, at, body } - warm-instance cache, shared with live.js
async function latestBoard(engine, { maxAge = 60_000 } = {}) {
  if (cache && cache.engine === engine && Date.now() - cache.at < maxAge) return cache.body;
  const rpc = L.makeRpc(L.heliusRpcUrl(process.env.HELIUS_API_KEY), { tries: 4 });
  const found = await L.findBoard(engine, rpc, { limit: 20 });
  let body;
  if (!found) body = { v: 1, t: 0, window: '7d', coins: 0, rows: [], prices: {}, cid: null, sig: null };
  else {
    const j = await L.getJson(`https://ipfs.filebase.io/ipfs/${found.cid}`, {}, { name: 'ipfs', tries: 3 });
    if (!j || j.v !== 1 || !Array.isArray(j.rows)) throw new Error('bad board json');
    body = { ...j, cid: found.cid, sig: found.sig };
  }
  cache = { engine, at: Date.now(), body };
  return body;
}

async function handler(req, res) {
  const engine = String((req.query && req.query.engine) || process.env.ENGINE || '');
  if (!L.B58.test(engine)) return res.status(400).json({ error: 'bad engine' });
  try {
    const body = await latestBoard(engine);
    res.setHeader('Cache-Control', body.cid ? 's-maxage=60, stale-while-revalidate=300' : 's-maxage=20');
    return res.status(200).json(body);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
module.exports = handler;
module.exports.latestBoard = latestBoard;
module.exports._reset = () => { cache = null; };
