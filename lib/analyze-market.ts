import type {
  Candle,
  MarketAnalysis,
  MarketType,
  OrderLevel,
  Signal,
  TimeframeState,
} from "./market-types";

type RawTicker = {
  lastPrice?: string;
  priceChangePercent?: string;
  quoteVolume?: string;
};

type RawFunding = {
  lastFundingRate?: string;
  nextFundingTime?: number;
  markPrice?: string;
} | null;

type RawDepth = {
  bids?: string[][];
  asks?: string[][];
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

function ema(values: number[], period: number) {
  if (!values.length) return 0;
  const multiplier = 2 / (period + 1);
  let result = values[0];
  for (let index = 1; index < values.length; index += 1) {
    result = values[index] * multiplier + result * (1 - multiplier);
  }
  return result;
}

function emaSeries(values: number[], period: number) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    result.push(values[index] * multiplier + result[index - 1] * (1 - multiplier));
  }
  return result;
}

function rsi(candles: Candle[], period = 14) {
  if (candles.length <= period) return 50;
  const closes = candles.map((candle) => candle.close);
  const changes = closes.slice(1).map((close, index) => close - closes[index]);
  const recent = changes.slice(-period);
  const gains = average(recent.map((change) => Math.max(change, 0)));
  const losses = average(recent.map((change) => Math.max(-change, 0)));
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}

function atr(candles: Candle[], period = 14) {
  if (candles.length < 2) return 0;
  const ranges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  return average(ranges.slice(-period));
}

function macdHistogram(candles: Candle[]) {
  const closes = candles.map((candle) => candle.close);
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const line = closes.map((_, index) => fast[index] - slow[index]);
  const signal = emaSeries(line, 9);
  return line.at(-1)! - signal.at(-1)!;
}

function timeframeState(interval: string, candles: Candle[]): TimeframeState {
  const closes = candles.map((candle) => candle.close);
  const current = closes.at(-1) ?? 0;
  const e20 = ema(closes.slice(-160), 20);
  const e50 = ema(closes.slice(-240), 50);
  const first = closes.at(-21) ?? closes[0] ?? current;
  const change = first ? ((current - first) / first) * 100 : 0;
  const rsiValue = rsi(candles);
  const bullish = current > e20 && e20 > e50;
  const bearish = current < e20 && e20 < e50;
  return {
    interval,
    label: interval === "1m" ? "1 phút" : interval === "15m" ? "15 phút" : interval === "1h" ? "1 giờ" : "4 giờ",
    bias: bullish ? "Tăng" : bearish ? "Giảm" : "Trung tính",
    rsi: round(rsiValue, 1),
    ema20: round(e20, 8),
    ema50: round(e50, 8),
    change: round(change, 2),
  };
}

function windowFeatures(candles: Candle[], start: number, length: number, scale: number) {
  const window = candles.slice(start, start + length);
  const volumes = window.map((candle) => candle.volume);
  const volumeMean = average(volumes) || 1;
  const safeScale = scale || window.at(-1)?.close || 1;
  const features: number[] = [];

  for (let index = 0; index < window.length; index += 1) {
    const candle = window[index];
    const previous = index === 0 ? candle.open : window[index - 1].close;
    features.push((candle.close - previous) / safeScale);
    features.push((candle.close - candle.open) / safeScale);
    features.push((candle.high - candle.low) / safeScale);
    features.push(Math.log1p(candle.volume / volumeMean));
  }
  return features;
}

