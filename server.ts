import express from "express";
import { createServer as createViteServer } from "vite";
import WebSocket from "ws";
import path from "path";
import helmet from "helmet";
import cors from "cors";
import { engine } from "./engine.ts";

const app = express();
const PORT = 3000;

app.use(helmet({
  contentSecurityPolicy: false, // Vite needs inline scripts in dev
}));
app.use(cors());

// --- Server State ---
const clients = new Set<express.Response>();

function broadcast(data: Record<string, any>) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

engine.onSpike = (spike) => {
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
    sseClients: clients.size,
  });
});

app.get("/api/stream", (req, res) => {
  if (clients.size >= 100) {
    res.status(503).json({ error: "Service Unavailable: Max SSE clients reached" });
    return;
  }

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
