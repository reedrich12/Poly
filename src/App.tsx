/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Activity, AlertTriangle, TrendingUp, Clock, Server, Radio } from 'lucide-react';

interface Spike {
  marketName: string;
  timestamp: string;
  previousPrice: number;
  currentPrice: number;
  priceDelta: number;
  rollingMeanDelta: number;
  zScore: number;
}

export default function App() {
  const [spikes, setSpikes] = useState<Spike[]>([]);
  const [markets, setMarkets] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [tradeCount, setTradeCount] = useState(0);

  useEffect(() => {
    const eventSource = new EventSource('/api/stream?key=default-key');
    
    eventSource.onopen = () => setConnected(true);
    eventSource.onerror = () => setConnected(false);
    
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'init') {
        setMarkets(data.markets);
      } else if (data.type === 'stats') {
        setTradeCount(data.tradeCount);
      } else if (data.type === 'spike') {
        setSpikes((prev: Spike[]) => [data, ...prev].slice(0, 50)); // Keep last 50
      }
    };

    return () => eventSource.close();
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans p-6">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-zinc-800 pb-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white flex items-center gap-3">
              <Activity className="w-8 h-8 text-emerald-500" />
              Polymarket Volatility Engine
            </h1>
            <p className="text-zinc-400 mt-1">Real-time anomaly detection across {markets.length} markets</p>
          </div>
          <div className="flex items-center gap-3 bg-zinc-900 px-4 py-2 rounded-full border border-zinc-800">
            <Radio className={`w-4 h-4 ${connected ? 'text-emerald-500 animate-pulse' : 'text-red-500'}`} />
            <span className="text-sm font-medium">
              {connected ? 'CLOB Stream Active' : 'Disconnected'}
            </span>
            <div className="h-4 w-px bg-zinc-800 mx-2"></div>
            <Activity className="w-4 h-4 text-zinc-400" />
            <span className="text-sm text-zinc-400">
              {tradeCount.toLocaleString()} trades analyzed
            </span>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Feed */}
          <div className="lg:col-span-2 space-y-4">
            <h2 className="text-xl font-medium flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              Live Volatility Spikes
            </h2>
            
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              {spikes.length === 0 ? (
                <div className="p-12 text-center text-zinc-500 flex flex-col items-center">
                  <Activity className="w-12 h-12 mb-4 opacity-20" />
                  <p>Listening for statistical anomalies...</p>
                  <p className="text-sm mt-2">Awaiting Z-Score &gt; 3.0</p>
                </div>
              ) : (
                <div className="divide-y divide-zinc-800">
                  {spikes.map((spike: Spike, i: number) => (
                    <div key={i} className="p-4 hover:bg-zinc-800/50 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="font-medium text-white">{spike.marketName}</div>
                        <div className="flex items-center gap-4 text-sm text-zinc-400">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {new Date(spike.timestamp).toLocaleTimeString()}
                          </span>
                          <span className="flex items-center gap-1 text-emerald-400">
                            <TrendingUp className="w-3 h-3" />
                            Z-Score: {spike.zScore.toFixed(2)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 bg-zinc-950 px-4 py-2 rounded-lg border border-zinc-800 shrink-0">
                        <span className="text-zinc-400">{spike.previousPrice.toFixed(3)}¢</span>
                        <span className="text-zinc-600">➔</span>
                        <span className="text-white font-mono">{spike.currentPrice.toFixed(3)}¢</span>
                        <span className={`text-xs ml-2 ${spike.priceDelta >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                          {spike.priceDelta > 0 ? '+' : ''}{spike.priceDelta.toFixed(3)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Server className="w-4 h-4" />
                Engine Config
              </h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Rolling Window</span>
                  <span className="font-mono text-white">100 trades</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Trigger Threshold</span>
                  <span className="font-mono text-amber-400">3.0 Std Dev</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Min Data Points</span>
                  <span className="font-mono text-white">10</span>
                </div>
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
                Monitored Markets ({markets.length})
              </h3>
              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                {markets.length === 0 ? (
                  <p className="text-sm text-zinc-500">Discovering markets...</p>
                ) : (
                  markets.map((m: string, i: number) => (
                    <div key={i} className="text-sm text-zinc-300 truncate py-1 border-b border-zinc-800/50 last:border-0" title={m}>
                      {m}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
