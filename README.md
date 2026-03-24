# Polymarket Volatility Engine

Real-time anomaly detection system that monitors Polymarket's Central Limit Order Book (CLOB) via WebSocket and flags statistical volatility spikes using Z-score analysis against a rolling price window. It features a dual implementation: a TypeScript/React full-stack web app and a Python standalone CLI.

## Architecture

```
+----------------+      +------------------+      +-------------------+      +-----------------+
| Polymarket API | ---> | Market Discovery | ---> | WebSocket Stream  | ---> | Z-Score Engine  |
| (Gamma REST)   |      | (Pagination)     |      | (CLOB price data) |      | (Rolling Window)|
+----------------+      +------------------+      +-------------------+      +-----------------+
                                                                                      |
                                                                                      v
                                                                             +-----------------+
                                                                             | React Frontend  |
                                                                             | (SSE Broadcast) |
                                                                             +-----------------+
```

## Setup Instructions

### TypeScript / React (Full-Stack)
1. Install dependencies: `npm install`
2. Create `.env` from `.env.example` and add your `GEMINI_API_KEY` and `APP_URL` if needed.
3. Run development server: `npm run dev`
4. Build for production: `npm run build`
5. Run production server: `NODE_ENV=production tsx server.ts`

### Python (Standalone CLI)
1. Install dependencies: `pip install -r requirements.txt`
2. Run the tracker: `python tracker.py`

## Environment Variables
- `GEMINI_API_KEY`: Required for Gemini AI API calls (if applicable).
- `APP_URL`: The URL where this applet is hosted.

## Polymarket API References
- **Gamma REST API:** `https://gamma-api.polymarket.com/events?tag_slug={slug}&active=true&closed=false&limit={limit}&offset={offset}`
- **CLOB WebSocket:** `wss://ws-subscriptions-clob.polymarket.com/ws/market`
