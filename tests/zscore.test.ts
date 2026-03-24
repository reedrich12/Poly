import { describe, it, expect, vi } from 'vitest';
import { VolatilityEngine, MIN_DATA_POINTS, ROLLING_WINDOW_SIZE, Z_SCORE_THRESHOLD } from '../engine.ts';

describe('VolatilityEngine Z-Score Math', () => {
  it('stdDev=0 returns no spike', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    engine.priceHistory.set('asset1', Array(MIN_DATA_POINTS).fill(50));
    
    const onSpike = vi.fn();
    engine.onSpike = onSpike;
    
    engine.analyzeTrade('asset1', 50);
    expect(onSpike).not.toHaveBeenCalled();
  });

  it('Exactly MIN_DATA_POINTS entries works', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    // 10 entries of 50
    engine.priceHistory.set('asset1', Array(MIN_DATA_POINTS).fill(50));
    
    const onSpike = vi.fn();
    engine.onSpike = onSpike;
    
    // stdDev is 0, so no spike
    engine.analyzeTrade('asset1', 50);
    expect(onSpike).not.toHaveBeenCalled();
  });

  it('Price 3.1 std devs away triggers spike', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    
    // Mean = 50, stdDev = 1. Let's create an array with mean 50 and stdDev 1.
    // [49, 51, 49, 51, 49, 51, 49, 51, 49, 51]
    engine.priceHistory.set('asset1', [49, 51, 49, 51, 49, 51, 49, 51, 49, 51]);
    
    const onSpike = vi.fn();
    engine.onSpike = onSpike;
    
    // 50 + 3.1 * 1 = 53.1
    engine.analyzeTrade('asset1', 53.1);
    expect(onSpike).toHaveBeenCalled();
  });

  it('Price 2.9 std devs away does NOT trigger', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    
    engine.priceHistory.set('asset1', [49, 51, 49, 51, 49, 51, 49, 51, 49, 51]);
    
    const onSpike = vi.fn();
    engine.onSpike = onSpike;
    
    // 50 + 2.9 * 1 = 52.9
    engine.analyzeTrade('asset1', 52.9);
    expect(onSpike).not.toHaveBeenCalled();
  });

  it('Rolling window evicts oldest at ROLLING_WINDOW_SIZE+1', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    
    const history = Array(ROLLING_WINDOW_SIZE).fill(50);
    engine.priceHistory.set('asset1', history);
    
    engine.analyzeTrade('asset1', 50);
    expect(engine.priceHistory.get('asset1')?.length).toBe(ROLLING_WINDOW_SIZE);
  });

  it('NaN price is rejected', () => {
    const engine = new VolatilityEngine();
    engine.marketMap.set('asset1', 'Market 1');
    engine.priceHistory.set('asset1', [50]);
    
    engine.analyzeTrade('asset1', NaN);
    expect(engine.priceHistory.get('asset1')?.length).toBe(1);
  });
});
