import WebSocket from "ws";

// ── Polymarket API type definitions ──────────────────────────────────────────

/** Single market inside a Gamma API event object */
interface GammaMarket {
  groupItemTitle?: string;
  clobTokenIds?: string; // JSON-encoded string array, e.g. '["123456"]'
}

/** Event object returned by https://gamma-api.polymarket.com/events */
interface GammaEvent {
  title: string;
  markets?: GammaMarket[];
}

/** Live trade message from the CLOB WebSocket (event_type: last_trade_price) */
interface ClobTradeMessage {
  asset_id: string;
  event_type: string;
  price: string;   // NOTE: string, not number — must parseFloat before use
  side: 'BUY' | 'SELL';
  size: string;    // trade size in shares/contracts; compute USDC notional as size * price
  timestamp: string;
  fee_rate_bps: string;
  market: string;
}

/**
 * Normalized trade context passed into analyzeTrade().
 * Optional — callers that don't pass it (tests, legacy) get size-unaware behavior.
 */
export interface TradeContext {
  side: 'BUY' | 'SELL';
  sizeShares: number;
  notionalUsdc: number;
  timestampMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────

export const TARGET_SLUGS = [
  "iran",
  "geopolitics",
  "indices",
  "commodities",
  "forex",
  "fed-rates",
  "treasuries",
];
export const ROLLING_WINDOW_SIZE = 100;
export const Z_SCORE_THRESHOLD = 3.0;
export const MIN_DATA_POINTS = 10;

// ── 3-Tier Signal Classification ──────────────────────────────────────────────
// Tier 1 — NOISE:   near-resolution markets (price < 0.05 or > 0.95) where
//                   tiny absolute moves produce huge Z-scores by math artifact.
// Tier 2 — SIGNAL:  mid-range markets (0.05–0.95) with |Z| in [3.0, 4.5).
//                   Genuine unusual activity worth watching.
// Tier 3 — STRONG:  mid-range markets with |Z| ≥ 4.5.
//                   High-confidence anomaly — statistically rare.
export const NEAR_RESOLUTION_LOW  = 0.05;
export const NEAR_RESOLUTION_HIGH = 0.95;
export const STRONG_SIGNAL_THRESHOLD = 4.5;

export type SignalTier = 'NOISE' | 'SIGNAL' | 'STRONG';

/** Tier is driven by Z-score only. Size context is surfaced separately. */
export function classifySignal(price: number, zScore: number): SignalTier {
  if (price < NEAR_RESOLUTION_LOW || price > NEAR_RESOLUTION_HIGH) return 'NOISE';
  return Math.abs(zScore) >= STRONG_SIGNAL_THRESHOLD ? 'STRONG' : 'SIGNAL';
}

// ── Trade Size Buckets ────────────────────────────────────────────────────────
// Thresholds derived from GPT-5.4 empirical sample of 23,140 recent trades
// across monitored categories: p90=$256, p95=$828, p99=$4,600.
export type TradeSizeBucket = 'normal' | 'large' | 'whale' | 'mega';

interface SizeThresholds { large: number; whale: number; mega: number; }

/** Per-category thresholds calibrated to each market's typical trade size. */
function thresholdForTag(tagSlug: string): SizeThresholds {
  switch (tagSlug) {
    case 'forex':
    case 'treasuries':
      return { large: 100, whale: 250, mega: 1000 };
    case 'iran':
    case 'geopolitics':
      return { large: 250, whale: 750, mega: 3000 };
    case 'commodities':
    case 'fed-rates':
      return { large: 400, whale: 1000, mega: 2500 };
    default:
      return { large: 250, whale: 1000, mega: 5000 };
  }
}

/** Compute p-th quantile (0–1) of a sorted or unsorted array. Returns null if empty. */
function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

// ─────────────────────────────────────────────────────────────────────────────

/** Internal metadata stored per discovered asset */
interface AssetMeta {
  marketName: string;
  tagSlug: string;
}

export class VolatilityEngine {
  marketMap   = new Map<string, string>();
  assetMeta   = new Map<string, AssetMeta>();
  priceHistory  = new Map<string, number[]>();
  deltaHistory  = new Map<string, number[]>();
  notionalHistory = new Map<string, number[]>(); // rolling per-asset trade notionals
  lastPrice   = new Map<string, number>();
  tradeCount  = 0;
  ws: WebSocket | null = null;
  pingInterval: NodeJS.Timeout | null = null;
  pongTimeout: NodeJS.Timeout | null = null;
  reconnectDelay = 5000;

  // Expose a callback for broadcasting spikes
  onSpike: ((spike: any) => void) | null = null;
  onReady: (() => void) | null = null;

