// Dip-buying mean reversion on CBBTC/USDC, long only.
//
// On each bar's close: keep EMA(20) of closes. With no position, buy a modest slice of equity when
// the close sits more than 0.3% under the EMA (filled at the next bar's open). Holding, sell the whole
// position once the close is 0.6% over the entry cost (take profit) or 0.6% under it (stop).
// Deterministic: float64 EMA on + - * / only, bigint money, no clock, randomness or env.

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const EMA_BARS = 20;
const DIP_BPS = 30;
const TP_BPS = 60n;
const SL_BPS = 60n;
/** 40% of equity per entry: keeps drawdown small while clearing the ~26 bps round-trip cost. */
const STAKE_BPS = 4_000n;
const MAX_SLIPPAGE_BPS = 100;

let ema: number | null = null;
let seen = 0;

await runBars({
  onBatch(state, batch) {
    const { caps, fees } = state.hello;
    const orders: (SellInput | BuyInput)[] = [];
    for (const bar of batch.bars) {
      const close = Number(bar.c);
      ema = ema === null ? close : ema + (2 / (EMA_BARS + 1)) * (close - ema);
      seen++;
      const held = state.positions.get(bar.symbol);
      if (held !== undefined) {
        const value = state.value(bar.symbol, held.qty);
        const tp = value * BPS >= held.cost * (BPS + TP_BPS);
        const sl = value * BPS <= held.cost * (BPS - SL_BPS);
        if (tp || sl) orders.push({ side: 'sell', symbol: bar.symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        continue;
      }
      if (seen < EMA_BARS) continue;
      if (close >= ema * (1 - DIP_BPS / 10_000)) continue;
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      let slice = (state.equity * STAKE_BPS) / BPS;
      if (slice > byWeight) slice = byWeight;
      if (slice > state.cash) slice = state.cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
      if (orders.length >= caps.max_orders_per_bar) break;
      orders.push({ side: 'buy', symbol: bar.symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    return orders;
  },
});
