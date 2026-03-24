import WebSocket from "ws";

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

export class VolatilityEngine {
  marketMap = new Map<string, string>();
  priceHistory = new Map<string, number[]>();
  ws: WebSocket | null = null;
  pingInterval: NodeJS.Timeout | null = null;
  reconnectDelay = 5000;
  
  // Expose a callback for broadcasting spikes
  onSpike: ((spike: any) => void) | null = null;

  async discoverMarkets() {
    console.log(
      `Scanning Polymarket for active categories: ${TARGET_SLUGS.join(", ")}`
    );
    
    const assetIds: string[] = [];

    for (const slug of TARGET_SLUGS) {
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const url = `https://gamma-api.polymarket.com/events?tag_slug=${slug}&active=true&closed=false&limit=${limit}&offset=${offset}`;
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
          const events = await response.json();

          if (!Array.isArray(events) || events.length === 0) {
            hasMore = false;
            break;
          }

          for (const event of events) {
            for (const market of event.markets || []) {
              let tokens = [];
              try {
                tokens = JSON.parse(market.clobTokenIds || "[]");
              } catch (e: any) {
                console.warn('Malformed WS message:', e.message);
              }
              if (tokens.length > 0) {
                const assetId = tokens[0];
                const marketName = `${event.title} - ${market.groupItemTitle || "Yes"}`;
                this.marketMap.set(assetId, marketName);
                this.priceHistory.set(assetId, []);
                assetIds.push(assetId);
              }
            }
          }

          offset += limit;
          if (events.length < limit) {
            hasMore = false;
          }
          
          // Add a small delay to avoid hitting rate limits too hard
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (e) {
          console.error(`Failed to fetch market data for slug ${slug}:`, e);
          hasMore = false;
        }
      }
    }
    console.log(`Found ${assetIds.length} specific markets to monitor.`);
    return assetIds;
  }

  analyzeTrade(assetId: string, price: number) {
    if (isNaN(price)) return;
    if (!this.priceHistory.has(assetId)) return;

    const history = this.priceHistory.get(assetId)!;
    const marketName = this.marketMap.get(assetId)!;

    if (history.length >= MIN_DATA_POINTS) {
      const mean = history.reduce((a, b) => a + b, 0) / history.length;
      const variance =
        history.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / history.length;
      const stdDev = Math.sqrt(variance);

      if (stdDev > 0) {
        const zScore = (price - mean) / stdDev;
        if (Math.abs(zScore) >= Z_SCORE_THRESHOLD) {
          const spike = {
            type: "spike",
            marketName,
            time: new Date().toISOString(),
            oldPrice: mean,
            newPrice: price,
            zScore,
          };
          console.log(
            `🚨 VOLATILITY SPIKE: ${marketName} | ${mean.toFixed(
              3
            )} -> ${price.toFixed(3)} | Z: ${zScore.toFixed(2)}`
          );
          if (this.onSpike) {
            this.onSpike(spike);
          }
        }
      }
    }

    history.push(price);
    if (history.length > ROLLING_WINDOW_SIZE) {
      history.shift();
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
          this.ws.ping();
        }
      }, 20000);
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        if (Array.isArray(message)) {
          for (const event of message) {
            if (event.event_type === "price_change") {
              const assetId = event.asset_id;
              const newPrice = parseFloat(event.price);
              this.analyzeTrade(assetId, newPrice);
            }
          }
        }
      } catch (e: any) {
        console.warn('Malformed WS message:', e.message);
      }
    });

    this.ws.on("close", () => {
      if (this.pingInterval) clearInterval(this.pingInterval);
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
    this.streamClob(targetAssets);
  }
}

export const engine = new VolatilityEngine();
