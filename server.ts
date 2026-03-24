import express from "express";
import { createServer as createViteServer } from "vite";
import WebSocket from "ws";
import path from "path";

const app = express();
const PORT = 3000;

// --- Config ---
const TARGET_SLUGS = [
  "iran",
  "geopolitics",
  "indices",
  "commodities",
  "forex",
  "fed-rates",
  "treasuries",
];
const ROLLING_WINDOW_SIZE = 100;
const Z_SCORE_THRESHOLD = 3.0;
const MIN_DATA_POINTS = 10;

// --- Server State ---
const clients = new Set<express.Response>();

function broadcast(data: any) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

// --- API Routes ---
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.add(res);

  // Send initial state
  res.write(
    `data: ${JSON.stringify({
      type: "init",
      markets: Array.from(engine.marketMap.values()),
    })}\n\n`
  );

  req.on("close", () => {
    clients.delete(res);
  });
});

app.get("/api/markets", (req, res) => {
  res.json(Array.from(engine.marketMap.values()));
});

// --- Engine ---
class VolatilityEngine {
  marketMap = new Map<string, string>();
  priceHistory = new Map<string, number[]>();
  ws: WebSocket | null = null;

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
              } catch (e) {}
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
          broadcast(spike);
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
      this.ws?.send(
        JSON.stringify({
          assets_ids: assetIds,
          type: "market",
        })
      );
    });

    this.ws.on("message", (data) => {
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
      } catch (e) {
        // ignore malformed
      }
    });

    this.ws.on("close", () => {
      console.log(
        "🔴 WebSocket connection dropped. Attempting to reconnect in 5s..."
      );
      setTimeout(() => this.streamClob(assetIds), 5000);
    });

    this.ws.on("error", (err) => {
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

const engine = new VolatilityEngine();

// --- Vite Middleware & Start ---
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    engine.run();
  });
}

startServer();
