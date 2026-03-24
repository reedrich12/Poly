# tracker.py
import asyncio
import json
import requests
import websockets
import numpy as np
from collections import deque
from datetime import datetime
import config

class VolatilityEngine:
    def __init__(self):
        self.market_map = {} 
        self.price_history = {} 
        
    def discover_markets(self):
        """Ping Gamma API to find live asset_ids for our target categories."""
        print(f"Scanning Polymarket for active categories: {config.TARGET_CATEGORIES}")
        
        asset_ids = []
        
        for slug in config.TARGET_CATEGORIES:
            offset = 0
            limit = 100
            has_more = True
            
            while has_more:
                url = f"https://gamma-api.polymarket.com/events?tag_slug={slug}&active=true&closed=false&limit={limit}&offset={offset}"
                try:
                    response = requests.get(url, timeout=10)
                    response.raise_for_status()
                    events = response.json()
                    
                    if not events:
                        has_more = False
                        break
                        
                    for event in events:
                        for market in event.get('markets', []):
                            tokens = json.loads(market.get('clobTokenIds', '[]'))
                            if tokens:
                                # Extract the "Yes" token ID
                                asset_id = tokens[0] 
                                market_name = f"{event.get('title')} - {market.get('groupItemTitle', 'Yes')}"
                                
                                # Initialize memory for this market
                                self.market_map[asset_id] = market_name
                                self.price_history[asset_id] = deque(maxlen=config.ROLLING_WINDOW_SIZE)
                                asset_ids.append(asset_id)
                                
                    offset += limit
                    if len(events) < limit:
                        has_more = False
                except Exception as e:
                    print(f"Failed to fetch market data for slug {slug}: {e}")
                    has_more = False
                        
        print(f"Found {len(asset_ids)} specific markets to monitor.\n")
        return asset_ids

    def analyze_trade(self, asset_id, price):
        """Calculate live Z-score and trigger alerts if thresholds are breached."""
        if asset_id not in self.price_history:
            return
            
        history = self.price_history[asset_id]
        market_name = self.market_map[asset_id]
        
        if len(history) >= config.MIN_DATA_POINTS:
            current_mean = np.mean(history)
            current_std = np.std(history)
            
            # Prevent division by zero if the market is entirely stagnant
            if current_std > 0:
                z_score = (price - current_mean) / current_std
                
                if abs(z_score) >= config.Z_SCORE_THRESHOLD:
                    print("-" * 60)
                    print(f"🚨 VOLATILITY SPIKE: {market_name}")
                    print(f"   Time:    {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
                    print(f"   Move:    {current_mean:.3f}c ➔ {price:.3f}c")
                    print(f"   Z-Score: {z_score:.2f} (Standard Deviations)")
                    print("-" * 60)
        
        # Append the latest price to the rolling deque
        history.append(price)

    async def stream_clob(self, asset_ids):
        """Maintain persistent WebSocket connection to the order book."""
        uri = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
        
        async with websockets.connect(uri, ping_interval=20, ping_timeout=20) as websocket:
            subscribe_message = {
                "assets_ids": asset_ids,
                "type": "market"
            }
            
            await websocket.send(json.dumps(subscribe_message))
            print("🟢 Connected to CLOB WebSocket. Listening for real-time trades...\n")
            
            while True:
                try:
                    message = await websocket.recv()
                    data = json.loads(message)
                    
                    if isinstance(data, list): 
                        for event in data:
                            # We only care about actual executed price changes
                            if event.get('event_type') == 'price_change':
                                asset_id = event.get('asset_id')
                                new_price = float(event.get('price'))
                                self.analyze_trade(asset_id, new_price)
                                
                except websockets.exceptions.ConnectionClosed:
                    print("🔴 WebSocket connection dropped. Attempting to reconnect...")
                    break
                except Exception as e:
                    # Catch malformed data without crashing the whole stream
                    pass 

    def run(self):
        target_assets = self.discover_markets()
        if not target_assets:
            print("Exiting: No matching markets found or API limit reached.")
            return
            
        # Run the async event loop
        asyncio.run(self.stream_clob(target_assets))

if __name__ == "__main__":
    engine = VolatilityEngine()
    engine.run()