  /** Paginate a single slug sequentially (200ms between pages). Returns local discoveries. */
  private async discoverSlug(slug: string): Promise<Array<{ assetId: string; marketName: string; tagSlug: string }>> {
    const results: Array<{ assetId: string; marketName: string; tagSlug: string }> = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const url = `https://gamma-api.polymarket.com/events?tag_slug=${slug}&active=true&closed=false&limit=${limit}&offset=${offset}`;
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const events: GammaEvent[] = await response.json();

        if (!Array.isArray(events) || events.length === 0) {
          hasMore = false;
          break;
        }

        for (const event of events) {
          for (const market of event.markets || []) {
            let tokens: string[] = [];
            try {
              tokens = JSON.parse(market.clobTokenIds || "[]");
            } catch (e: any) {
              console.warn('Failed to parse clobTokenIds for market:', e.message);
            }
            if (tokens.length > 0) {
              const marketName = `${event.title} - ${market.groupItemTitle || "Yes"}`;
              results.push({ assetId: tokens[0], marketName, tagSlug: slug });
            }
          }
        }

        offset += limit;
        if (events.length < limit) {
          hasMore = false;
        } else {
          // Preserve 200ms inter-page delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } catch (e) {
        console.error(`Failed to fetch market data for slug ${slug}:`, e);
        hasMore = false;
      }
    }

    return results;
  }

  async discoverMarkets() {
    console.log(
      `Scanning Polymarket for active categories: ${TARGET_SLUGS.join(", ")}`
    );

    // Run all slugs concurrently; each slug paginates sequentially with 200ms delay.
    // allSettled() ensures one failed slug doesn't abort the others.
    const settled = await Promise.allSettled(
      TARGET_SLUGS.map(slug => this.discoverSlug(slug))
    );

    const assetIdSet = new Set<string>();
    const assetIds: string[] = [];

    for (const result of settled) {
      if (result.status === 'rejected') {
        console.error('Slug discovery failed:', result.reason);
        continue;
      }
      for (const { assetId, marketName, tagSlug } of result.value) {
        if (!assetIdSet.has(assetId)) {
          assetIdSet.add(assetId);
          this.marketMap.set(assetId, marketName);
          this.assetMeta.set(assetId, { marketName, tagSlug });
          this.priceHistory.set(assetId, []);
          this.deltaHistory.set(assetId, []);
          this.notionalHistory.set(assetId, []);
          assetIds.push(assetId);
        }
      }
    }

    console.log(`Found ${assetIds.length} specific markets to monitor.`);
    return assetIds;
  }

  /**
   * Classify a trade notional into a size bucket using per-category static
   * thresholds.  Returns the bucket label.
   */
  private classifyTradeSize(
    assetId: string,
    notionalUsdc: number
  ): { bucket: TradeSizeBucket; priorityScore: number } {
    const meta = this.assetMeta.get(assetId);
    const cuts = thresholdForTag(meta?.tagSlug ?? 'default');

    const bucket: TradeSizeBucket =
      notionalUsdc >= cuts.mega  ? 'mega'  :
      notionalUsdc >= cuts.whale ? 'whale' :
      notionalUsdc >= cuts.large ? 'large' :
      'normal';

    return { bucket, priorityScore: 0 }; // priorityScore computed by caller
  }

