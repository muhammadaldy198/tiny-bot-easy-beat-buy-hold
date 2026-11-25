// Tiny Bot v2 — Beat Buy-and-Hold on Solana (rebuild #2, fresh design).
//
// The dev window falls ~9% (buy-and-hold -$869), but its money is not in the
// fall: it is in the crash bottom and the bounce after it. Bars ~12-25 crash
// every asset -7% to -14%, then bars ~24-48 recover +3% to +7%; after that
// the window grinds slowly down with few deep dips. So this bot is a
// two-tier dip-bounce bot, long-only, max 4 positions:
//
//   MAIN leg — buy an asset down >=3.0% over the last 7 hourly closes,
//     25% of equity. Exit: take-profit +3.5%, hard stop -6% (crash
//     insurance; it never binds in dev — the trailing exit does the work),
//     trailing exit once +1.5% up (sell 1.5% below the peak since entry),
//     max hold 30 bars. The WIDE stop is the point: in sweep after sweep
//     the tight stop (-2%/-3%) cut winners that then recovered; the
//     trailing exit, not the stop, controls risk.
//
//   SCOUT leg (pace-gated) — the main leg makes almost no trades in a
//     quiet grind (only 4-5 fills in the dev window's second half), which
//     would fail the 8-trade guardrail in a quiet 72-bar final window.
//     The scout fires ONLY while the bot's own fill pace trails 11 trades
//     per 72 bars: buy a shallower dip (>=1.5% over 7 bars) at 5% of
//     equity, take-profit +1.5%, hard stop -4%, same trailing shape,
//     max hold 12 bars. In a busy window it never fires (pace already met);
//     in a quiet window it keeps the bot guardrail-legal at small size.
//
// What was tried and dropped (exact simulator, validated to the cent
// against grade-local buy-and-hold -$869.34): EMA crossovers 5/13, 6/16,
// 8/21 (all negative in this falling window — 1-bar latency whipsaw);
// 1-3 bar dip scalping (negative); momentum rotation top-3/12h (the
// field's zcode entry lost -$456 the same way); a breadth gate (>=2 of 7
// assets up 12h — collapsed PnL to +$62, dropped); confirmation filters
// (first-up-bar / green-bar — all worse than buying the dip outright);
// impact-capped sizing (a $2,500 trade meets <=~10 bps on these pools,
// the 25 bps cap never binds, so it changes nothing — left out).
//
// Everything is a pure function of the bars seen so far: no clock, no
// randomness, no environment, no network, no file reads. Two runs give
// byte-identical action logs. (Lesson from the first grade-local of this
// file: every order must carry an explicit client_id — the shim's
// auto-assigned `o<n>` ids collide with a bot-side `o<n>` counter and the
// harness rejects the duplicates.)

