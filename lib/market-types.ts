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
  rsi1m: number | null;
  rsi15m: number;
  rsi1h: number;
  rsi4h: number;
  lowestRsi: number;
  highestRsi: number;
  oversoldFrames: Array<"15m" | "1h" | "4h">;
  overboughtFrames: Array<"15m" | "1h" | "4h">;
  bullishDivergences: RsiDivergence[];
  bearishDivergences: RsiDivergence[];
  reversal: ReversalReadiness;
  volumeAlerts: VolumeAlert[];
  volumeVerdict: VolumeVerdict;
  orderBookImbalance: number;
  baseProbe: BaseProbe;
  entryPlan: EntryPlan | null;
  atrPercent: number;
  volumeRatio: number;
  fundingRate: number | null;
  reasons: string[];
};

export type RsiDivergence = {
  frame: "15m" | "1h" | "4h";
  previousPrice: number;
  currentPrice: number;
  previousRsi: number;
  currentRsi: number;
  barsApart: number;
  rsiGap: number;
  priceGapPercent: number;
  strength: number;
};

export type EntryTriggerKey =
  | "rsiTurn1m"
  | "emaCross1m"
  | "structureBreak1m"
  | "volumeConfirm1m";

export type EntryTrigger = {
  key: EntryTriggerKey;
  label: string;
  detail: string;
  met: boolean;
};

export type EntryPlan = {
  direction: "long" | "short";
  state: "Vào được" | "Chờ trigger 1m" | "Trễ nhịp" | "Chưa đủ điều kiện";
  readiness: number;
  triggers: EntryTrigger[];
  entry: number;
  stop: number;
  target: number;
  riskPercent: number;
  rewardRisk: number;
  asOf: number;
  note: string;
};

export type BaseProbeSignalKey =
  | "levelRetest"
  | "higherLows"
  | "lowerHighs"
  | "volumeContraction"
  | "failedBreakdown"
  | "failedBreakout"
  | "rangeCompression"
  | "noNewLow"
  | "noNewHigh"
  | "emaReclaim"
  | "emaLoss";

export type BaseProbeSignal = {
  key: BaseProbeSignalKey;
  label: string;
  detail: string;
  weight: number;
};

export type BaseProbe = {
  direction: "bottom" | "top" | "none";
  frame: "15m" | "1h" | "4h";
  score: number;
  stage: "Nền vững" | "Đang tạo nền" | "Mới chớm" | "Chưa có";
  level: number;
  invalidation: number;
  touches: number;
  spanBars: number;
  headline: string;
  detail: string;
  signals: BaseProbeSignal[];
};

export type VolumeAlertKey =
  | "riseVolumeFade"
  | "supplyDryUp"
  | "demandDryUp"
  | "buyAbsorption"
  | "riseVolumeConfirm"
  | "sellPressureBuilding";

export type VolumeAlert = {
  key: VolumeAlertKey;
  frame: "15m" | "1h" | "4h";
  bias: "bullish" | "bearish";
  action: "LONG" | "SHORT" | "WATCH";
  label: string;
  detail: string;
  conclusion: string;
  strength: number;
};

export type VolumeVerdict = {
  bias: "bullish" | "bearish" | "mixed" | "none";
  headline: string;
  detail: string;
  confidence: "Mạnh" | "Vừa" | "Nhẹ" | "—";
};

export type ReversalSignalKey =
  | "divergence"
  | "multiFrameDivergence"
  | "rsiTurn"
  | "rsiExitExtreme"
  | "reversalCandle"
  | "volumeClimax"
  | "rejectionWick"
  | "emaReclaim"
  | "structureBreak";

export type ReversalSignal = {
  key: ReversalSignalKey;
  label: string;
  detail: string;
  weight: number;
};

export type ReversalReadiness = {
  direction: "bullish" | "bearish" | "none";
  score: number;
  stage: "Sắp đảo chiều" | "Đang hình thành" | "Yếu" | "Chưa có";
  signals: ReversalSignal[];
  candlePattern: string | null;
  rsiSlope: number;
  volumeSpike: number;
};

export type WatchlistResponse = {
  market: MarketType;
  generatedAt: number;
  scanned: number;
  successfulScans: number;
  matchedCount: number;
  overboughtMatchedCount: number;
  universeSize: number;
  batch: number;
  batchCount: number;
  refreshIntervalMs: number;
  items: WatchlistItem[];
  overboughtItems: WatchlistItem[];
  probeItems: WatchlistItem[];
  bottomProbeCount: number;
  topProbeCount: number;
  methodology: string;
  overboughtMethodology: string;
  probeMethodology: string;
};