function patternSearch(candles: Candle[], patternWindow = 30, forwardBars = 12) {
  const end = candles.length;
  const currentAtr = atr(candles.slice(-80)) || candles.at(-1)!.close * 0.005;
  const currentFeatures = windowFeatures(candles, end - patternWindow, patternWindow, currentAtr);
  const candidates: Array<{ similarity: number; returnPct: number; normalized: number }> = [];

  for (let start = 60; start <= end - patternWindow - forwardBars - 45; start += 2) {
    const localAtr = atr(candles.slice(Math.max(0, start - 40), start + patternWindow)) || currentAtr;
    const features = windowFeatures(candles, start, patternWindow, localAtr);
    let squaredDistance = 0;
    for (let feature = 0; feature < features.length; feature += 1) {
      const difference = currentFeatures[feature] - features[feature];
      squaredDistance += difference * difference;
    }
    const rms = Math.sqrt(squaredDistance / features.length);
    const similarity = 100 * Math.exp(-rms * 1.9);
    const patternClose = candles[start + patternWindow - 1].close;
    const futureClose = candles[start + patternWindow + forwardBars - 1].close;
    const returnPct = patternClose ? ((futureClose - patternClose) / patternClose) * 100 : 0;
    candidates.push({
      similarity,
      returnPct,
      normalized: localAtr ? (futureClose - patternClose) / localAtr : 0,
    });
  }

  const selected = candidates.sort((a, b) => b.similarity - a.similarity).slice(0, 60);
  const weights = selected.map((match) => (match.similarity / 100) ** 4);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;
  selected.forEach((match, index) => {
    const weight = weights[index];
    if (match.normalized > 0.3) bullish += weight;
    else if (match.normalized < -0.3) bearish += weight;
    else neutral += weight;
  });

  return {
    matches: selected.length,
    bullish: (bullish / totalWeight) * 100,
    bearish: (bearish / totalWeight) * 100,
    neutral: (neutral / totalWeight) * 100,
    averageSimilarity: average(selected.map((match) => match.similarity)),
    bestSimilarity: selected[0]?.similarity ?? 0,
    medianForwardReturn: median(selected.map((match) => match.returnPct)),
  };
}

function normalizeDepth(raw: string[][] | undefined, side: "bid" | "ask") {
  const source = raw ?? [];
  const levels: OrderLevel[] = [];
  let running = 0;
  for (const [priceText, quantityText] of source.slice(0, 10)) {
    const price = Number(priceText);
    const quantity = Number(quantityText);
    const value = price * quantity;
    running += value;
    levels.push({ price, quantity, total: running });
  }
  if (side === "ask") levels.sort((a, b) => b.price - a.price);
  return levels;
}

function formatPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${round(value, 2)}%`;
}

export function analyzeMarket(input: {
  symbol: string;
  market: MarketType;
  main: Candle[];
  timeframes: Record<string, Candle[]>;
  ticker: RawTicker;
  funding: RawFunding;
  depth: RawDepth;
}): MarketAnalysis {
  const { symbol, market, main, timeframes, ticker, funding, depth } = input;
  if (main.length < 5000) throw new Error("Không đủ 5.000 nến để chạy mô hình pattern.");

  const closes = main.map((candle) => candle.close);
  const currentPrice = Number(ticker.lastPrice) || closes.at(-1)!;
  const atrValue = atr(main);
  const rsiValue = rsi(main);
  const ema20 = ema(closes.slice(-300), 20);
  const ema50 = ema(closes.slice(-400), 50);
  const ema200 = ema(closes.slice(-800), 200);
  const macd = macdHistogram(main.slice(-400));
  const recentVolume = average(main.slice(-20).map((candle) => candle.volume));
  const baselineVolume = average(main.slice(-120, -20).map((candle) => candle.volume)) || recentVolume || 1;
  const volumeRatio = recentVolume / baselineVolume;
  const pattern = patternSearch(main);

  const bids = normalizeDepth(depth.bids, "bid");
  const asks = normalizeDepth(depth.asks, "ask");
  const bidValue = bids.at(-1)?.total ?? 0;
  const askValue = asks[0]?.total ?? 0;
  const imbalance = bidValue + askValue ? (bidValue - askValue) / (bidValue + askValue) : 0;

  const states = ["1m", "15m", "1h", "4h"].map((interval) =>
    timeframeState(interval, interval === "15m" ? main : timeframes[interval] ?? main),
  );
  const bullishFrames = states.filter((state) => state.bias === "Tăng").length;
  const bearishFrames = states.filter((state) => state.bias === "Giảm").length;
  const trendDirection = bullishFrames > bearishFrames ? 1 : bearishFrames > bullishFrames ? -1 : 0;
  const patternDirection = pattern.bullish > pattern.bearish ? 1 : pattern.bearish > pattern.bullish ? -1 : 0;
  const momentumDirection = rsiValue > 53 && macd > 0 ? 1 : rsiValue < 47 && macd < 0 ? -1 : 0;
  const combinedDirection = patternDirection * 0.5 + trendDirection * 0.3 + momentumDirection * 0.2;

  let signal: Signal = "WAIT";
  if (pattern.bullish >= 54 && combinedDirection >= 0.45) signal = "LONG";
  if (pattern.bearish >= 54 && combinedDirection <= -0.45) signal = "SHORT";

  const direction = signal === "LONG" ? 1 : signal === "SHORT" ? -1 : combinedDirection >= 0 ? 1 : -1;
  const patternEdge = Math.abs(pattern.bullish - pattern.bearish) / 100;
  const patternQuality = clamp((pattern.averageSimilarity - 42) / 35, 0, 1);
  const trendAlignment = Math.max(bullishFrames, bearishFrames) / 4;
  const momentumConfirm = momentumDirection === direction ? 1 : momentumDirection === 0 ? 0.55 : 0.2;
  const volumeConfirm = clamp((volumeRatio - 0.6) / 1.2, 0.25, 1);
  const orderConfirm = clamp(0.55 + direction * imbalance * 1.8, 0.15, 1);
  const fundingRate = funding?.lastFundingRate ? Number(funding.lastFundingRate) : null;
  const fundingConfirm = fundingRate === null
    ? 0.6
    : clamp(0.75 - direction * fundingRate * 700, 0.2, 1);
  const score = Math.round(clamp(
    patternQuality * 24 + patternEdge * 22 + trendAlignment * 18 + momentumConfirm * 14 +
      volumeConfirm * 8 + orderConfirm * 7 + fundingConfirm * 7,
    0,
    100,
  ));
  const consistency = Math.max(pattern.bullish, pattern.bearish, pattern.neutral);
  const confidence = Math.round(clamp(pattern.averageSimilarity * 0.52 + consistency * 0.48, 0, 100));

  const risk = Math.max(atrValue * 1.35, currentPrice * 0.0025);
  const entryPadding = atrValue * 0.22;
  const entryLow = currentPrice - entryPadding;
  const entryHigh = currentPrice + entryPadding;
  const stopLoss = direction > 0 ? currentPrice - risk : currentPrice + risk;
  const takeProfit1 = direction > 0 ? currentPrice + risk * 1.5 : currentPrice - risk * 1.5;
  const takeProfit2 = direction > 0 ? currentPrice + risk * 2.4 : currentPrice - risk * 2.4;

  const probabilities = {
    bullish: round(pattern.bullish, 1),
    neutral: round(pattern.neutral, 1),
    bearish: round(pattern.bearish, 1),
  };
  const signalText = signal === "LONG" ? "ưu tiên LONG" : signal === "SHORT" ? "ưu tiên SHORT" : "đứng ngoài chờ xác nhận";
  const drivers = [
    `${bullishFrames}/4 khung tăng, ${bearishFrames}/4 khung giảm`,
    `RSI 15m ${round(rsiValue, 1)} và MACD histogram ${macd >= 0 ? "dương" : "âm"}`,
    `pattern nghiêng tăng ${probabilities.bullish}% / giảm ${probabilities.bearish}%`,
  ];

  return {
    symbol,
    market,
    generatedAt: Date.now(),
    candlesAnalyzed: main.length,
    patternWindow: 30,
    forwardBars: 12,
    current: {
      price: currentPrice,
      markPrice: funding?.markPrice ? Number(funding.markPrice) : null,
      change24h: Number(ticker.priceChangePercent) || 0,
      quoteVolume24h: Number(ticker.quoteVolume) || 0,
    },
    signal,
    score,
    grade: score >= 82 ? "A" : score >= 70 ? "B+" : score >= 60 ? "B" : score >= 48 ? "C" : "D",
    confidence,
    probabilities,
    setup: {
      entryLow: round(entryLow, 8),
      entryHigh: round(entryHigh, 8),
      stopLoss: round(stopLoss, 8),
      takeProfit1: round(takeProfit1, 8),
      takeProfit2: round(takeProfit2, 8),
      riskReward: 2.4,
    },
    indicators: {
      rsi14: round(rsiValue, 1),
      atr14: round(atrValue, 8),
      atrPercent: round((atrValue / currentPrice) * 100, 2),
      ema20: round(ema20, 8),
      ema50: round(ema50, 8),
      ema200: round(ema200, 8),
      macdHistogram: round(macd, 8),
      volumeRatio: round(volumeRatio, 2),
      orderBookImbalance: round(imbalance * 100, 1),
    },
    funding: {
      rate: fundingRate,
      nextTime: funding?.nextFundingTime ?? null,
      annualized: fundingRate === null ? null : round(fundingRate * 3 * 365 * 100, 2),
    },
    pattern: {
      matches: pattern.matches,
      averageSimilarity: round(pattern.averageSimilarity, 1),
      medianForwardReturn: round(pattern.medianForwardReturn, 2),
      bestSimilarity: round(pattern.bestSimilarity, 1),
      sampleSpanDays: round((main.at(-1)!.time - main[0].time) / 86_400_000, 1),
    },
    timeframes: states,
    orderBook: { bids, asks, bidValue, askValue },
    chartCandles: main.slice(-180),
    chartSeries: {
      "1m": (timeframes["1m"] ?? main).slice(-180),
      "15m": main.slice(-180),
      "1h": (timeframes["1h"] ?? main).slice(-180),
      "4h": (timeframes["4h"] ?? main).slice(-180),
    },
    factors: [
      { label: "Cấu trúc xu hướng", value: drivers[0], state: trendDirection === direction ? "positive" : "neutral" },
      { label: "Động lượng", value: drivers[1], state: momentumDirection === direction ? "positive" : momentumDirection === 0 ? "neutral" : "negative" },
      { label: "Pattern lịch sử", value: `${pattern.matches} mẫu · tương đồng TB ${round(pattern.averageSimilarity, 1)}%`, state: patternEdge >= 0.18 ? "positive" : "neutral" },
      { label: "Volume", value: `${round(volumeRatio, 2)}× trung bình 100 nến`, state: volumeRatio >= 1 ? "positive" : "neutral" },
      { label: "Order book", value: `${imbalance >= 0 ? "Bid" : "Ask"} lệch ${Math.abs(round(imbalance * 100, 1))}%`, state: direction * imbalance > 0.03 ? "positive" : direction * imbalance < -0.03 ? "negative" : "neutral" },
      { label: "Funding", value: fundingRate === null ? "Không áp dụng cho Spot" : `${formatPercent(fundingRate * 100)} / 8h`, state: fundingConfirm > 0.65 ? "positive" : "neutral" },
    ],
    deterministicSummary: `${symbol} hiện ${signalText}. Kết quả được tính trên ${main.length.toLocaleString("vi-VN")} nến 15 phút; ${drivers.join("; ")}. Vùng vô hiệu hóa nằm tại ${round(stopLoss, 8)}.`,
    warnings: [
      "Tín hiệu là phân tích xác suất, không phải lệnh giao dịch hay cam kết lợi nhuận.",
      "Order book là ảnh chụp tức thời và có thể thay đổi nhanh.",
      signal === "WAIT" ? "Điểm đồng thuận chưa đủ để mở vị thế theo bộ quy tắc hiện tại." : "Chỉ cân nhắc vị thế sau khi giá xác nhận trong vùng vào lệnh.",
    ],
  };
}
