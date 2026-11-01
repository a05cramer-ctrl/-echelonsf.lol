'use strict';
// GET /api/live?wallets=w1,w2,...(<=10)&engine=<pubkey, optional>
// Latest StonkFun buys/sells of those wallets: [{wallet, mint, side, tokens, stonk, usd?, symbol?, sig, ts}], newest 40.
// A swap counts when the wallet's coin delta has STONK on the other side, or SOL (aggregator route) on a coin
// that is in the latest board's prices map. env HELIUS_API_KEY (ENGINE optional default).
const L = require('./_lib');
const { latestBoard } = require('./board');

let jupCache = { at: 0, stonkUsd: 0, solUsd: 0 };
async function jupQuotes() {
  if (Date.now() - jupCache.at < 60_000 && jupCache.stonkUsd) return jupCache;
  try {
    const j = await L.getJson(`https://lite-api.jup.ag/price/v3?ids=${L.STONK},${L.SOL}`, {}, { name: 'jupiter', tries: 2 });
    jupCache = { at: Date.now(), stonkUsd: +(j[L.STONK] || {}).usdPrice || 0, solUsd: +(j[L.SOL] || {}).usdPrice || 0 };
  } catch (e) {}
  return jupCache;
}

async function handler(req, res) {
  const q = req.query || {};
  const wallets = [...new Set(String(q.wallets || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!wallets.length || wallets.length > 10 || !wallets.every((w) => L.B58.test(w))) return res.status(400).json({ error: 'wallets: 1-10 base58 addresses, comma separated' });
  const engine = String(q.engine || process.env.ENGINE || '');
  const key = process.env.HELIUS_API_KEY;

  let board = null;
  if (L.B58.test(engine)) { try { board = await latestBoard(engine); } catch (e) {} }
  const prices = (board && board.prices) || {};
  let quotes = board && board.quotes && board.quotes.stonkUsd > 0 ? board.quotes : null;
  if (!quotes || !(quotes.solUsd > 0)) { const j = await jupQuotes(); quotes = { stonkUsd: (quotes && quotes.stonkUsd) || j.stonkUsd, solUsd: (quotes && quotes.solUsd) || j.solUsd }; }
  const ctx = { coinSet: new Set(Object.keys(prices)), stonkUsd: quotes.stonkUsd || 0, stonkPerSol: quotes.stonkUsd > 0 ? (quotes.solUsd || 0) / quotes.stonkUsd : 0 };

  let errors = 0;
  const lists = await L.mapLimit(wallets, 3, async (w) => {
    try {
      const txs = await L.getJson(L.heliusTxUrl(w, key, 15), {}, { name: 'helius', tries: 4, base: 700 });
      return (Array.isArray(txs) ? txs : []).flatMap((tx) => L.extractEvents(tx, w, ctx));
    } catch (e) { errors++; return []; }
  });
  const events = lists.flat().sort((a, b) => b.ts - a.ts).slice(0, 40);
  for (const e of events) if (prices[e.mint] && prices[e.mint].symbol) e.symbol = prices[e.mint].symbol;
  res.setHeader('Cache-Control', 's-maxage=8, stale-while-revalidate=20');
  return res.status(200).json({ t: Math.floor(Date.now() / 1000), events, errors });
}
module.exports = handler;
