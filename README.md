# Polymarket Volatility Engine

Real-time anomaly detection system that monitors Polymarket's Central Limit Order Book (CLOB) via WebSocket and flags statistical volatility spikes using Z-score analysis on a rolling window of price **deltas**.

## Architecture

```
+─────────────────────+   +──────────────────────────+   +────────────────────+
│  Polymarket Gamma   │──▶│  Market Discovery        │──▶│  CLOB WebSocket    │
│  REST API           │   │  (parallel slug scan,    │   │  (last_trade_price │
│  /events?tag_slug=  │   │   sequential pagination, │   │   events only)     │
│                     │   │   200ms inter-page delay)│   │                    │
+─────────────────────+   +──────────────────────────+   +────────────────────+
                                                                    │
                                                                    ▼
                                                   +────────────────────────────+
                                                   │  VolatilityEngine          │
                                                   │  analyzeTrade()            │
                                                   │  • delta = price – last    │
                                                   │  • rolling deltaHistory    │
                                                   │    (max 100 entries)       │
                                                   │  • population Z-score      │
                                                   │  • spike if |Z| ≥ 3.0     │
                                                   +────────────────────────────+
                                                                    │ onSpike
                                                                    ▼
                                              +──────────────────────────────────+
                                              │  Express Server                  │
                                              │  • SQLite (WAL mode)             │
                                              │  • SSE /api/stream (backpressure)│
                                              │  • GET /api/spikes               │
                                              │  • GET /api/markets              │
                                              │  • React SPA (Vite)              │
                                              +──────────────────────────────────+
```

## Z-Score Math

The engine detects anomalous price **changes**, not price levels.

```
delta     = price_now – price_last
mean      = mean(deltaHistory)          // population mean
variance  = Σ(δ – mean)² / N           // population variance (divide by N, not N-1)
stdDev    = √variance
zScore    = (delta – mean) / stdDev
spike     = |zScore| ≥ 3.0
```

Key properties:
- Z-score is computed against the current window **before** the new delta is appended (triggering delta is not part of its own baseline)
- Rolling window capped at `ROLLING_WINDOW_SIZE = 100`
- Requires `MIN_DATA_POINTS = 10` deltas before any spike can fire
- If `stdDev ≤ 1e-8` (flat market), spike detection is suppressed to avoid division-by-zero false positives

## Setup

### Prerequisites

- Node.js ≥ 20
- npm ≥ 9

### Development

```bash
npm install
npm run dev        # starts tsx server.ts + Vite HMR at http://localhost:3000
```

### Production

```bash
npm run build      # compiles React frontend to dist/
npm start          # runs tsx server.ts in production mode
# or:
NODE_ENV=production tsx server.ts
```

### Tests

```bash
npm test           # vitest run (no watch)
npm run lint       # tsc --noEmit (type-check only)
```

## Environment Variables

| Variable          | Default       | Description                                           |
|-------------------|---------------|-------------------------------------------------------|
| `API_KEY`         | `default-key` | Bearer key required for `/api/stream` (SSE endpoint)  |
| `ALLOWED_ORIGINS` | `localhost:3000` | Comma-separated CORS allowed origins               |
| `NODE_ENV`        | —             | Set to `production` for static file serving + CSP     |

## API Endpoints

| Method | Path           | Auth     | Description                              |
|--------|----------------|----------|------------------------------------------|
| GET    | `/api/stream`  | API key  | SSE stream of spike events and stats     |
| GET    | `/api/spikes`  | None     | Recent spikes from SQLite (default 50)   |
| GET    | `/api/markets` | None     | Currently monitored market names         |
| GET    | `/health`      | None     | WS status, market count, SSE client count|

SSE auth: pass key via query string (`?key=…`) or `x-api-key` header.

## Monitored Categories

The engine scans these Polymarket tag slugs on startup:

```
iran, geopolitics, indices, commodities, forex, fed-rates, treasuries
```

Slug scans run **concurrently** (one goroutine-equivalent per slug via `Promise.allSettled`). Within each slug, pages are fetched **sequentially** with a 200 ms inter-page delay to respect rate limits.

## Polymarket API References

- **Gamma REST API:** `https://gamma-api.polymarket.com/events?tag_slug={slug}&active=true&closed=false&limit={limit}&offset={offset}`
- **CLOB WebSocket:** `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- **WebSocket subscription payload:** `{ "type": "market", "assets_ids": ["..."] }`
- **Trade message shape:** `{ "event_type": "last_trade_price", "asset_id": "...", "price": "0.456", ... }` — note `price` is a **string**; the engine calls `parseFloat()` before use.
