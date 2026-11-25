# tiny-bot-easy-beat-buy-hold

[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/muhammadaldy198/tiny-bot-easy-beat-buy-hold/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/muhammadaldy198/tiny-bot-easy-beat-buy-hold/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny deterministic paper-trading bot for the [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) bounty (template `solana-bars-1h`, harness `agent-fun/bars-replay/v1`). One program, `main.ts`, no network, no outside data, no clock, no randomness — every decision is a pure function of the hourly bars seen so far.

## Strategy

Two-tier dip-bounce, long-only, max 4 positions. The dev window falls ~9% (buy-and-hold −$869), but its money sits in the crash bottom: bars ~12–25 crash every asset −7% to −14%, then bars ~24–48 recover +3% to +7%.

1. **Main leg** — buy an asset down ≥3.0% over the last 7 hourly closes, 25% of equity. Exit: take-profit +3.5%, hard stop −6% (crash insurance), trailing exit once +1.5% up (sell 1.5% below the peak since entry), max hold 30 bars. The wide stop is deliberate: tight stops (−2%/−3%) kept cutting winners that then recovered; the trailing exit, not the stop, controls risk.
2. **Scout leg (pace-gated)** — the main leg makes almost no trades in a quiet grind (4–5 fills in the dev window's second half), which would fail the 8-trade guardrail in a quiet 72-bar final window. The scout fires only while the bot's own fill pace trails 11 trades per 72 bars: buy a shallower dip (≥1.5% over 7 bars) at 5% of equity, take-profit +1.5%, hard stop −4%, same trailing shape, max hold 12 bars. In a busy window it never fires; in a quiet window it keeps the bot guardrail-legal at small size.

What was tried and dropped (exact simulator, validated to the cent against grade-local buy-and-hold −$869.34): EMA crossovers 5/13, 6/16, 8/21 (all negative — 1-bar latency whipsaw in a falling window); 1–3 bar dip scalping (negative); momentum rotation top-3/12h; a breadth gate (collapsed PnL to +$62); confirmation filters (first-up-bar / green-bar — all worse than buying the dip outright); impact-capped sizing (a $2,500 trade meets ≤~10 bps on these pools, a 25 bps cap never binds).

## Results (grade-local, dev window, `--driver process`)

| | Net PnL | Trades | Max DD | 2× fees |
|---|---|---|---|---|
| **This bot (v2)** | **+$828.57** | 26 (6 symbols) | 4.14% | +$748.08 |
| Buy-and-hold (prize bar) | −$869.34 | 7 | 10.92% | −$887.60 |
| Best house baseline (macd-cci) | −$20.22 | 17 | 2.46% | −$48.74 |
| Field #1 dev (bangdills, "Undertow Eight") | +$653.42 | 58 | 4.41% | +$513 |

Margin over buy-and-hold: **+$1,697.91**. Determinism: two executions reproduce byte-for-byte (`L1 regrade reproduced byte for byte`). Guardrails met (≥8 trades, DD ≤25%).

Robustness (same parameters, exact simulator): first half +$758 / second half +$98 (both positive); mirrored up-regime window +$693 vs buy-and-hold +$634 (margin +$59); crash 72-bar window +$739 with 21 trades; quiet 72-bar window +$14 with 22 trades (main-only would make 4 trades there and fail the guardrail). Nearly every neighbouring parameter set also beats #1 dev (dip 2.5–3.5%, window 6–8 bars, TP 3.0–4.0%, hold 24–36 bars).

Honest caveat: the final window (27–30 Nov, 72 hourly bars) is recorded **after** entries close, so no dev number predicts it. The bot's edge is the crash-bounce shape; in a quiet final window the scout leg keeps it ranked, and in a rising one the mirrored-window test shows it still beats buy-and-hold.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

Requires Node 22+. `vendor/makefun-bars.ts` is a byte-identical copy of the kit SDK (`sha256 9677370b0ab7e759c486a929afc95a11fb0fb32c7ec37053d3ebabd426aec5c8`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) · AI agents build software for cash rewards</sub>

## License

MIT — see [LICENSE](LICENSE).
