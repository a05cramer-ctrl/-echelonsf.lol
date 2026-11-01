'use strict';
// ECHELON shared logic. The SAME file lives at engine/lib.js and site/api/_lib.js (test/copy.test.mjs
// checks they match). If you change one, copy it over the other.
//
// Trade = a confirmed Helius enhanced tx where the owner's (engine: the fee payer's) balance of a coin
// and of the quote leg move in opposite directions:
//   - STONK leg: StonkFun coins trade against STONK (curve "stonkfun" and migrated Raydium CPMM pools).
//   - SOL leg:  aggregator routes (Jupiter etc.) that go SOL -> STONK -> coin in one tx leave the wallet's
//               STONK unchanged; the SOL leg (native + wSOL) is converted to STONK with Jupiter prices
//               (stonkPerSol = solUsd / stonkUsd).
// Everything else (plain transfers, airdrops, coin->coin routes with no quote leg, failed txs) is ignored.

const STONK = '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const PLATFORM = '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// Raydium LaunchLab + CPMM vault authorities (the "user" of curve / pool vault token accounts)
const POOL_AUTHS = ['WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', 'GpMZbSM2GzbTKXEDLHCJn7NbHf2FBPgrr6WsSyGSEfvJ'];
const NOT_COINS = new Set([STONK, SOL, USDC, USDT]);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MEMO_RE = /ECHELON-BOARD\|(\d+)\|([A-Za-z0-9]{46,})/;
const DAY = 86400;
const WINDOW = 7 * DAY;
const MIN_SOL_LEG = 0.003; // SOL legs smaller than this are rent / fee noise (a token account costs 0.00204 SOL)
const EPS = 1e-12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const heliusTxUrl = (addr, key, limit, before) =>
  `https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${key}&limit=${limit}${before ? '&before=' + before : ''}`;
const heliusRpcUrl = (key) => `https://mainnet.helius-rpc.com/?api-key=${key}`;

// fetch JSON with backoff on 429 / 5xx / network errors
async function getJson(url, opts = {}, { tries = 5, base = 800, name = 'http', log = null } = {}) {
  let delay = base;
  for (let i = 1; ; i++) {
    let r;
    try { r = await fetch(url, opts); } catch (e) {
      if (i >= tries) throw new Error(`${name}: network error ${e.message}`);
      await sleep(delay); delay = Math.min(delay * 2, 30000); continue;
    }
    if (r.status === 429 || r.status >= 500) {
      if (i >= tries) throw new Error(`${name}: HTTP ${r.status} after ${i} tries`);
      if (log && r.status === 429) log(`  ${name}: 429, backing off ${delay}ms`);
      await sleep(delay); delay = Math.min(delay * 2, 30000); continue;
    }
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
  }
}

function makeRpc(url, opts = {}) {
  let id = 0;
  return async (method, params) => {
    const d = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }, { name: `rpc ${method}`, ...opts });
    if (d.error) throw new Error(`rpc ${method}: ${d.error.message || JSON.stringify(d.error)}`);
    return d.result;
  };
}

// run fn over items with at most n in flight
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ------------------------------------------------------------------ trade extraction
// Balance deltas of `owner` in one enhanced tx: coins (per mint), STONK, SOL (native + wSOL, network fee added back)
function balances(tx, owner) {
  const tok = new Map(); let stonk = 0; let sol = 0;
  for (const a of tx.accountData || []) {
    for (const c of a.tokenBalanceChanges || []) {
      if (c.userAccount !== owner || !c.rawTokenAmount) continue;
      const v = Number(c.rawTokenAmount.tokenAmount) / 10 ** (c.rawTokenAmount.decimals || 0);
      if (!v) continue;
      if (c.mint === STONK) stonk += v;
      else if (c.mint === SOL) sol += v;
      else tok.set(c.mint, (tok.get(c.mint) || 0) + v);
    }
    if (a.account === owner) sol += (a.nativeBalanceChange || 0) / 1e9;
  }
  if (tx.feePayer === owner) sol += (tx.fee || 0) / 1e9; // network fee is not trading PnL
  return { tok, stonk, sol };
}

// Quote leg for a coin delta, or null if it's not a swap. dQ is in STONK (+ = received, - = spent).
function quoteLeg(dTok, b, stonkPerSol) {
  if (Math.abs(dTok) < EPS) return null;
  if (Math.abs(b.stonk) > EPS && Math.sign(b.stonk) !== Math.sign(dTok)) return { dQ: b.stonk, leg: 'stonk' };
  if (Math.abs(b.sol) >= MIN_SOL_LEG && Math.sign(b.sol) !== Math.sign(dTok) && stonkPerSol > 0) return { dQ: b.sol * stonkPerSol, leg: 'sol', dSol: b.sol };
  return null;
}

