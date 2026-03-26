import express from "express";
import { createServer as createViteServer } from "vite";
import WebSocket from "ws";
import path from "path";
import helmet from "helmet";
import cors from "cors";
import Database from "better-sqlite3";
import { engine } from "./engine.ts";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

if (process.env.NODE_ENV === 'production') {
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                connectSrc: ["'self'"],
            }
        }
    }));
} else {
    app.use(helmet({ contentSecurityPolicy: false }));
}

app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000']
}));

// --- Database Setup ---
const db = new Database('spikes.db');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS spike_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tier TEXT NOT NULL DEFAULT 'SIGNAL',
      market_name TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      previous_price REAL NOT NULL,
      current_price REAL NOT NULL,
      price_delta REAL NOT NULL,
      z_score REAL NOT NULL,
      rolling_mean_delta REAL NOT NULL,
      rolling_std_delta REAL NOT NULL,
      window_size INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spike_timestamp ON spike_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_spike_market ON spike_events(market_name);
  CREATE INDEX IF NOT EXISTS idx_spike_tier ON spike_events(tier);
`);

const insertSpike = db.prepare(`
  INSERT INTO spike_events (
    tier, market_name, asset_id, timestamp, previous_price, current_price, 
    price_delta, z_score, rolling_mean_delta, rolling_std_delta, window_size
  ) VALUES (
    @tier, @marketName, @assetId, @timestamp, @previousPrice, @currentPrice,
    @priceDelta, @zScore, @rollingMeanDelta, @rollingStdDelta, @windowSize
  )
`);

// --- Server State ---
interface SSEClient {
    res: express.Response;
    ip: string;
    backpressured: boolean;
    queuedMessages: string[];
    maxQueueSize: number;
}
const sseClients = new Set<SSEClient>();

function broadcast(data: Record<string, any>) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
      if (client.backpressured) {
          if (client.queuedMessages.length < client.maxQueueSize) {
              client.queuedMessages.push(message);
          } else {
              client.res.end();
              sseClients.delete(client);
          }
          continue;
      }

      const ok = client.res.write(message);
      if (!ok) {
          client.backpressured = true;
          client.res.once('drain', () => {
              client.backpressured = false;
              while (client.queuedMessages.length > 0 && !client.backpressured) {
                  const queued = client.queuedMessages.shift()!;
                  if (!client.res.write(queued)) {
                      client.backpressured = true;
                  }
              }
          });
      }
  }
}

engine.onSpike = (spike) => {
  insertSpike.run(spike);
  broadcast(spike);
};

engine.onReady = () => {
  broadcast({
    type: "init",
    markets: Array.from(engine.marketMap.values()),
  });
};

setInterval(() => {
  broadcast({
    type: "stats",
    tradeCount: engine.tradeCount,
  });
}, 5000);

// --- API Routes ---
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    wsConnected: engine.ws?.readyState === WebSocket.OPEN,
    marketsMonitored: engine.marketMap.size,
    sseClients: sseClients.size,
  });
});

const VALID_API_KEYS = new Set([process.env.API_KEY || 'default-key']);
const MAX_CONNECTIONS_PER_IP = 5;

app.get("/api/stream", (req, res) => {
  const apiKey = (req.query.key || req.headers['x-api-key']) as string;
  if (!apiKey || !VALID_API_KEYS.has(apiKey)) {
      return res.status(401).json({ error: 'Invalid API key' });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const ipCount = Array.from(sseClients).filter(c => c.ip === ip).length;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) {
      return res.status(429).json({ error: 'Too many connections' });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const client: SSEClient = {
    res, ip, backpressured: false, queuedMessages: [], maxQueueSize: 100
  };
  sseClients.add(client);

  // Send initial state
  res.write(
    `data: ${JSON.stringify({
      type: "init",
      markets: Array.from(engine.marketMap.values()),
    })}\n\n`
  );

  req.on("close", () => {
    sseClients.delete(client);
  });
});

app.get("/api/spikes", (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const spikes = db.prepare('SELECT * FROM spike_events ORDER BY timestamp DESC LIMIT ?').all(limit);
  res.json(spikes);
});

app.get("/api/markets", (req, res) => {
  res.json(Array.from(engine.marketMap.values()));
});

// --- API Routes ---
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

async function shutdown(signal: string) {
    console.log(`${signal} received, shutting down gracefully...`);
    if (engine.ws) engine.ws.close();
    for (const client of sseClients) {
        client.res.end();
    }
    db.close();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
