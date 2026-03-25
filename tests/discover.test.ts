import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VolatilityEngine, TARGET_SLUGS } from '../engine.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal GammaEvent response page */
function makePage(
  events: Array<{ title: string; assetId: string; groupItemTitle?: string }>,
  limit = 100
) {
  return events.map(e => ({
    title: e.title,
    markets: [
      {
        groupItemTitle: e.groupItemTitle ?? 'Yes',
        clobTokenIds: JSON.stringify([e.assetId]),
      },
    ],
  }));
}

/** Create a mock fetch that returns JSON for successive calls in order */
function mockFetch(...pages: object[]) {
  let call = 0;
  return vi.fn().mockImplementation(async () => {
    const body = pages[call] ?? [];
    call++;
    return {
      ok: true,
      json: async () => body,
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('discoverMarkets()', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('populates marketMap, deltaHistory, and returns assetIds for a single page', async () => {
    const page = makePage([
      { title: 'Iran Election', assetId: 'asset_iran_001' },
      { title: 'Iran Sanctions', assetId: 'asset_iran_002' },
    ]);

    // Return our page for the first slug, empty arrays for the rest
    (global as any).fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('tag_slug=iran') && url.includes('offset=0')) {
        return { ok: true, json: async () => page };
      }
      return { ok: true, json: async () => [] };
    });

    const engine = new VolatilityEngine();
    const assetIds = await engine.discoverMarkets();

    expect(assetIds).toContain('asset_iran_001');
    expect(assetIds).toContain('asset_iran_002');
    expect(engine.marketMap.get('asset_iran_001')).toBe('Iran Election - Yes');
    expect(engine.marketMap.get('asset_iran_002')).toBe('Iran Sanctions - Yes');
    expect(engine.deltaHistory.get('asset_iran_001')).toEqual([]);
    expect(engine.deltaHistory.get('asset_iran_002')).toEqual([]);
  });

  it('deduplicates assetIds that appear in multiple slugs', async () => {
    const sharedAssetId = 'shared_asset_999';

    (global as any).fetch = vi.fn().mockImplementation(async (url: string) => {
      // Return the same assetId from two different slugs
      if (url.includes('tag_slug=iran') || url.includes('tag_slug=geopolitics')) {
        if (url.includes('offset=0')) {
          return {
            ok: true,
            json: async () => makePage([{ title: 'Shared Market', assetId: sharedAssetId }]),
          };
        }
      }
      return { ok: true, json: async () => [] };
    });

    const engine = new VolatilityEngine();
    const assetIds = await engine.discoverMarkets();

    const count = assetIds.filter(id => id === sharedAssetId).length;
    expect(count).toBe(1);
    expect(engine.marketMap.size).toBe(1);
  });

  it('paginates — fetches second page when first page is full (length === limit)', async () => {
    // First page: 100 events (full page) → triggers second request
    const fullPage = makePage(
      Array.from({ length: 100 }, (_, i) => ({ title: `Market ${i}`, assetId: `asset_${i}` }))
    );
    // Second page: 1 event (partial) → stops pagination
    const partialPage = makePage([{ title: 'Last Market', assetId: 'asset_last' }]);

    (global as any).fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('tag_slug=iran')) {
        if (url.includes('offset=0')) {
          return { ok: true, json: async () => fullPage };
        }
        if (url.includes('offset=100')) {
          return { ok: true, json: async () => partialPage };
        }
      }
      return { ok: true, json: async () => [] };
    });

    const engine = new VolatilityEngine();
    const assetIds = await engine.discoverMarkets();

    expect(assetIds).toContain('asset_0');
    expect(assetIds).toContain('asset_99');
    expect(assetIds).toContain('asset_last');
  });

  it('handles HTTP error gracefully — continues with other slugs', async () => {
    (global as any).fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('tag_slug=iran')) {
        return { ok: false, status: 503 };
      }
      if (url.includes('tag_slug=geopolitics') && url.includes('offset=0')) {
        return {
          ok: true,
          json: async () => makePage([{ title: 'Geo Market', assetId: 'asset_geo' }]),
        };
      }
      return { ok: true, json: async () => [] };
    });

    const engine = new VolatilityEngine();
    const assetIds = await engine.discoverMarkets();

    // iran slug failed — geopolitics should still succeed
    expect(assetIds).toContain('asset_geo');
  });

  it('skips markets with malformed clobTokenIds JSON', async () => {
    (global as any).fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('tag_slug=iran') && url.includes('offset=0')) {
        return {
          ok: true,
          json: async () => [
            {
              title: 'Bad Market',
              markets: [{ groupItemTitle: 'Yes', clobTokenIds: 'NOT_VALID_JSON' }],
            },
            {
              title: 'Good Market',
              markets: [{ groupItemTitle: 'Yes', clobTokenIds: '["valid_asset_1"]' }],
            },
          ],
        };
      }
      return { ok: true, json: async () => [] };
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const engine = new VolatilityEngine();
    const assetIds = await engine.discoverMarkets();

    expect(assetIds).toContain('valid_asset_1');
    expect(assetIds).not.toContain('NOT_VALID_JSON');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse clobTokenIds'),
      expect.any(String)
    );
  });

  it('returns empty array when all slugs return no events', async () => {
    (global as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const engine = new VolatilityEngine();
    const assetIds = await engine.discoverMarkets();
    expect(assetIds).toHaveLength(0);
  });

  it('runs all slugs concurrently — fetch called once per slug for single-page responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    (global as any).fetch = fetchMock;

    const engine = new VolatilityEngine();
    await engine.discoverMarkets();

    // Each slug makes at least 1 fetch call
    const urls: string[] = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    for (const slug of TARGET_SLUGS) {
      expect(urls.some((u: string) => u.includes(`tag_slug=${slug}`))).toBe(true);
    }
  });
});