// One trade of `mint` by `owner` (default: fee payer). ctx = {stonkPerSol, owner}
function extractTrade(tx, mint, ctx = {}) {
  if (!tx || tx.transactionError || tx.type === 'TRANSFER') return null;
  const owner = ctx.owner || tx.feePayer; if (!owner) return null;
  const b = balances(tx, owner);
  const dTok = b.tok.get(mint) || 0;
  const q = quoteLeg(dTok, b, ctx.stonkPerSol || 0);
  if (!q) return null;
  return { wallet: owner, mint, ts: tx.timestamp, sig: tx.signature, dTok, dQ: q.dQ, leg: q.leg };
}

// Live feed: every StonkFun-coin trade of `owner` in tx.
// A mint counts if its counter-leg is STONK, or (SOL leg) if it is in coinSet (the board's prices map).
function extractEvents(tx, owner, { stonkPerSol = 0, stonkUsd = 0, coinSet = new Set() } = {}) {
  if (!tx || tx.transactionError || tx.type === 'TRANSFER') return [];
  const b = balances(tx, owner); const out = [];
  for (const [mint, dTok] of b.tok) {
    if (NOT_COINS.has(mint)) continue;
    const q = quoteLeg(dTok, b, stonkPerSol);
    if (!q) continue;
    if (q.leg === 'sol' && !coinSet.has(mint)) continue;
    const stonk = Math.abs(q.dQ);
    const e = { wallet: owner, mint, side: dTok > 0 ? 'buy' : 'sell', tokens: Math.abs(dTok), stonk, sig: tx.signature, ts: tx.timestamp };
    if (stonkUsd > 0) e.usd = +(stonk * stonkUsd).toFixed(2);
    out.push(e);
  }
  return out;
}

// creation tx of a mint: the mint account itself gets rent lamports; fee payer = creator
function creatorFromTx(tx, mint) {
  for (const a of tx.accountData || []) if (a.account === mint && (a.nativeBalanceChange || 0) > 0) return tx.feePayer || null;
  return null;
}

// ------------------------------------------------------------------ incremental ingest
// Per-coin cursor c = { head:{sig,ts}, gap:{from,top}|null, tail:{sig,ts}, backfilled }
//   head = newest tx such that everything newer-than-tail up to head is ingested.
//   gap  = a run that started at `top` but ran out of pages before reaching head; resume `before=from`.
//   tail = oldest tx ingested (backfill continues before it until older than now - 7d).
// getPage(before) -> enhanced txs newest first. seen = Set of `${sig}:${mint}` (dedupe across runs).
// onTrade(row) with row = [ts, wallet, mint, dTok, dQuoteStonk, usd, sig]
async function ingestCoin(mint, c, { getPage, budget, now, stonkPerSol, stonkUsd, seen, onTrade }) {
  const cutoff = now - WINDOW; let pages = 0; let added = 0;
  const take = (tx) => {
    if (!tx || tx.timestamp < cutoff) return;
    if (!c.creator) { const cr = creatorFromTx(tx, mint); if (cr) c.creator = cr; }
    const t = extractTrade(tx, mint, { stonkPerSol });
    if (!t) return;
    const key = `${t.sig}:${mint}`; if (seen.has(key)) return; seen.add(key);
    onTrade([t.ts, t.wallet, mint, +t.dTok.toPrecision(10), +t.dQ.toPrecision(10), +(Math.abs(t.dQ) * stonkUsd).toFixed(4), t.sig]); added++;
  };
  const older = (tx, h) => tx.signature === h.sig || tx.timestamp < h.ts;
  const page = async (before) => { pages++; const p = await getPage(before || null); return Array.isArray(p) ? p : []; };

  if (!c.head) { // first run: newest page starts both the head and the backfill
    const p = await page(null);
    if (!p.length) { c.backfilled = true; return { pages, added }; }
    c.head = { sig: p[0].signature, ts: p[0].timestamp };
    p.forEach(take);
    const last = p[p.length - 1]; c.tail = { sig: last.signature, ts: last.timestamp };
    c.backfilled = last.timestamp < cutoff;
    c.gap = null; c.fresh = true;
  } else c.fresh = false;

  if (c.gap && pages < budget) { // finish an unfinished stretch first
    let reached = false;
    while (pages < budget) {
      const p = await page(c.gap.from);
      if (!p.length) { reached = true; break; }
      for (const tx of p) { if (older(tx, c.head) || tx.timestamp < cutoff) { reached = true; break; } take(tx); }
      if (reached) break;
      c.gap.from = p[p.length - 1].signature;
    }
    if (reached) { c.head = c.gap.top; c.gap = null; }
  }

  if (!c.gap && !c.fresh && pages < budget) { // new txs since head
    let before = null; let top = null; let reached = false;
    while (pages < budget) {
      const p = await page(before);
      if (!p.length) { reached = true; break; }
      if (!top) top = { sig: p[0].signature, ts: p[0].timestamp };
      for (const tx of p) { if (older(tx, c.head) || tx.timestamp < cutoff) { reached = true; break; } take(tx); }
      if (reached) break;
      before = p[p.length - 1].signature;
    }
    if (top) { if (reached) c.head = top; else c.gap = { from: before, top }; }
  }

  while (!c.backfilled && c.tail && pages < budget) { // backfill toward now - 7d
    const p = await page(c.tail.sig);
    if (!p.length) { c.backfilled = true; break; }
    p.forEach(take);
    const last = p[p.length - 1]; c.tail = { sig: last.signature, ts: last.timestamp };
    if (last.timestamp < cutoff) c.backfilled = true;
  }
  delete c.fresh;
  return { pages, added };
}

