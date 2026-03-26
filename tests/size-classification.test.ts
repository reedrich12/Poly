import { describe, it, expect, vi } from 'vitest';
import {
  VolatilityEngine,
  MIN_DATA_POINTS,
  classifySignal,
  TradeContext,
} from '../engine.ts';

// Helper: alternating +delta/-delta sequence gives mean=0, population stdDev=delta
function alternating(delta: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? -delta : +delta));
}

// Build a TradeContext for testing
function makeTrade(notionalUsdc: number): TradeContext {
  return {
    side: 'BUY',
    sizeShares: notionalUsdc / 0.50, // price=0.50, so shares = notional / price
    notionalUsdc,
    timestampMs: Date.now(),
  };
}

describe('classifySignal — tier stays Z-score-only (size does NOT affect tier)', () => {
  it('Z=3.5, mid-range price → SIGNAL regardless of trade size', () => {
    // Tier is purely Z-score. No size-based promotion in classifySignal.
    expect(classifySignal(0.50, 3.5)).toBe('SIGNAL');
  });

  it('Z=5.0, mid-range price → STRONG regardless of trade size', () => {
    expect(classifySignal(0.50, 5.0)).toBe('STRONG');
  });

  it('Z=5.0, near-resolution price → NOISE', () => {
    expect(classifySignal(0.03, 5.0)).toBe('NOISE');
  });
});

describe('tradeSizeBucket — correct bucket assigned in spike', () => {
  // Set up engine with asset primed for a spike (Z ≈ 3.1 with std=0.010)
  function makeEngine(tagSlug = 'indices') {
    const eng = new VolatilityEngine();
    eng.marketMap.set('asset1', 'Test Market');
    eng.assetMeta.set('asset1', { marketName: 'Test Market', tagSlug });
    eng.deltaHistory.set('asset1', alternating(0.010, MIN_DATA_POINTS));
    eng.notionalHistory.set('asset1', []);
    eng.lastPrice.set('asset1', 0.500);
    return eng;
  }

  it('$50 notional → normal bucket (below large=$250 for indices)', () => {
    const eng = makeEngine();
    const onSpike = vi.fn();
    eng.onSpike = onSpike;
    eng.analyzeTrade('asset1', 0.531, makeTrade(50));
    expect(onSpike).toHaveBeenCalledOnce();
    const spike = onSpike.mock.calls[0][0];
    expect(spike.tradeSizeBucket).toBe('normal');
  });

  it('$300 notional → large bucket (≥$250 for indices)', () => {
    const eng = makeEngine();
    const onSpike = vi.fn();
    eng.onSpike = onSpike;
    eng.analyzeTrade('asset1', 0.531, makeTrade(300));
    const spike = onSpike.mock.calls[0][0];
    expect(spike.tradeSizeBucket).toBe('large');
  });

  it('$2000 notional → whale bucket (≥$1000 for indices)', () => {
    const eng = makeEngine();
    const onSpike = vi.fn();
    eng.onSpike = onSpike;
    eng.analyzeTrade('asset1', 0.531, makeTrade(2000));
    const spike = onSpike.mock.calls[0][0];
    expect(spike.tradeSizeBucket).toBe('whale');
  });

  it('$10000 notional → mega bucket (≥$5000 for indices)', () => {
    const eng = makeEngine();
    const onSpike = vi.fn();
    eng.onSpike = onSpike;
    eng.analyzeTrade('asset1', 0.531, makeTrade(10000));
    const spike = onSpike.mock.calls[0][0];
    expect(spike.tradeSizeBucket).toBe('mega');
  });

  it('priorityScore > |zScore| when trade is whale-sized', () => {
    const eng = makeEngine();
    const onSpike = vi.fn();
    eng.onSpike = onSpike;
    eng.analyzeTrade('asset1', 0.531, makeTrade(2000)); // whale
    const spike = onSpike.mock.calls[0][0];
    // priorityScore = |Z| * (1 + 0.5) for whale
    expect(spike.priorityScore).toBeGreaterThan(Math.abs(spike.zScore));
  });

  it('no trade context → tradeSizeBucket is null, spike still fires', () => {
    const eng = makeEngine();
    const onSpike = vi.fn();
    eng.onSpike = onSpike;
    // 2-arg call (backward compat — existing test style)
    eng.analyzeTrade('asset1', 0.531);
    expect(onSpike).toHaveBeenCalledOnce();
    const spike = onSpike.mock.calls[0][0];
    expect(spike.tradeSizeBucket).toBeNull();
    expect(spike.tradeNotionalUsdc).toBeNull();
    expect(spike.side).toBeNull();
  });
});
