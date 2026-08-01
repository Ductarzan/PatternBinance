export type MarketType = "futures" | "spot";
export type Signal = "LONG" | "SHORT" | "WAIT";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type TimeframeState = {
  interval: string;
  label: string;
  bias: "Tăng" | "Giảm" | "Trung tính";
  rsi: number;
  ema20: number;
  ema50: number;
  change: number;
};

export type OrderLevel = {
  price: number;
  quantity: number;
  total: number;
};

export type MarketAnalysis = {
  symbol: string;
  market: MarketType;
  generatedAt: number;
  candlesAnalyzed: number;
  patternWindow: number;
  forwardBars: number;
  current: {
    price: number;
    markPrice: number | null;
    change24h: number;
    quoteVolume24h: number;
  };
  signal: Signal;
  score: number;
  grade: string;
  confidence: number;
  probabilities: {
    bullish: number;
    neutral: number;
    bearish: number;
  };
  setup: {
    entryLow: number;
    entryHigh: number;
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    riskReward: number;
  };
  indicators: {
    rsi14: number;
    atr14: number;
    atrPercent: number;
    ema20: number;
    ema50: number;
    ema200: number;
    macdHistogram: number;
    volumeRatio: number;
    orderBookImbalance: number;
  };
  funding: {
    rate: number | null;
    nextTime: number | null;
    annualized: number | null;
  };
  pattern: {
    matches: number;
    averageSimilarity: number;
    medianForwardReturn: number;
    bestSimilarity: number;
    sampleSpanDays: number;
  };
  timeframes: TimeframeState[];
  orderBook: {
    bids: OrderLevel[];
    asks: OrderLevel[];
    bidValue: number;
    askValue: number;
  };
  chartCandles: Candle[];
  factors: Array<{
    label: string;
    value: string;
    state: "positive" | "negative" | "neutral";
  }>;
  deterministicSummary: string;
  warnings: string[];
};

export type AiExplanation = {
  configured: boolean;
  title: string;
  narrative: string;
  keyDrivers: string[];
  invalidation: string;
  caution: string;
};

export type WatchlistItem = {
  symbol: string;
  ticker: string;
  price: number;
  change24h: number;
  quoteVolume24h: number;
  score: number;
  signal: Signal;
  rsi15m: number;
  rsi1h: number;
  atrPercent: number;
  volumeRatio: number;
  fundingRate: number | null;
  reasons: string[];
};

export type WatchlistResponse = {
  market: MarketType;
  generatedAt: number;
  scanned: number;
  items: WatchlistItem[];
  methodology: string;
};