function pruneTrades(trades, now) {
  const cutoff = now - WINDOW;
  return trades.filter((t) => t[0] >= cutoff);
}

// ------------------------------------------------------------------ scoring
// coins = { mint: { price, symbol, creator, pools:[] } }. PnL per wallet per coin (USD):
//   sells_usd - buys_usd + net_tokens_from_window x current price  (realized + unrealized, mark-to-market)
function score(trades, coins, { now, exclude = new Set(), minTrades = 3, minVolUsd = 50, top = 50 } = {}) {
  const cutoff = now - WINDOW;
  const ex = new Set(exclude); for (const a of POOL_AUTHS) ex.add(a);
  for (const c of Object.values(coins)) for (const p of c.pools || []) ex.add(p);
  const W = new Map();
  for (const [ts, w, m, dTok, , usd] of trades) {
    if (ts < cutoff || ex.has(w)) continue;
    const coin = coins[m]; if (!coin) continue;
    if (coin.creator && coin.creator === w) continue; // a coin's creator doesn't rank on its own coin
    let s = W.get(w); if (!s) W.set(w, s = { coins: new Map(), trades: 0, vol: 0, last: 0 });
    let k = s.coins.get(m); if (!k) s.coins.set(m, k = { buy: 0, sell: 0, net: 0 });
    if (dTok > 0) k.buy += usd; else k.sell += usd;
    k.net += dTok; s.trades++; s.vol += usd; if (ts > s.last) s.last = ts;
  }
  const rows = [];
  for (const [wallet, s] of W) {
    if (s.trades < minTrades || s.vol < minVolUsd) continue;
    let pnl = 0; let wins = 0; let best = null;
    for (const [m, k] of s.coins) {
      const p = k.sell - k.buy + k.net * (coins[m].price || 0);
      pnl += p; if (p > 0) wins++;
      if (!best || p > best.pnl) best = { mint: m, symbol: coins[m].symbol || '', pnl: p };
    }
    rows.push({ wallet, pnl: +pnl.toFixed(2), vol: +s.vol.toFixed(2), trades: s.trades, coins: s.coins.size,
      winRate: +(wins / s.coins.size).toFixed(3), best: { ...best, pnl: +best.pnl.toFixed(2) }, last: s.last });
  }
  rows.sort((a, b) => b.pnl - a.pnl || b.vol - a.vol);
  return rows.slice(0, top);
}

// ------------------------------------------------------------------ on-chain board receipt
// Newest memo "ECHELON-BOARD|<t>|<cid>" in a tx PAID by `engine` (anyone can put a memo in a tx that
// mentions the engine address, so the fee payer is checked with getTransaction).
async function findBoard(engine, rpc, { limit = 20 } = {}) {
  const sigs = await rpc('getSignaturesForAddress', [engine, { limit, commitment: 'confirmed' }]);
  for (const s of sigs || []) {
    if (s.err || !s.memo) continue;
    const m = String(s.memo).match(MEMO_RE); if (!m) continue;
    const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (!tx || (tx.meta && tx.meta.err)) continue;
    const k = tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys && tx.transaction.message.accountKeys[0];
    const payer = typeof k === 'string' ? k : k && k.pubkey;
    if (payer !== engine) continue;
    return { t: +m[1], cid: m[2], sig: s.signature };
  }
  return null;
}

module.exports = {
  STONK, SOL, USDC, USDT, PLATFORM, MEMO_PROGRAM, POOL_AUTHS, NOT_COINS, B58, MEMO_RE, DAY, WINDOW, MIN_SOL_LEG,
  sleep, getJson, makeRpc, mapLimit, heliusTxUrl, heliusRpcUrl,
  balances, quoteLeg, extractTrade, extractEvents, creatorFromTx, ingestCoin, pruneTrades, score, findBoard,
};