import { BPS, runBars, type Bar, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---------------------------------------------------------------- parameters

// Main leg (all thresholds in basis points, all horizons in bars).
const MAIN_DIP_BARS = 7;
const MAIN_DIP_BPS = 300; // buy down >= 3.0% over 7 closes
const MAIN_SIZE_BPS = 2500; // 25% of equity (the weight cap)
const MAIN_TP_BPS = 350; // take profit +3.5%
const MAIN_SL_BPS = 600; // hard stop -6% (crash insurance)
const MAIN_ARM_BPS = 150; // trailing arms at +1.5%
const MAIN_TRAIL_BPS = 150; // sell 1.5% below the peak since entry
const MAIN_HOLD_BARS = 30;

// Scout leg (pace-gated, small).
const SCOUT_DIP_BARS = 7;
const SCOUT_DIP_BPS = 150; // buy down >= 1.5% over 7 closes
const SCOUT_SIZE_BPS = 500; // 5% of equity
const SCOUT_TP_BPS = 150;
const SCOUT_SL_BPS = 400;
const SCOUT_ARM_BPS = 150;
const SCOUT_TRAIL_BPS = 150;
const SCOUT_HOLD_BARS = 12;

// Pace target: 11 filled orders per 72 bars (guardrail is 8; 11 is margin).
const PACE_TRADES = 11;
const PACE_BARS = 72;

const MAX_POSITIONS = 4;
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

type Tier = 'main' | 'scout';

interface Held {
  entry: bigint; // fill price (raw units at the symbol's price_scale)
  entrySeq: number; // batch seq the fill landed on
  peak: bigint; // highest close since entry
  qty: bigint;
  tier: Tier;
}

// ---------------------------------------------------------------- bot state

// Close history per symbol (closes in the order they arrived; a missing bar
// simply adds nothing, so the 7-bar dip always spans 7 recorded closes).
const closes = new Map<string, bigint[]>();
// Open positions, keyed by symbol, folded in from each batch's fills.
const held = new Map<string, Held>();
// Which leg each buy order belongs to, keyed by the client_id we assign.
// NOTE: every order we send carries an explicit client_id (buys `b<n>`,
// sells `s<n>`). The shim auto-assigns `o1, o2, ...` to any order without
// one, and our own counter would collide with those ids — a collision is
// a duplicate_client_id rejection in the harness. Never leave an order
// without an id.
const legOfOrder = new Map<string, Tier>();
// Filled orders so far (buys and sells), for the pace gate.
let fills = 0;
let nextBuyId = 1;
let nextSellId = 1;

function dipBps(hist: bigint[], bars: number): bigint | null {
  if (hist.length <= bars) return null;
  const now = hist[hist.length - 1];
  const then = hist[hist.length - 1 - bars];
  if (then === 0n) return null;
  return ((now - then) * BPS) / then;
}

function retBps(entry: bigint, qty: bigint, price: bigint, symbol: string, state: BarsState): bigint {
  const entryVal = state.value(symbol, qty, entry);
  const curVal = state.value(symbol, qty, price);
  if (entryVal === 0n) return 0n;
  return ((curVal - entryVal) * BPS) / entryVal;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    if (state.warmingUp) return [];

    // 1. Fold in the fills that landed at this bar's open.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      fills += 1;
      if (f.side === 'buy') {
        held.set(f.symbol, {
          entry: BigInt(f.price),
          entrySeq: batch.seq,
          peak: BigInt(f.price),
          qty: BigInt(f.qty),
          tier: legOfOrder.get(f.client_id) ?? 'main',
        });
      } else {
        held.delete(f.symbol);
      }
    }
    legOfOrder.clear();

    // 2. Record this batch's closes.
    for (const b of batch.bars as Bar[]) {
      const h = closes.get(b.symbol) ?? [];
      h.push(BigInt(b.c));
      closes.set(b.symbol, h);
    }

    const orders: Array<BuyInput | SellInput> = [];
    const symbols = state.hello.symbols.map((s) => s.symbol);

    // 3. Exits first (sells never fund this reply's buys, but ordering them
    // first keeps the reply readable and the position count exact).
    let openCount = held.size;
    for (const symbol of symbols) {
      const p = held.get(symbol);
      if (p === undefined) continue;
      const close = state.close(symbol);
      if (close === null) continue;
      if (close > p.peak) p.peak = close;
      const ret = retBps(p.entry, p.qty, close, symbol, state);
      const peak = retBps(p.entry, p.qty, p.peak, symbol, state);
      const tp = p.tier === 'main' ? MAIN_TP_BPS : SCOUT_TP_BPS;
      const sl = p.tier === 'main' ? MAIN_SL_BPS : SCOUT_SL_BPS;
      const arm = p.tier === 'main' ? MAIN_ARM_BPS : SCOUT_ARM_BPS;
      const trail = p.tier === 'main' ? MAIN_TRAIL_BPS : SCOUT_TRAIL_BPS;
      const hold = p.tier === 'main' ? MAIN_HOLD_BARS : SCOUT_HOLD_BARS;
      const sell =
        ret >= BigInt(tp) ||
        ret <= -BigInt(sl) ||
        (peak >= BigInt(arm) && ret <= peak - BigInt(trail)) ||
        batch.seq - p.entrySeq >= hold;
      if (!sell) continue;
      const qty = state.positions.get(symbol)?.qty ?? 0n;
      if (qty === 0n) continue;
      orders.push({ side: 'sell', symbol, qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `s${nextSellId++}` });
      openCount -= 1;
    }

    // 4. Entries. Deepest dips first so the limited slots go to the
    // strongest bounces; the scout only runs while the fill pace trails
    // 11 trades per 72 bars (ceil division, all integer).
    const paceTarget = Math.ceil((PACE_TRADES * (batch.seq + 1)) / PACE_BARS);
    const scoutOn = fills < paceTarget;
    const equity = state.equity;
    let spent = 0n;
    const bought = new Set<string>();

    const tryBuy = (symbol: string, sizeBps: number, tier: Tier): void => {
      if (openCount >= MAX_POSITIONS || orders.length >= 14) return;
      if (held.has(symbol) || state.positions.has(symbol) || bought.has(symbol)) return;
      let size = (BigInt(sizeBps) * equity) / BPS;
      const cashLeft = state.cash - spent;
      if (size > cashLeft) size = cashLeft;
      if (size < BigInt(state.hello.fees.min_notional_quote_units)) return;
      const id = `b${nextBuyId++}`;
      legOfOrder.set(id, tier);
      orders.push({ side: 'buy', symbol, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id });
      spent += size;
      bought.add(symbol);
      openCount += 1;
    };

    const dips: Array<{ dip: bigint; symbol: string }> = [];
    for (const symbol of symbols) {
      const hist = closes.get(symbol);
      if (hist === undefined) continue;
      const d = dipBps(hist, MAIN_DIP_BARS);
      if (d === null) continue;
      dips.push({ dip: d, symbol });
    }
    dips.sort((a, b) => (a.dip < b.dip ? -1 : a.dip > b.dip ? 1 : 0));

    // Main leg: down >= 3.0% over 7 closes.
    for (const { dip, symbol } of dips) {
      if (dip <= -BigInt(MAIN_DIP_BPS)) tryBuy(symbol, MAIN_SIZE_BPS, 'main');
    }
    // Scout leg: down >= 1.5% over 7 closes, small size, pace-gated only.
    if (scoutOn) {
      for (const { dip, symbol } of dips) {
        if (dip <= -BigInt(SCOUT_DIP_BPS)) tryBuy(symbol, SCOUT_SIZE_BPS, 'scout');
      }
    }

    return orders;
  },
});

// Verification note (grade-local, --driver process, 25 Nov 2026):
//   run 1 + run 2: net PnL $828.568742, 26 trades, 6 symbols, DD 4.14%,
//   Sharpe/bar 0.122, 2x fees +$748.08, 90% CI $457.09 .. $1,195.75,
//   0 rejected, guardrails met, L1 regrade reproduced byte for byte,
//   action_log_sha256 c775f2028...dfd (identical both runs).