  analyzeTrade(assetId: string, price: number, trade?: TradeContext) {
    this.tradeCount++;
    if (isNaN(price) || price < 0 || price > 1) return;
    if (!this.marketMap.has(assetId)) return;

    const last = this.lastPrice.get(assetId);
    this.lastPrice.set(assetId, price);

    if (last === undefined) return;

    const delta = price - last;
    const deltas = this.deltaHistory.get(assetId)!;

    if (deltas.length >= MIN_DATA_POINTS) {
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const variance =
        deltas.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / deltas.length;
      const stdDev = Math.sqrt(variance);

      if (stdDev > 1e-8) {
        const zScore = (delta - mean) / stdDev;
        if (Math.abs(zScore) >= Z_SCORE_THRESHOLD) {
          const tier = classifySignal(price, zScore);

          // ── Size-aware fields (only when trade context provided) ───────────
          let side: 'BUY' | 'SELL' | null = null;
          let tradeSizeShares: number | null = null;
          let tradeNotionalUsdc: number | null = null;
          let tradeSizeBucket: TradeSizeBucket | null = null;
          let tradeTimestampMs: number | null = null;
          let priorityScore: number = Math.abs(zScore); // base = pure Z

          if (trade != null) {
            side = trade.side;
            tradeSizeShares = trade.sizeShares;
            tradeNotionalUsdc = trade.notionalUsdc;
            tradeTimestampMs = trade.timestampMs;

            const { bucket } = this.classifyTradeSize(assetId, trade.notionalUsdc);
            tradeSizeBucket = bucket;

            // priorityScore = |Z| × (1 + sizeBoost) for ranking
            const sizeBoost =
              bucket === 'mega'  ? 1.0 :
              bucket === 'whale' ? 0.5 :
              bucket === 'large' ? 0.2 :
              0;
            priorityScore = Math.abs(zScore) * (1 + sizeBoost);
          }
          // ─────────────────────────────────────────────────────────────────

          const spike = {
            type: "spike",
            tier,
            marketName: this.marketMap.get(assetId)!,
            assetId,
            timestamp: new Date().toISOString(),
            tradeTimestampMs,
            previousPrice: last,
            currentPrice: price,
            priceDelta: delta,
            rollingMeanDelta: mean,
            rollingStdDelta: stdDev,
            zScore,
            windowSize: deltas.length,
            // Trade size context (null when trade context not provided)
            side,
            tradeSizeShares,
            tradeNotionalUsdc,
            tradeSizeBucket,
            priorityScore,
          };

          const tierIcon = tier === 'STRONG' ? '🔴' : tier === 'SIGNAL' ? '🟡' : '⚪';
          const sizeStr = tradeNotionalUsdc != null
            ? ` | ${side} $${tradeNotionalUsdc >= 1000 ? `${(tradeNotionalUsdc / 1000).toFixed(1)}k` : tradeNotionalUsdc.toFixed(0)} [${tradeSizeBucket?.toUpperCase()}]`
            : '';
          console.log(
            `${tierIcon} [${tier}] ${spike.marketName} | ${last.toFixed(3)} -> ${price.toFixed(3)} | Δ: ${delta.toFixed(3)} | Z: ${zScore.toFixed(2)}${sizeStr}`
          );
          if (this.onSpike) {
            this.onSpike(spike);
          }
        }
      }
    }

    deltas.push(delta);
    if (deltas.length > ROLLING_WINDOW_SIZE) {
      deltas.shift();
    }

    // Update rolling notional history (only when trade context available)
    if (trade != null) {
      const notionals = this.notionalHistory.get(assetId);
      if (notionals != null) {
        notionals.push(trade.notionalUsdc);
        if (notionals.length > ROLLING_WINDOW_SIZE) notionals.shift();
      }
    }
  }

  async streamClob(assetIds: string[]) {
    if (assetIds.length === 0) return;

    const uri = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    this.ws = new WebSocket(uri);

    this.ws.on("open", () => {
      console.log(
        "🟢 Connected to CLOB WebSocket. Listening for real-time trades..."
      );
      this.reconnectDelay = 5000; // Reset backoff on successful connect
      this.ws?.send(
        JSON.stringify({
          assets_ids: assetIds,
          type: "market",
        })
      );

      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send('PING');
          this.pongTimeout = setTimeout(() => {
            console.log("Missed PONG, reconnecting...");
            this.ws?.terminate();
          }, 30000);
        }
      }, 10000);
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = data.toString();
        if (msg === 'PONG') {
          if (this.pongTimeout) clearTimeout(this.pongTimeout);
          return;
        }
        const message = JSON.parse(msg);

        // Handle array of events (e.g., initial book)
        if (Array.isArray(message)) {
          for (const event of message as ClobTradeMessage[]) {
            if (event.event_type === "last_trade_price") {
              const price = parseFloat(event.price);
              const rawSize = parseFloat(event.size);
              if (!Number.isFinite(price)) continue;
              const trade: TradeContext | undefined = Number.isFinite(rawSize) && rawSize > 0
                ? {
                    side: event.side,
                    sizeShares: rawSize,
                    notionalUsdc: rawSize * price,
                    timestampMs: Number(event.timestamp),
                  }
                : undefined;
              this.analyzeTrade(event.asset_id, price, trade);
            }
          }
        }
        // Handle single event object (e.g., live price_change)
        else if (message && typeof message === 'object') {
          const event = message as ClobTradeMessage;
          if (event.event_type === "last_trade_price") {
            const price = parseFloat(event.price);
            const rawSize = parseFloat(event.size);
            if (!Number.isFinite(price)) return;
            const trade: TradeContext | undefined = Number.isFinite(rawSize) && rawSize > 0
              ? {
                  side: event.side,
                  sizeShares: rawSize,
                  notionalUsdc: rawSize * price,
                  timestampMs: Number(event.timestamp),
                }
              : undefined;
            this.analyzeTrade(event.asset_id, price, trade);
          }
        }
      } catch (e: any) {
        // ignore
      }
    });

    this.ws.on("close", () => {
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.pongTimeout) clearTimeout(this.pongTimeout);
      console.log(
        `🔴 WebSocket connection dropped. Attempting to reconnect in ${this.reconnectDelay / 1000}s...`
      );
      setTimeout(() => this.streamClob(assetIds), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
    });

    this.ws.on("error", (err: Error) => {
      console.error("WebSocket error:", err);
    });
  }

  async run() {
    const targetAssets = await this.discoverMarkets();
    if (targetAssets.length === 0) {
      console.log("Exiting: No matching markets found or API limit reached.");
      return;
    }
    if (this.onReady) {
      this.onReady();
    }
    this.streamClob(targetAssets);
  }
}

export const engine = new VolatilityEngine();
