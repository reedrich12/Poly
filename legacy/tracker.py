"""
Polymarket Volatility Engine Tracker.
Monitors the Polymarket CLOB for statistical volatility spikes.
"""
import asyncio
import json
import math
import aiohttp
import websockets
import numpy as np
from collections import deque
from typing import Dict, List, Any
from datetime import datetime
import config

class VolatilityEngine:
    def __init__(self) -> None:
        self.market_map: Dict[str, str] = {} 
        self.price_history: Dict[str, deque] = {} 
        
    async def discover_markets(self) -> List[str]:
        """Ping Gamma API to find live asset_ids for our target categories."""
        print(f"Scanning Polymarket for active categories: {config.TARGET_CATEGORIES}")
        
        asset_ids: List[str] = []
        
        async with aiohttp.ClientSession() as session:
            for slug in config.TARGET_CATEGORIES:
                offset = 0
                limit = 100
                has_more = True
                
                while has_more:
                    url = f"https://gamma-api.polymarket.com/events?tag_slug={slug}&active=true&closed=false&limit={limit}&offset={offset}"
                    try:
                        async with session.get(url, timeout=10) as response:
                            response.raise_for_status()
                            events = await response.json()
                            
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
                            await asyncio.sleep(0.2) # 200ms delay
                    except Exception as e:
                        print(f"Failed to fetch market data for slug {slug}: {e}")
                        has_more = False
                        
        print(f"Found {len(asset_ids)} specific markets to monitor.\n")
        return asset_ids

    def analyze_trade(self, asset_id: str, price: float) -> None:
        """Calculate live Z-score and trigger alerts if thresholds are breached."""
        if math.isnan(price):
            return
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

    async def stream_clob(self, asset_ids: List[str]) -> None:
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
                                try:
                                    new_price = float(event.get('price'))
                                    self.analyze_trade(asset_id, new_price)
                                except (ValueError, TypeError):
                                    pass
                                
                except websockets.exceptions.ConnectionClosed:
                    print("🔴 WebSocket connection dropped. Attempting to reconnect...")
                    break
                except Exception as e:
                    # Catch malformed data without crashing the whole stream
                    print(f'Malformed data: {e}') 

    async def run_async(self) -> None:
        target_assets = await self.discover_markets()
        if not target_assets:
            print("Exiting: No matching markets found or API limit reached.")
            return
            
        # Run the async event loop with reconnection
        while True:
            try:
                await self.stream_clob(target_assets)
            except Exception as e:
                print(f"Stream error: {e}. Reconnecting in 5 seconds...")
                await asyncio.sleep(5)

    def run(self) -> None:
        asyncio.run(self.run_async())

if __name__ == "__main__":
    engine = VolatilityEngine()
    engine.run()
