/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Activity, AlertTriangle, TrendingUp, TrendingDown, Clock, Server, Radio, Filter } from 'lucide-react';

type SignalTier = 'NOISE' | 'SIGNAL' | 'STRONG';
type TradeSizeBucket = 'normal' | 'large' | 'whale' | 'mega';

interface Spike {
  tier: SignalTier;
  marketName: string;
  timestamp: string;
  previousPrice: number;
  currentPrice: number;
  priceDelta: number;
  rollingMeanDelta: number;
  zScore: number;
  // Trade size fields (null when trade context unavailable)
  side: 'BUY' | 'SELL' | null;
  tradeSizeShares: number | null;
  tradeNotionalUsdc: number | null;
  tradeSizeBucket: TradeSizeBucket | null;
  priorityScore: number;
}

// ── Size badge config ──────────────────────────────────────────────────────
const SIZE_BUCKET_CONFIG: Record<TradeSizeBucket, { label: string; classes: string }> = {
  normal: { label: 'NORMAL', classes: 'bg-zinc-900 text-zinc-300 border-zinc-700' },
  large:  { label: 'LARGE',  classes: 'bg-sky-950/60 text-sky-300 border-sky-800' },
  whale:  { label: 'WHALE',  classes: 'bg-amber-950/50 text-amber-300 border-amber-800' },
  mega:   { label: 'MEGA',   classes: 'bg-fuchsia-950/40 text-fuchsia-300 border-fuchsia-800' },
};

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 10_000)    return `$${(n / 1_000).toFixed(0)}k`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function SizeBadge({ spike }: { spike: Spike }) {
  if (spike.tradeNotionalUsdc == null || spike.tradeSizeBucket == null) return null;
  const cfg = SIZE_BUCKET_CONFIG[spike.tradeSizeBucket];
  const sideColor = spike.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400';
  const tooltip = spike.tradeSizeShares != null
    ? `${spike.tradeSizeShares.toFixed(1)} shares`
    : '';
  return (
    <span className="inline-flex items-center gap-1.5">
      {spike.side != null && (
        <span className={`text-xs font-semibold ${sideColor}`}>{spike.side}</span>
      )}
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-mono ${cfg.classes}`}
        title={tooltip}
      >
        {formatUsd(spike.tradeNotionalUsdc)}
        <span className="text-[10px] opacity-70">{cfg.label}</span>
      </span>
    </span>
  );
}

// ── Tier badge config ──────────────────────────────────────────────────────
const TIER_CONFIG: Record<SignalTier, { label: string; bg: string; text: string; dot: string; description: string }> = {
  STRONG: {
    label: 'STRONG',
    bg: 'bg-red-500/15 border border-red-500/30',
    text: 'text-red-400',
    dot: 'bg-red-500',
    description: '|Z| ≥ 4.5, mid-range market',
  },
  SIGNAL: {
    label: 'SIGNAL',
    bg: 'bg-amber-500/15 border border-amber-500/30',
    text: 'text-amber-400',
    dot: 'bg-amber-500',
    description: '|Z| ≥ 3.0, mid-range market',
  },
  NOISE: {
    label: 'NOISE',
    bg: 'bg-zinc-700/40 border border-zinc-600/30',
    text: 'text-zinc-500',
    dot: 'bg-zinc-500',
    description: 'Near-resolution market (price < 5% or > 95%)',
  },
};

function TierBadge({ tier }: { tier: SignalTier }) {
  const cfg = TIER_CONFIG[tier];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold tracking-wide ${cfg.bg} ${cfg.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

export default function App() {
  const [spikes, setSpikes] = useState<Spike[]>([]);
  const [markets, setMarkets] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [tradeCount, setTradeCount] = useState(0);
  const [tierFilter, setTierFilter] = useState<SignalTier | 'ALL'>('ALL');

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
        setSpikes((prev: Spike[]) => [data, ...prev].slice(0, 100));
      }
    };

    return () => eventSource.close();
  }, []);

  const filteredSpikes = tierFilter === 'ALL'
    ? spikes
    : spikes.filter(s => s.tier === tierFilter);

  const counts = {
    STRONG: spikes.filter(s => s.tier === 'STRONG').length,
    SIGNAL: spikes.filter(s => s.tier === 'SIGNAL').length,
    NOISE:  spikes.filter(s => s.tier === 'NOISE').length,
  };

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
            <p className="text-zinc-400 mt-1">Real-time anomaly detection across {markets.length.toLocaleString()} markets</p>
          </div>
          <div className="flex items-center gap-3 bg-zinc-900 px-4 py-2 rounded-full border border-zinc-800">
            <Radio className={`w-4 h-4 ${connected ? 'text-emerald-500 animate-pulse' : 'text-red-500'}`} />
            <span className="text-sm font-medium">
              {connected ? 'CLOB Stream Active' : 'Disconnected'}
            </span>
            <div className="h-4 w-px bg-zinc-800 mx-2" />
            <Activity className="w-4 h-4 text-zinc-400" />
            <span className="text-sm text-zinc-400">
              {tradeCount.toLocaleString()} trades analyzed
            </span>
          </div>
        </header>

        {/* Tier summary pills */}
        <div className="flex flex-wrap gap-3">
          {(['ALL', 'STRONG', 'SIGNAL', 'NOISE'] as const).map(t => {
            const isActive = tierFilter === t;
            const count = t === 'ALL' ? spikes.length : counts[t];
            const cfg = t === 'ALL' ? null : TIER_CONFIG[t];
            return (
              <button
                key={t}
                onClick={() => setTierFilter(t)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border transition-all
                  ${isActive
                    ? 'bg-zinc-700 border-zinc-500 text-white'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                  }`}
              >
                {cfg && <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />}
                <Filter className={`w-3 h-3 ${t === 'ALL' ? '' : 'hidden'}`} />
                {t === 'ALL' ? 'All' : t}
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${isActive ? 'bg-zinc-600' : 'bg-zinc-800'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Feed */}
          <div className="lg:col-span-2 space-y-4">
            <h2 className="text-xl font-medium flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              Live Volatility Spikes
              {tierFilter !== 'ALL' && (
                <span className="text-sm text-zinc-500 font-normal ml-1">— {tierFilter} only</span>
              )}
            </h2>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              {filteredSpikes.length === 0 ? (
                <div className="p-12 text-center text-zinc-500 flex flex-col items-center">
                  <Activity className="w-12 h-12 mb-4 opacity-20" />
                  <p>Listening for statistical anomalies...</p>
                  <p className="text-sm mt-2">Awaiting Z-Score ≥ 3.0</p>
                </div>
              ) : (
                <div className="divide-y divide-zinc-800">
                  {filteredSpikes.map((spike: Spike, i: number) => (
                    <div
                      key={i}
                      className={`p-4 hover:bg-zinc-800/50 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4
                        ${spike.tier === 'NOISE' ? 'opacity-50' : ''}`}
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <TierBadge tier={spike.tier} />
                          <SizeBadge spike={spike} />
                          <span className="font-medium text-white text-sm">{spike.marketName}</span>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-zinc-400">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {new Date(spike.timestamp).toLocaleTimeString()}
                          </span>
                          <span className={`flex items-center gap-1 ${Math.abs(spike.zScore) >= 4.5 ? 'text-red-400' : 'text-amber-400'}`}>
                            {spike.zScore >= 0
                              ? <TrendingUp className="w-3 h-3" />
                              : <TrendingDown className="w-3 h-3" />}
                            Z-Score: {spike.zScore.toFixed(2)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 bg-zinc-950 px-4 py-2 rounded-lg border border-zinc-800 shrink-0">
                        <span className="text-zinc-400 font-mono text-sm">{(spike.previousPrice * 100).toFixed(1)}¢</span>
                        <span className="text-zinc-600">→</span>
                        <span className="text-white font-mono font-semibold">{(spike.currentPrice * 100).toFixed(1)}¢</span>
                        <span className={`text-xs ml-1 font-mono ${spike.priceDelta >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                          {spike.priceDelta > 0 ? '+' : ''}{(spike.priceDelta * 100).toFixed(1)}¢
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
            {/* Signal legend */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
                Signal Tiers
              </h3>
              <div className="space-y-3">
                {(['STRONG', 'SIGNAL', 'NOISE'] as SignalTier[]).map(tier => {
                  const cfg = TIER_CONFIG[tier];
                  return (
                    <div key={tier} className="flex items-start gap-3">
                      <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />
                      <div>
                        <div className={`text-xs font-semibold ${cfg.text}`}>{cfg.label}</div>
                        <div className="text-xs text-zinc-500">{cfg.description}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Engine config */}
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
                  <span className="text-zinc-500">Strong Signal</span>
                  <span className="font-mono text-red-400">4.5 Std Dev</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Min Data Points</span>
                  <span className="font-mono text-white">10</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Noise filter</span>
                  <span className="font-mono text-zinc-400">&lt;5% / &gt;95%</span>
                </div>
              </div>
            </div>

            {/* Monitored Markets */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
                Monitored Markets ({markets.length.toLocaleString()})
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
