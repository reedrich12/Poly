import { describe, it, expect, vi } from 'vitest';
import { VolatilityEngine, MIN_DATA_POINTS, ROLLING_WINDOW_SIZE, Z_SCORE_THRESHOLD } from '../engine.ts';

// Helper: alternating +delta/-delta sequence gives mean=0, population stdDev=delta
// e.g. alternating(0.010, 10) => [-0.010, +0.010, -0.010, +0.010, ...]
function alternating(delta: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? -delta : +delta));
}

describe('VolatilityEngine Z-Score Math', () => {

  // ────────────────────────────────────────────────────
  // (a) stdDev=0 → no spike
  // ────────────────────────────────────────────────────
  it('stdDev=0 returns no spike', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    // All deltas zero → stdDev = 0 → guard suppresses spike
    engine.deltaHistory.set('asset1', Array(MIN_DATA_POINTS).fill(0));
    engine.lastPrice.set('asset1', 0.500);

    const onSpike = vi.fn();
    engine.onSpike = onSpike;

    engine.analyzeTrade('asset1', 0.500);
    expect(onSpike).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────
  // (b) First trade establishes lastPrice but cannot spike
  // ────────────────────────────────────────────────────
  it('first trade primes lastPrice but cannot spike', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    engine.deltaHistory.set('asset1', []);
    // No lastPrice set — first call exits before computing delta

    const onSpike = vi.fn();
    engine.onSpike = onSpike;

    engine.analyzeTrade('asset1', 0.500);
    expect(onSpike).not.toHaveBeenCalled();
    expect(engine.lastPrice.get('asset1')).toBe(0.500);
    expect(engine.deltaHistory.get('asset1')?.length).toBe(0);
  });

  // ────────────────────────────────────────────────────
  // (c) Z = 2.9 → no spike
  // Setup: deltaHistory = alternating(0.010, 10)
  //   mean = 0, popStdDev = 0.010
  //   analyzeTrade(0.529) → delta = 0.029, z = 2.9
  // ────────────────────────────────────────────────────
  it('Price 2.9 std devs away does NOT trigger', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    engine.deltaHistory.set('asset1', alternating(0.010, MIN_DATA_POINTS));
    engine.lastPrice.set('asset1', 0.500);

    const onSpike = vi.fn();
    engine.onSpike = onSpike;

    engine.analyzeTrade('asset1', 0.529); // delta = 0.029, z = 2.9
    expect(onSpike).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────
  // (d) Z = 3.1 → spike fires
  // analyzeTrade(0.531) → delta = 0.031, z = 3.1
  // ────────────────────────────────────────────────────
  it('Price 3.1 std devs away triggers spike', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    engine.deltaHistory.set('asset1', alternating(0.010, MIN_DATA_POINTS));
    engine.lastPrice.set('asset1', 0.500);

    const onSpike = vi.fn();
    engine.onSpike = onSpike;

    engine.analyzeTrade('asset1', 0.531); // delta = 0.031, z = 3.1
    expect(onSpike).toHaveBeenCalledOnce();
  });

  // ────────────────────────────────────────────────────
  // Z = exactly 3.0 → spike fires (>= not >)
  // analyzeTrade(0.530) → delta = 0.030, z = 3.0
  // ────────────────────────────────────────────────────
  it('Z = exactly 3.0 triggers spike (inclusive threshold)', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    engine.deltaHistory.set('asset1', alternating(0.010, MIN_DATA_POINTS));
    engine.lastPrice.set('asset1', 0.500);

    const onSpike = vi.fn();
    engine.onSpike = onSpike;

    engine.analyzeTrade('asset1', 0.530); // delta = 0.030, z = 3.0
    expect(onSpike).toHaveBeenCalledOnce();
  });

  // ────────────────────────────────────────────────────
  // Negative spike: z = -3.1 → also fires (Math.abs)
  // analyzeTrade(0.469) → delta = -0.031, z = -3.1
  // ────────────────────────────────────────────────────
  it('Negative spike (z = -3.1) also triggers', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    engine.deltaHistory.set('asset1', alternating(0.010, MIN_DATA_POINTS));
    engine.lastPrice.set('asset1', 0.500);

    const onSpike = vi.fn();
    engine.onSpike = onSpike;

    engine.analyzeTrade('asset1', 0.469); // delta = -0.031, z = -3.1
    expect(onSpike).toHaveBeenCalledOnce();
  });

  // ────────────────────────────────────────────────────
  // (e) NaN price rejected — state NOT mutated
  // ────────────────────────────────────────────────────
  it('NaN price is rejected and does NOT mutate lastPrice', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    engine.deltaHistory.set('asset1', []);
    engine.lastPrice.set('asset1', 0.500);

    engine.analyzeTrade('asset1', NaN);

    expect(engine.lastPrice.get('asset1')).toBe(0.500);
    expect(engine.deltaHistory.get('asset1')?.length).toBe(0);
  });

  // ────────────────────────────────────────────────────
  // (f) Price outside [0,1] rejected — state NOT mutated
  // ────────────────────────────────────────────────────
  it('Price > 1 is rejected and does NOT mutate lastPrice', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    engine.deltaHistory.set('asset1', []);
    engine.lastPrice.set('asset1', 0.500);

    engine.analyzeTrade('asset1', 1.001);

    expect(engine.lastPrice.get('asset1')).toBe(0.500);
    expect(engine.deltaHistory.get('asset1')?.length).toBe(0);
  });

  it('Price < 0 is rejected and does NOT mutate lastPrice', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    engine.deltaHistory.set('asset1', []);
    engine.lastPrice.set('asset1', 0.500);

    engine.analyzeTrade('asset1', -0.001);

    expect(engine.lastPrice.get('asset1')).toBe(0.500);
    expect(engine.deltaHistory.get('asset1')?.length).toBe(0);
  });

  // ────────────────────────────────────────────────────
  // (g) Unknown assetId → ignored, no state mutation
  // ────────────────────────────────────────────────────
  it('Unknown assetId is ignored without state mutation', () => {
    const engine = new VolatilityEngine();
    // asset1 NOT in marketMap

    const onSpike = vi.fn();
    engine.onSpike = onSpike;

    engine.analyzeTrade('unknown_asset', 0.500);

    expect(onSpike).not.toHaveBeenCalled();
    expect(engine.lastPrice.has('unknown_asset')).toBe(false);
    expect(engine.deltaHistory.has('unknown_asset')).toBe(false);
  });

  // ────────────────────────────────────────────────────
  // (h) Rolling window evicts oldest delta at ROLLING_WINDOW_SIZE+1
  //     Checks deltaHistory length, not priceHistory
  // ────────────────────────────────────────────────────
  it('Rolling window evicts oldest delta at ROLLING_WINDOW_SIZE+1', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');

    // Fill deltaHistory to exactly ROLLING_WINDOW_SIZE
    const history = alternating(0.001, ROLLING_WINDOW_SIZE);
    engine.deltaHistory.set('asset1', [...history]);
    engine.lastPrice.set('asset1', 0.500);

    // One more trade should push+shift → still ROLLING_WINDOW_SIZE
    engine.analyzeTrade('asset1', 0.501);
    const deltas = engine.deltaHistory.get('asset1')!;
    expect(deltas.length).toBe(ROLLING_WINDOW_SIZE);
    // Oldest delta (history[0]) should be gone; new delta (0.001) should be last
    expect(deltas[0]).not.toBe(history[0]);
    expect(deltas[deltas.length - 1]).toBeCloseTo(0.001, 8);
  });

  // ────────────────────────────────────────────────────
  // Exactly MIN_DATA_POINTS deltas in buffer → spike evaluation fires
  // (boundary: deltas.length >= MIN_DATA_POINTS before push)
  // ────────────────────────────────────────────────────
  it('Exactly MIN_DATA_POINTS entries in deltaHistory allows spike evaluation', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    engine.deltaHistory.set('asset1', alternating(0.010, MIN_DATA_POINTS));
    engine.lastPrice.set('asset1', 0.500);

    const onSpike = vi.fn();
    engine.onSpike = onSpike;

    // z = 3.1 — should fire even at exactly MIN_DATA_POINTS boundary
    engine.analyzeTrade('asset1', 0.531);
    expect(onSpike).toHaveBeenCalledOnce();
  });
});
