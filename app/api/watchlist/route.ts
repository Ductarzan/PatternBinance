import { NextResponse } from "next/server";
import symbolCatalog from "../../../lib/binance-usdt-symbols.json";
import type {
  BaseProbe,
  BaseProbeSignal,
  Candle,
  EntryPlan,
  EntryTrigger,
  MarketType,
  ReversalReadiness,
  ReversalSignal,
  RsiDivergence,
  Signal,
  VolumeAlert,
  VolumeVerdict,
  WatchlistItem,
  WatchlistResponse,
} from "../../../lib/market-types";

const FUTURES_BASE = "https://fapi.binance.com";
const SPOT_BASE = "https://data-api.binance.vision";
const TOP_VOLUME_LIMIT = 200;
const BATCH_SIZE = 15;
const SCAN_CONCURRENCY = 3;
const RSI_HISTORY_LIMIT = 200;
const RSI_PERIOD = 7;
const RSI_OVERSOLD_THRESHOLD = 20;
const RSI_OVERBOUGHT_THRESHOLD = 90;
const DIVERGENCE_LOOKBACK = 80;
const DIVERGENCE_PIVOT_WINDOW = 2;
const DIVERGENCE_RECENT_BARS = 5;
const DIVERGENCE_MIN_GAP = 3;
const REVERSAL_SLOPE_BARS = 3;
const REVERSAL_VOLUME_BASELINE = 20;
const REVERSAL_STRUCTURE_LOOKBACK = 10;
const REVERSAL_READY_SCORE = 65;
const REVERSAL_FORMING_SCORE = 40;
const VOLUME_ALERT_WINDOW = 6;
const VOLUME_ALERT_BASELINE = 20;
const VOLUME_ALERT_SLOPE = 0.08;
const VOLUME_ALERT_PRICE_MOVE = 0.35;
const VOLUME_ALERT_FADE = 0.3;
const VOLUME_ALERT_MIN_STRENGTH = 35;
const VOLUME_ALERT_LIMIT = 3;
const VOLUME_VERDICT_CONFLICT = 0.6;
const BASE_LOOKBACK = 60;
const BASE_PIVOT_WINDOW = 2;
const BASE_MIN_TOUCHES = 3;
const BASE_MIN_SPAN = 8;
const BASE_RANGE_POSITION = 0.3;
const BASE_TRAP_LOOKBACK = 15;
// Giá phải còn nằm quanh nền mới gọi là đang dò; chạy xa rồi thì hết actionable.
const BASE_PROXIMITY_TOLERANCE = 3;
const BASE_PROBE_READY_SCORE = 75;
const BASE_PROBE_FORMING_SCORE = 58;
const BASE_PROBE_MIN_SCORE = 58;
const DEPTH_LIMIT = 20;
const ORDER_BOOK_LEVELS = 20;
const ORDER_BOOK_ALERT_THRESHOLD = 20;
// Khung 1m chỉ dùng để bấm giờ điểm vào, không dùng để lọc coin (xem probeMethodology).
const ENTRY_HISTORY_LIMIT = 99;
const ENTRY_EMA_PERIOD = 9;
const ENTRY_STRUCTURE_BARS = 3;
const ENTRY_SWING_BARS = 10;
const ENTRY_VOLUME_BARS = 20;
const ENTRY_VOLUME_RATIO = 1.2;
const ENTRY_RSI_TURN = 2;
const ENTRY_LATE_ATR = 1.8;
// Stop sát hơn 1 ATR(1m) là nằm trong vùng nhiễu, vào bao nhiêu quét bấy nhiêu.
const ENTRY_ATR_STOP = 1.2;
const ENTRY_MIN_RISK = 0.2;
const ENTRY_REWARD = 2;
const CACHE_TTL_MS = 90_000;

const cache = new Map<string, { expires: number; data: WatchlistResponse }>();
type MarketSnapshot = {
  generatedAt: number;
  topTickers: Array<Record<string, string>>;
  fundingMap: Map<string, number>;
};
const snapshotCache = new Map<MarketType, { expires: number; data: MarketSnapshot }>();
const snapshotPending = new Map<MarketType, Promise<MarketSnapshot>>();

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const average = (values: number[]) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;

async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "PatternDesk/1.0" },
      cache: "no-store",
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Binance ${response.status}: ${message.slice(0, 180)}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function toCandle(row: Array<string | number>): Candle {
  return {
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

async function fetchKlines(market: MarketType, symbol: string, interval: string, limit: number) {
  const futures = market === "futures";
  const base = futures ? FUTURES_BASE : SPOT_BASE;
  const path = futures ? "/fapi/v1/klines" : "/api/v3/klines";
  const rows = await getJson<Array<Array<string | number>>>(
    `${base}${path}?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  );
  return rows.map(toCandle);
}

async function fetchDepth(market: MarketType, symbol: string) {
  const futures = market === "futures";
  const base = futures ? FUTURES_BASE : SPOT_BASE;
  const path = futures ? "/fapi/v1/depth" : "/api/v3/depth";
  return getJson<{ bids?: string[][]; asks?: string[][] }>(
    `${base}${path}?symbol=${symbol}&limit=${DEPTH_LIMIT}`,
  );
}

function orderBookImbalance(depth: { bids?: string[][]; asks?: string[][] }) {
  const sumSide = (side: string[][] | undefined) => (side ?? [])
    .slice(0, ORDER_BOOK_LEVELS)
    .reduce((sum, [price, quantity]) => sum + Number(price) * Number(quantity), 0);
  const bidValue = sumSide(depth.bids);
  const askValue = sumSide(depth.asks);
  const total = bidValue + askValue;
  return { bidValue, askValue, imbalance: total ? ((bidValue - askValue) / total) * 100 : 0 };
}

async function getMarketSnapshot(market: MarketType) {
  const cached = snapshotCache.get(market);
  if (cached && cached.expires > Date.now()) return cached.data;
  const pending = snapshotPending.get(market);
  if (pending) return pending;

  const request = (async () => {
    const futures = market === "futures";
    const base = futures ? FUTURES_BASE : SPOT_BASE;
    const tickerPath = futures ? "/fapi/v1/ticker/24hr" : "/api/v3/ticker/24hr";
    const [tickers, funding] = await Promise.all([
      getJson<Array<Record<string, string>>>(`${base}${tickerPath}`),
      futures
        ? getJson<Array<Record<string, string>>>(`${base}/fapi/v1/premiumIndex`)
        : Promise.resolve([]),
    ]);
    const availableSymbols = new Set(symbolCatalog[market]);
    const data: MarketSnapshot = {
      generatedAt: Date.now(),
      topTickers: tickers
        .filter((ticker) => availableSymbols.has(ticker.symbol) && Number(ticker.quoteVolume) > 0)
        .sort((left, right) => Number(right.quoteVolume) - Number(left.quoteVolume))
        .slice(0, TOP_VOLUME_LIMIT),
      fundingMap: new Map(funding.map((item) => [item.symbol, Number(item.lastFundingRate)])),
    };
    snapshotCache.set(market, { expires: Date.now() + CACHE_TTL_MS, data });
    return data;
  })();
  snapshotPending.set(market, request);
  try {
    return await request;
  } finally {
    snapshotPending.delete(market);
  }
}

async function mapSettledWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
) {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function ema(values: number[], period: number) {
  if (!values.length) return 0;
  const multiplier = 2 / (period + 1);
  let result = values[0];
  for (let index = 1; index < values.length; index += 1) {
    result = values[index] * multiplier + result * (1 - multiplier);
  }
  return result;
}

function rsiSeries(candles: Candle[], period = RSI_PERIOD) {
  const values = new Array<number>(candles.length).fill(50);
  if (candles.length <= period) return values;
  const closes = candles.map((candle) => candle.close);
  const changes = closes.slice(1).map((close, index) => close - closes[index]);
  let averageGain = average(changes.slice(0, period).map((change) => Math.max(change, 0)));
  let averageLoss = average(changes.slice(0, period).map((change) => Math.max(-change, 0)));
  const toRsi = () => !averageLoss ? (averageGain ? 100 : 50) : 100 - 100 / (1 + averageGain / averageLoss);
  values[period] = toRsi();
  changes.slice(period).forEach((change, offset) => {
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    values[period + offset + 1] = toRsi();
  });
  return values;
}

function rsi(candles: Candle[], period = RSI_PERIOD) {
  return rsiSeries(candles, period).at(-1) ?? 50;
}

function findRsiDivergence(
  candles: Candle[],
  frame: RsiDivergence["frame"],
  kind: "bullish" | "bearish",
): RsiDivergence | null {
  if (candles.length <= RSI_PERIOD + DIVERGENCE_MIN_GAP) return null;
  const values = rsiSeries(candles);
  const recentStart = Math.max(RSI_PERIOD, candles.length - DIVERGENCE_RECENT_BARS);
  let currentIndex = recentStart;
  for (let index = recentStart + 1; index < candles.length; index += 1) {
    const isMoreExtreme = kind === "bullish"
      ? candles[index].low < candles[currentIndex].low
      : candles[index].high > candles[currentIndex].high;
    if (isMoreExtreme) currentIndex = index;
  }

  const currentPrice = kind === "bullish" ? candles[currentIndex].low : candles[currentIndex].high;
  const currentRsi = values[currentIndex];
  const isAtRsiExtreme = kind === "bullish"
    ? currentRsi < RSI_OVERSOLD_THRESHOLD
    : currentRsi > RSI_OVERBOUGHT_THRESHOLD;
  if (!isAtRsiExtreme) return null;

  const searchStart = Math.max(
    RSI_PERIOD + DIVERGENCE_PIVOT_WINDOW,
    candles.length - DIVERGENCE_LOOKBACK,
  );
  for (let index = currentIndex - DIVERGENCE_MIN_GAP; index >= searchStart; index -= 1) {
    const candlePrice = kind === "bullish" ? candles[index].low : candles[index].high;
    let isPivot = true;
    for (let offset = 1; offset <= DIVERGENCE_PIVOT_WINDOW; offset += 1) {
      const leftPrice = kind === "bullish" ? candles[index - offset].low : candles[index - offset].high;
      const rightPrice = kind === "bullish" ? candles[index + offset].low : candles[index + offset].high;
      if (kind === "bullish" ? candlePrice > leftPrice || candlePrice > rightPrice : candlePrice < leftPrice || candlePrice < rightPrice) {
        isPivot = false;
        break;
      }
    }
    if (!isPivot) continue;

    const priceConfirms = kind === "bullish" ? currentPrice < candlePrice : currentPrice > candlePrice;
    const rsiConfirms = kind === "bullish" ? currentRsi > values[index] : currentRsi < values[index];
    if (priceConfirms && rsiConfirms) {
      const rsiGap = Math.abs(currentRsi - values[index]);
      const priceGapPercent = candlePrice
        ? Math.abs((currentPrice - candlePrice) / candlePrice) * 100
        : 0;
      const barsApart = currentIndex - index;
      const strength = Math.round(clamp(
        clamp(rsiGap / 12) * 55 +
          clamp(priceGapPercent / 4) * 25 +
          clamp((barsApart - DIVERGENCE_MIN_GAP) / 25) * 20,
        0,
        1,
      ) * 100);
      return {
        frame,
        previousPrice: candlePrice,
        currentPrice,
        previousRsi: round(values[index], 1),
        currentRsi: round(currentRsi, 1),
        barsApart,
        rsiGap: round(rsiGap, 1),
        priceGapPercent: round(priceGapPercent, 2),
        strength,
      };
    }
  }
  return null;
}

function detectReversalCandle(candles: Candle[], kind: "bullish" | "bearish") {
  const last = candles.at(-1);
  const previous = candles.at(-2);
  if (!last || !previous) return null;
  const range = last.high - last.low;
  if (range <= 0) return null;
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const previousBody = Math.abs(previous.close - previous.open);
  const previousBearish = previous.close < previous.open;
  const previousBullish = previous.close > previous.open;

  if (kind === "bullish") {
    if (last.close > last.open && previousBearish && last.close >= previous.open && last.open <= previous.close && body > previousBody * 0.9) {
      return "Nến nhấn chìm tăng";
    }
    if (lowerWick >= body * 2 && lowerWick / range >= 0.5 && upperWick / range <= 0.25) {
      return "Nến búa (bóng dưới dài)";
    }
    if (last.close > last.open && body / range <= 0.25 && lowerWick / range >= 0.35) {
      return "Doji chân dài đáy";
    }
    if (previousBearish && last.close > last.open && last.close > (previous.open + previous.close) / 2) {
      return "Nến xuyên thấu (piercing)";
    }
    return null;
  }

  if (last.close < last.open && previousBullish && last.close <= previous.open && last.open >= previous.close && body > previousBody * 0.9) {
    return "Nến nhấn chìm giảm";
  }
  if (upperWick >= body * 2 && upperWick / range >= 0.5 && lowerWick / range <= 0.25) {
    return "Nến sao băng (bóng trên dài)";
  }
  if (last.close < last.open && body / range <= 0.25 && upperWick / range >= 0.35) {
    return "Doji chân dài đỉnh";
  }
  if (previousBullish && last.close < last.open && last.close < (previous.open + previous.close) / 2) {
    return "Nến mây đen che phủ";
  }
  return null;
}

function assessReversal(input: {
  candles: Candle[];
  frame: RsiDivergence["frame"];
  kind: "bullish" | "bearish";
  divergences: RsiDivergence[];
}): ReversalReadiness {
  const { candles, kind, divergences } = input;
  const empty: ReversalReadiness = {
    direction: "none",
    score: 0,
    stage: "Chưa có",
    signals: [],
    candlePattern: null,
    rsiSlope: 0,
    volumeSpike: 0,
  };
  if (candles.length <= RSI_PERIOD + REVERSAL_SLOPE_BARS) return empty;

  const bullish = kind === "bullish";
  const values = rsiSeries(candles);
  const currentRsi = values.at(-1) ?? 50;
  const pastRsi = values.at(-1 - REVERSAL_SLOPE_BARS) ?? currentRsi;
  const troughRsi = bullish
    ? Math.min(...values.slice(-REVERSAL_SLOPE_BARS - 1))
    : Math.max(...values.slice(-REVERSAL_SLOPE_BARS - 1));
  const rsiSlope = currentRsi - pastRsi;
  const signals: ReversalSignal[] = [];

  if (divergences.length) {
    const best = divergences.reduce((left, right) => (right.strength > left.strength ? right : left));
    signals.push({
      key: "divergence",
      label: bullish ? "Phân kỳ tăng" : "Phân kỳ giảm",
      detail: `${best.frame} · RSI lệch ${best.rsiGap} điểm qua ${best.barsApart} nến`,
      weight: 18 + Math.round((best.strength / 100) * 10),
    });
  }
  if (divergences.length >= 2) {
    signals.push({
      key: "multiFrameDivergence",
      label: "Phân kỳ đa khung",
      detail: divergences.map((item) => item.frame).join(" · "),
      weight: 12,
    });
  }

  const turnAmount = bullish ? currentRsi - troughRsi : troughRsi - currentRsi;
  if (turnAmount >= 2 && (bullish ? rsiSlope > 0 : rsiSlope < 0)) {
    signals.push({
      key: "rsiTurn",
      label: bullish ? "RSI bẻ lên khỏi đáy" : "RSI bẻ xuống khỏi đỉnh",
      detail: `RSI ${round(troughRsi, 1)} → ${round(currentRsi, 1)}`,
      weight: Math.min(20, 8 + Math.round(turnAmount)),
    });
  }

  const exitedExtreme = bullish
    ? currentRsi >= RSI_OVERSOLD_THRESHOLD && troughRsi < RSI_OVERSOLD_THRESHOLD
    : currentRsi <= RSI_OVERBOUGHT_THRESHOLD && troughRsi > RSI_OVERBOUGHT_THRESHOLD;
  if (exitedExtreme) {
    signals.push({
      key: "rsiExitExtreme",
      label: bullish ? "RSI thoát vùng quá bán" : "RSI thoát vùng quá mua",
      detail: `RSI(7) hiện ${round(currentRsi, 1)}`,
      weight: 10,
    });
  }

  const candlePattern = detectReversalCandle(candles, kind);
  if (candlePattern) {
    signals.push({
      key: "reversalCandle",
      label: candlePattern,
      detail: "Nến gần nhất xác nhận lực đảo chiều",
      weight: 16,
    });
  }

  const lastVolume = candles.at(-1)?.volume ?? 0;
  const baselineVolume = average(
    candles.slice(-REVERSAL_VOLUME_BASELINE - 1, -1).map((candle) => candle.volume),
  ) || 1;
  const volumeSpike = lastVolume / baselineVolume;
  if (volumeSpike >= 1.6) {
    signals.push({
      key: "volumeClimax",
      label: "Volume climax",
      detail: `Volume ${round(volumeSpike, 2)}× trung bình ${REVERSAL_VOLUME_BASELINE} nến`,
      weight: volumeSpike >= 2.5 ? 14 : 9,
    });
  }

  const last = candles.at(-1);
  if (last) {
    const range = last.high - last.low;
    const wick = bullish
      ? Math.min(last.close, last.open) - last.low
      : last.high - Math.max(last.close, last.open);
    if (range > 0 && wick / range >= 0.45 && candlePattern === null) {
      signals.push({
        key: "rejectionWick",
        label: bullish ? "Bóng nến từ chối đáy" : "Bóng nến từ chối đỉnh",
        detail: `Bóng chiếm ${Math.round((wick / range) * 100)}% biên độ nến`,
        weight: 8,
      });
    }
  }

  const closes = candles.map((candle) => candle.close);
  const ema20 = ema(closes, 20);
  const currentClose = closes.at(-1) ?? 0;
  const previousClose = closes.at(-2) ?? currentClose;
  const reclaimed = bullish
    ? previousClose < ema20 && currentClose >= ema20
    : previousClose > ema20 && currentClose <= ema20;
  if (reclaimed) {
    signals.push({
      key: "emaReclaim",
      label: bullish ? "Giá lấy lại EMA20" : "Giá mất EMA20",
      detail: `EMA20 ${round(ema20, 6)}`,
      weight: 11,
    });
  }

  const structureWindow = candles.slice(-REVERSAL_STRUCTURE_LOOKBACK - 1, -1);
  if (structureWindow.length) {
    const swingHigh = Math.max(...structureWindow.map((candle) => candle.high));
    const swingLow = Math.min(...structureWindow.map((candle) => candle.low));
    const broke = bullish ? currentClose > swingHigh : currentClose < swingLow;
    if (broke) {
      signals.push({
        key: "structureBreak",
        label: bullish ? "Phá swing high gần nhất" : "Phá swing low gần nhất",
        detail: `Mốc ${round(bullish ? swingHigh : swingLow, 6)} trong ${REVERSAL_STRUCTURE_LOOKBACK} nến`,
        weight: 12,
      });
    }
  }

  if (!signals.length) return { ...empty, rsiSlope: round(rsiSlope, 1), volumeSpike: round(volumeSpike, 2) };

  const score = Math.round(clamp(
    signals.reduce((sum, signal) => sum + signal.weight, 0),
    0,
    100,
  ));
  const stage = score >= REVERSAL_READY_SCORE
    ? "Sắp đảo chiều"
    : score >= REVERSAL_FORMING_SCORE
      ? "Đang hình thành"
      : "Yếu";

  return {
    direction: kind,
    score,
    stage,
    signals: signals.sort((left, right) => right.weight - left.weight),
    candlePattern,
    rsiSlope: round(rsiSlope, 1),
    volumeSpike: round(volumeSpike, 2),
  };
}

function normalizedSlope(values: number[]) {
  if (values.length < 3) return 0;
  const meanIndex = (values.length - 1) / 2;
  const meanValue = average(values);
  if (!meanValue) return 0;
  let covariance = 0;
  let variance = 0;
  values.forEach((value, index) => {
    covariance += (index - meanIndex) * (value - meanValue);
    variance += (index - meanIndex) ** 2;
  });
  if (!variance) return 0;
  return covariance / variance / meanValue;
}

function detectVolumeAlerts(candles: Candle[], frame: RsiDivergence["frame"]): VolumeAlert[] {
  const window = candles.slice(-VOLUME_ALERT_WINDOW);
  if (window.length < VOLUME_ALERT_WINDOW) return [];
  const volumes = window.map((candle) => candle.volume);
  const baseline = average(
    candles.slice(-VOLUME_ALERT_BASELINE - VOLUME_ALERT_WINDOW, -VOLUME_ALERT_WINDOW)
      .map((candle) => candle.volume),
  ) || average(volumes);
  if (!baseline) return [];

  const volumeSlope = normalizedSlope(volumes);
  const startPrice = window[0].open || window[0].close;
  const endPrice = window.at(-1)!.close;
  const priceMove = startPrice ? ((endPrice - startPrice) / startPrice) * 100 : 0;
  const half = Math.floor(window.length / 2);
  const early = window.slice(0, half);
  const late = window.slice(half);
  const sumVolume = (list: Candle[], kind: "buy" | "sell") => list
    .filter((candle) => kind === "buy" ? candle.close > candle.open : candle.close < candle.open)
    .reduce((sum, candle) => sum + candle.volume, 0);
  const earlyBuy = sumVolume(early, "buy");
  const lateBuy = sumVolume(late, "buy");
  const earlySell = sumVolume(early, "sell");
  const lateSell = sumVolume(late, "sell");
  const buyFade = earlyBuy ? clamp(1 - lateBuy / earlyBuy) : 0;
  const sellFade = earlySell ? clamp(1 - lateSell / earlySell) : 0;
  const greenBars = window.filter((candle) => candle.close > candle.open).length;
  const redBars = window.filter((candle) => candle.close < candle.open).length;
  const relativeVolume = average(volumes) / baseline;
  const slopePercent = round(Math.abs(volumeSlope) * 100, 1);
  const bars = window.length;
  const alerts: VolumeAlert[] = [];
  const strengthOf = (parts: number[]) => Math.round(clamp(
    30 + parts.reduce((sum, part) => sum + part, 0),
    0,
    100,
  ));
  const context = `${bars} nến ${frame} gần nhất`;

  const riseVolumeFade = priceMove >= VOLUME_ALERT_PRICE_MOVE
    && greenBars >= redBars
    && (volumeSlope <= -VOLUME_ALERT_SLOPE || buyFade >= VOLUME_ALERT_FADE);
  if (riseVolumeFade) {
    alerts.push({
      key: "riseVolumeFade",
      frame,
      bias: "bearish",
      action: "SHORT",
      label: "Giá tăng, lực mua yếu dần",
      detail: `${context}: giá +${round(priceMove, 2)}% nhưng volume ${volumeSlope < 0 ? `giảm dần ${slopePercent}%/nến` : "đi ngang"}, volume mua 3 nến cuối thấp hơn 3 nến trước ${Math.round(buyFade * 100)}%`,
      conclusion: "Tăng mà không có tiền vào → dễ quay đầu, canh SHORT",
      strength: strengthOf([
        clamp(priceMove / 2.5) * 25,
        clamp(-volumeSlope / 0.3) * 25,
        clamp(buyFade / 0.6) * 20,
      ]),
    });
  }

  if ((priceMove <= -VOLUME_ALERT_PRICE_MOVE || redBars > greenBars) && sellFade >= VOLUME_ALERT_FADE) {
    alerts.push({
      key: "supplyDryUp",
      frame,
      bias: "bullish",
      action: "LONG",
      label: "Giá giảm, lực bán yếu dần",
      detail: `${context}: ${redBars}/${bars} nến đỏ (giá ${round(priceMove, 2)}%) nhưng volume bán 3 nến cuối giảm ${Math.round(sellFade * 100)}% so với 3 nến trước`,
      conclusion: "Người bán đã đuối → chờ LONG khi giá bật lại",
      strength: strengthOf([
        clamp(sellFade / 0.7) * 35,
        clamp(-priceMove / 2.5) * 15,
        clamp(redBars / bars) * 20,
      ]),
    });
  }

  if (!riseVolumeFade && greenBars > redBars && buyFade >= VOLUME_ALERT_FADE && priceMove < VOLUME_ALERT_PRICE_MOVE) {
    alerts.push({
      key: "demandDryUp",
      frame,
      bias: "bearish",
      action: "SHORT",
      label: "Nến xanh nhưng ít người mua",
      detail: `${context}: ${greenBars}/${bars} nến xanh nhưng volume mua giảm ${Math.round(buyFade * 100)}% và giá gần như đứng yên (${round(priceMove, 2)}%)`,
      conclusion: "Hết người mua đuổi → tránh vào LONG, canh SHORT",
      strength: strengthOf([
        clamp(buyFade / 0.7) * 30,
        clamp(greenBars / bars) * 15,
        clamp((1 - Math.abs(priceMove) / 1.5)) * 15,
      ]),
    });
  }

  if (priceMove <= 0 && earlyBuy && lateBuy >= earlyBuy * 1.3 && lateBuy >= lateSell) {
    alerts.push({
      key: "buyAbsorption",
      frame,
      bias: "bullish",
      action: "LONG",
      label: "Giá giảm nhưng người mua vào mạnh",
      detail: `${context}: giá ${round(priceMove, 2)}% nhưng volume mua 3 nến cuối gấp ${round(lateBuy / earlyBuy, 2)}× 3 nến trước và lấn át bên bán`,
      conclusion: "Có lực đỡ giá ở vùng này → canh LONG",
      strength: strengthOf([
        clamp((lateBuy / earlyBuy - 1) / 1.2) * 30,
        clamp(relativeVolume / 2) * 20,
      ]),
    });
  }

  if (priceMove >= VOLUME_ALERT_PRICE_MOVE && volumeSlope >= VOLUME_ALERT_SLOPE && lateBuy > lateSell) {
    alerts.push({
      key: "riseVolumeConfirm",
      frame,
      bias: "bullish",
      action: "LONG",
      label: "Giá tăng cùng volume",
      detail: `${context}: giá +${round(priceMove, 2)}%, volume tăng dần ${slopePercent}%/nến và bên mua áp đảo`,
      conclusion: "Đà tăng có tiền thật đỡ → theo LONG",
      strength: strengthOf([
        clamp(priceMove / 2.5) * 20,
        clamp(volumeSlope / 0.3) * 25,
        clamp(relativeVolume / 2) * 15,
      ]),
    });
  }

  if (priceMove <= -VOLUME_ALERT_PRICE_MOVE && volumeSlope >= VOLUME_ALERT_SLOPE && lateSell > lateBuy) {
    alerts.push({
      key: "sellPressureBuilding",
      frame,
      bias: "bearish",
      action: "SHORT",
      label: "Giá giảm, lực bán mạnh thêm",
      detail: `${context}: giá ${round(priceMove, 2)}%, volume tăng dần ${slopePercent}%/nến và bên bán áp đảo`,
      conclusion: "Còn nhiều hàng xả → chưa bắt đáy, theo SHORT",
      strength: strengthOf([
        clamp(-priceMove / 2.5) * 20,
        clamp(volumeSlope / 0.3) * 25,
        clamp(relativeVolume / 2) * 15,
      ]),
    });
  }

  return alerts.filter((alert) => alert.strength >= VOLUME_ALERT_MIN_STRENGTH);
}

function collectVolumeAlerts(frames: Array<{ frame: RsiDivergence["frame"]; candles: Candle[] }>) {
  const strongest = new Map<string, VolumeAlert>();
  frames
    .flatMap(({ frame, candles }) => detectVolumeAlerts(candles, frame))
    .forEach((alert) => {
      const current = strongest.get(alert.key);
      if (!current || alert.strength > current.strength) strongest.set(alert.key, alert);
    });
  return [...strongest.values()]
    .sort((left, right) => right.strength - left.strength)
    .slice(0, VOLUME_ALERT_LIMIT);
}

function volumeAlertBias(alerts: VolumeAlert[], kind: "bullish" | "bearish") {
  return alerts
    .filter((alert) => alert.bias === kind)
    .reduce((sum, alert) => sum + alert.strength, 0);
}

function orderBookNote(imbalance: number, bias: "bullish" | "bearish" | "mixed" | "none") {
  if (Math.abs(imbalance) < ORDER_BOOK_ALERT_THRESHOLD) return null;
  const bookBias: "bullish" | "bearish" = imbalance > 0 ? "bullish" : "bearish";
  const side = bookBias === "bullish" ? "lệch mua" : "lệch bán";
  const meaning = bookBias === "bullish" ? "có lệnh chờ đỡ giá phía dưới" : "có lệnh chờ chặn giá phía trên";
  if (bias === "none" || bias === "mixed") {
    return `Order book đang ${side} ${Math.round(Math.abs(imbalance))}% (${meaning}).`;
  }
  return bookBias === bias
    ? `Order book cũng ${side} ${Math.round(Math.abs(imbalance))}%, cùng chiều với volume.`
    : `Nhưng order book lại ${side} ${Math.round(Math.abs(imbalance))}%, trái chiều với volume — nên thận trọng hơn.`;
}

function buildVolumeVerdict(alerts: VolumeAlert[], orderBookImbalanceValue: number): VolumeVerdict {
  if (!alerts.length) {
    if (Math.abs(orderBookImbalanceValue) >= ORDER_BOOK_ALERT_THRESHOLD) {
      const bookBias: "bullish" | "bearish" = orderBookImbalanceValue > 0 ? "bullish" : "bearish";
      const side = bookBias === "bullish" ? "lệch mua" : "lệch bán";
      const meaning = bookBias === "bullish" ? "có lệnh chờ đỡ giá phía dưới" : "có lệnh chờ chặn giá phía trên";
      return {
        bias: bookBias,
        headline: bookBias === "bullish" ? "Order book lệch mua" : "Order book lệch bán",
        detail: `Sổ lệnh đang ${side} ${Math.round(Math.abs(orderBookImbalanceValue))}% (${meaning}). Volume chưa cho tín hiệu rõ ràng.`,
        confidence: Math.abs(orderBookImbalanceValue) >= 40 ? "Vừa" : "Nhẹ",
      };
    }
    return {
      bias: "none",
      headline: "Chưa có tín hiệu",
      detail: "Giá, volume và order book đang cân bằng, chưa có dấu hiệu lệch pha đáng chú ý.",
      confidence: "—",
    };
  }

  const bullish = alerts.filter((alert) => alert.bias === "bullish");
  const bearish = alerts.filter((alert) => alert.bias === "bearish");
  const bullishScore = volumeAlertBias(alerts, "bullish");
  const bearishScore = volumeAlertBias(alerts, "bearish");
  const weaker = Math.min(bullishScore, bearishScore);
  const stronger = Math.max(bullishScore, bearishScore);

  if (weaker && weaker / stronger >= VOLUME_VERDICT_CONFLICT) {
    return {
      bias: "mixed",
      headline: "Volume đang mâu thuẫn",
      detail: `Khung ${bullish.map((alert) => alert.frame).join("/")} cho tín hiệu mua, khung ${bearish.map((alert) => alert.frame).join("/")} cho tín hiệu bán. Nên đứng ngoài chờ một bên thắng thế.`,
      confidence: "—",
    };
  }

  const leading = (bullishScore > bearishScore ? bullish : bearish)
    .reduce((left, right) => (right.strength > left.strength ? right : left));
  const note = orderBookNote(orderBookImbalanceValue, leading.bias);
  return {
    bias: leading.bias,
    headline: leading.bias === "bullish" ? "Volume ủng hộ phe mua" : "Volume ủng hộ phe bán",
    detail: `${leading.label} trên khung ${leading.frame}. ${leading.conclusion}.${note ? ` ${note}` : ""}`,
    confidence: leading.strength >= 70 ? "Mạnh" : leading.strength >= 50 ? "Vừa" : "Nhẹ",
  };
}

function findPivots(candles: Candle[], kind: "low" | "high", pivotWindow: number) {
  const indexes: number[] = [];
  const priceAt = (index: number) => kind === "low" ? candles[index].low : candles[index].high;
  for (let index = pivotWindow; index < candles.length - pivotWindow; index += 1) {
    const price = priceAt(index);
    let isPivot = true;
    for (let offset = 1; offset <= pivotWindow; offset += 1) {
      const left = priceAt(index - offset);
      const right = priceAt(index + offset);
      if (kind === "low" ? price > left || price > right : price < left || price < right) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) indexes.push(index);
  }
  return indexes;
}

const emptyBaseProbe: BaseProbe = {
  direction: "none",
  frame: "15m",
  score: 0,
  stage: "Chưa có",
  level: 0,
  invalidation: 0,
  touches: 0,
  spanBars: 0,
  headline: "Chưa thấy nền giá",
  detail: "Giá chưa test lại cùng một vùng đủ số lần để coi là đang dò đáy hay dò đỉnh.",
  signals: [],
};

function assessBaseProbe(
  candles: Candle[],
  frame: RsiDivergence["frame"],
  kind: "bottom" | "top",
): BaseProbe | null {
  if (candles.length < BASE_LOOKBACK) return null;
  const window = candles.slice(-BASE_LOOKBACK);
  const bottom = kind === "bottom";
  const lows = window.map((candle) => candle.low);
  const highs = window.map((candle) => candle.high);
  const windowLow = Math.min(...lows);
  const windowHigh = Math.max(...highs);
  const range = windowHigh - windowLow;
  if (range <= 0) return null;

  const priceAt = (index: number) => bottom ? lows[index] : highs[index];
  const pivots = findPivots(window, bottom ? "low" : "high", BASE_PIVOT_WINDOW);
  // Pivot ở sát mép phải chưa đủ nến để xác nhận, nên lấy thêm mốc cực trị của đuôi.
  const tailStart = Math.max(0, window.length - BASE_PIVOT_WINDOW - 1);
  let tailIndex = tailStart;
  for (let index = tailStart + 1; index < window.length; index += 1) {
    if (bottom ? lows[index] < lows[tailIndex] : highs[index] > highs[tailIndex]) tailIndex = index;
  }
  const candidates = [...new Set([...pivots, tailIndex])].sort((left, right) => left - right);
  if (candidates.length < BASE_MIN_TOUCHES) return null;

  const extreme = bottom
    ? Math.min(...candidates.map(priceAt))
    : Math.max(...candidates.map(priceAt));
  if (!extreme) return null;
  const position = (extreme - windowLow) / range;
  if (bottom ? position > BASE_RANGE_POSITION : position < 1 - BASE_RANGE_POSITION) return null;

  const volatility = atrPercent(window);
  const tolerance = clamp(volatility * 0.9, 0.6, 4);
  const bandLimit = bottom
    ? extreme * (1 + tolerance / 100)
    : extreme * (1 - tolerance / 100);
  const touches = candidates.filter((index) => bottom
    ? priceAt(index) <= bandLimit
    : priceAt(index) >= bandLimit);
  if (touches.length < BASE_MIN_TOUCHES) return null;
  const spanBars = touches.at(-1)! - touches[0];
  if (spanBars < BASE_MIN_SPAN) return null;

  const level = average(touches.map(priceAt));
  if (!level) return null;

  const closes = window.map((candle) => candle.close);
  const currentClose = closes.at(-1)!;
  // Giá đã rời nền quá xa thì đây là hậu quả của nền cũ, không còn là vùng đang dò.
  const distance = ((currentClose - level) / level) * 100;
  const maxDistance = tolerance * BASE_PROXIMITY_TOLERANCE;
  if (bottom ? distance > maxDistance || distance < -tolerance : distance < -maxDistance || distance > tolerance) {
    return null;
  }

  const signals: BaseProbeSignal[] = [];
  const touchCount = touches.length;
  signals.push({
    key: "levelRetest",
    label: bottom ? `Test lại vùng đáy ${touchCount} lần` : `Test lại vùng đỉnh ${touchCount} lần`,
    detail: `Vùng ${round(level, 6)} bị chạm ${touchCount} lần trong ${spanBars} nến ${frame} mà không đi xa hơn.`,
    weight: touchCount >= 5 ? 22 : touchCount === 4 ? 20 : 16,
  });

  const firstTouch = priceAt(touches[0]);
  const lastTouch = priceAt(touches.at(-1)!);
  const drift = ((lastTouch - firstTouch) / level) * 100;
  if (bottom ? drift > 0.15 : drift < -0.15) {
    signals.push({
      key: bottom ? "higherLows" : "lowerHighs",
      label: bottom ? "Đáy sau cao hơn đáy trước" : "Đỉnh sau thấp hơn đỉnh trước",
      detail: `${round(firstTouch, 6)} → ${round(lastTouch, 6)} (${round(drift, 2)}%), bên ${bottom ? "mua" : "bán"} đang lấn dần.`,
      weight: 16,
    });
  }

  const baseSlice = window.slice(touches[0], touches.at(-1)! + 1);
  const halfPoint = Math.floor(baseSlice.length / 2);
  const earlyVolume = average(baseSlice.slice(0, halfPoint).map((candle) => candle.volume));
  const lateVolume = average(baseSlice.slice(halfPoint).map((candle) => candle.volume));
  const contraction = earlyVolume ? clamp(1 - lateVolume / earlyVolume) : 0;
  if (contraction >= 0.3) {
    signals.push({
      key: "volumeContraction",
      label: bottom ? "Volume cạn dần trong nền" : "Volume cạn dần ở đỉnh",
      detail: `Volume nửa sau của nền thấp hơn nửa đầu ${Math.round(contraction * 100)}% — ${bottom ? "người bán hết hàng để xả" : "người mua hết mặn mà"}.`,
      weight: contraction >= 0.45 ? 15 : 11,
    });
  }

  const trapStart = Math.max(touches[0], window.length - BASE_TRAP_LOOKBACK);
  let trapPierce = 0;
  for (let index = trapStart; index < window.length; index += 1) {
    const candle = window[index];
    const pierced = bottom ? candle.low < level * 0.9985 : candle.high > level * 1.0015;
    const closedBack = bottom ? candle.close > level : candle.close < level;
    if (!pierced || !closedBack) continue;
    const pierce = bottom
      ? ((level - candle.low) / level) * 100
      : ((candle.high - level) / level) * 100;
    if (pierce > trapPierce) trapPierce = pierce;
  }
  if (trapPierce > 0) {
    signals.push({
      key: bottom ? "failedBreakdown" : "failedBreakout",
      label: bottom ? "Phá đáy giả rồi bật lại" : "Phá đỉnh giả rồi tụt lại",
      detail: `Có nến ${bottom ? "thủng nền" : "vượt nền"} ${round(trapPierce, 2)}% nhưng đóng cửa lại ${bottom ? "trên" : "dưới"} vùng ${round(level, 6)} — bẫy ${bottom ? "giảm" : "tăng"}.`,
      weight: 18,
    });
  }

  const recentAtr = atrPercent(window.slice(-10), 8);
  const baseAtr = atrPercent(baseSlice) || recentAtr;
  const compression = baseAtr ? clamp(1 - recentAtr / baseAtr) : 0;
  if (compression >= 0.3) {
    signals.push({
      key: "rangeCompression",
      label: "Biên độ nến co lại",
      detail: `Biên độ 10 nến gần nhất hẹp hơn cả nền ${Math.round(compression * 100)}% — giá đang nén, sắp bung.`,
      weight: 12,
    });
  }

  const extremeIndex = bottom ? lows.indexOf(windowLow) : highs.indexOf(windowHigh);
  const barsSinceExtreme = window.length - 1 - extremeIndex;
  if (barsSinceExtreme >= 12) {
    signals.push({
      key: bottom ? "noNewLow" : "noNewHigh",
      label: bottom ? "Lâu rồi không tạo đáy mới" : "Lâu rồi không tạo đỉnh mới",
      detail: `${barsSinceExtreme} nến ${frame} trôi qua kể từ ${bottom ? "đáy" : "đỉnh"} sâu nhất — đà ${bottom ? "giảm" : "tăng"} đã dừng.`,
      weight: Math.min(12, 6 + Math.floor(barsSinceExtreme / 10) * 3),
    });
  }

  const ema20 = ema(closes, 20);
  if (bottom ? currentClose > ema20 : currentClose < ema20) {
    signals.push({
      key: bottom ? "emaReclaim" : "emaLoss",
      label: bottom ? "Giá đã lấy lại EMA20" : "Giá đã mất EMA20",
      detail: `Giá ${round(currentClose, 6)} ${bottom ? "trên" : "dưới"} EMA20 ${round(ema20, 6)}.`,
      weight: 6,
    });
  }

  const score = Math.round(clamp(
    signals.reduce((sum, signal) => sum + signal.weight, 0),
    0,
    100,
  ));
  const stage = score >= BASE_PROBE_READY_SCORE
    ? "Nền vững"
    : score >= BASE_PROBE_FORMING_SCORE
      ? "Đang tạo nền"
      : "Mới chớm";
  const invalidation = bottom
    ? extreme * (1 - tolerance / 100)
    : extreme * (1 + tolerance / 100);

  return {
    direction: kind,
    frame,
    score,
    stage,
    level: round(level, 8),
    invalidation: round(invalidation, 8),
    touches: touchCount,
    spanBars,
    headline: bottom ? "Đang dò đáy" : "Đang dò đỉnh",
    detail: bottom
      ? `Giá đã ${touchCount} lần rơi về vùng ${round(level, 6)} trong ${spanBars} nến ${frame} mà không thủng sâu hơn. Chờ giá bật lên khỏi nền để tính LONG; đóng cửa dưới ${round(invalidation, 6)} là hỏng kịch bản.`
      : `Giá đã ${touchCount} lần lên tới vùng ${round(level, 6)} trong ${spanBars} nến ${frame} mà không vượt nổi. Chờ giá gãy khỏi nền để tính SHORT; đóng cửa trên ${round(invalidation, 6)} là hỏng kịch bản.`,
    signals: signals.sort((left, right) => right.weight - left.weight),
  };
}

const BASE_FRAME_RANK: Record<RsiDivergence["frame"], number> = { "15m": 0, "1h": 1, "4h": 2 };

function collectBaseProbe(frames: Array<{ frame: RsiDivergence["frame"]; candles: Candle[] }>) {
  const found = frames
    .flatMap(({ frame, candles }) => (["bottom", "top"] as const)
      .map((kind) => assessBaseProbe(candles, frame, kind)))
    .filter((probe): probe is BaseProbe => probe !== null);
  if (!found.length) return emptyBaseProbe;
  return found.reduce((left, right) => {
    const byScore = right.score - left.score;
    if (byScore !== 0) return byScore > 0 ? right : left;
    // Điểm bằng nhau thì tin khung lớn hơn.
    return BASE_FRAME_RANK[right.frame] > BASE_FRAME_RANK[left.frame] ? right : left;
  });
}

function atrPercent(candles: Candle[], period = 14) {
  if (candles.length < 2) return 0;
  const ranges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  const price = candles.at(-1)?.close || 1;
  return (average(ranges.slice(-period)) / price) * 100;
}

function trend(candles: Candle[]) {
  const closes = candles.map((candle) => candle.close);
  const current = closes.at(-1) ?? 0;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  if (current > ema20 && ema20 > ema50) return 1;
  if (current < ema20 && ema20 < ema50) return -1;
  return 0;
}

function buildEntryPlan(candles: Candle[], direction: "long" | "short"): EntryPlan | null {
  if (candles.length < 42) return null;
  const long = direction === "long";
  // Nến cuối Binance trả về là nến đang chạy — chỉ số trên nó đổi liên tục trong phút và
  // sẽ tự vẽ lại. Mọi điều kiện vì thế chốt trên nến đã đóng; chỉ giá vào lấy theo giá live.
  const livePrice = candles.at(-1)!.close;
  const closedCandles = candles.slice(0, -1);
  const closes = closedCandles.map((candle) => candle.close);
  const last = closedCandles.at(-1)!;
  const price = last.close;
  if (!price || !livePrice) return null;

  const values = rsiSeries(closedCandles);
  const currentRsi = values.at(-1) ?? 50;
  const recentRsi = values.slice(-6);
  const extremeRsi = long ? Math.min(...recentRsi) : Math.max(...recentRsi);
  const rsiTurn = long ? currentRsi - extremeRsi : extremeRsi - currentRsi;

  const ema9 = ema(closes, ENTRY_EMA_PERIOD);
  const priorCloses = closes.slice(-4, -1);
  const crossed = long
    ? price > ema9 && Math.min(...priorCloses) <= ema9
    : price < ema9 && Math.max(...priorCloses) >= ema9;

  const structureWindow = closedCandles.slice(-ENTRY_STRUCTURE_BARS - 1, -1);
  const structureLevel = long
    ? Math.max(...structureWindow.map((candle) => candle.high))
    : Math.min(...structureWindow.map((candle) => candle.low));
  const brokeStructure = long ? price > structureLevel : price < structureLevel;

  const baselineVolume = average(
    closedCandles.slice(-ENTRY_VOLUME_BARS - 1, -1).map((candle) => candle.volume),
  ) || 1;
  const volumeRatio = last.volume / baselineVolume;

  const triggers: EntryTrigger[] = [
    {
      key: "rsiTurn1m",
      label: long ? "RSI(7) 1m bẻ lên khỏi đáy" : "RSI(7) 1m bẻ xuống khỏi đỉnh",
      detail: `RSI 1m ${round(extremeRsi, 1)} → ${round(currentRsi, 1)}`,
      met: rsiTurn >= ENTRY_RSI_TURN,
    },
    {
      key: "emaCross1m",
      label: long ? "Nến 1m lấy lại EMA9" : "Nến 1m đánh mất EMA9",
      detail: `Giá ${round(price, 6)} · EMA9 1m ${round(ema9, 6)}`,
      met: crossed,
    },
    {
      key: "structureBreak1m",
      label: long
        ? `Vượt đỉnh ${ENTRY_STRUCTURE_BARS} nến 1m gần nhất`
        : `Thủng đáy ${ENTRY_STRUCTURE_BARS} nến 1m gần nhất`,
      detail: `Mốc cần phá ${round(structureLevel, 6)}`,
      met: brokeStructure,
    },
    {
      key: "volumeConfirm1m",
      label: "Volume nến kích hoạt xác nhận",
      detail: `Volume ${round(volumeRatio, 2)}× trung bình ${ENTRY_VOLUME_BARS} nến 1m`,
      met: volumeRatio >= ENTRY_VOLUME_RATIO,
    },
  ];

  const swingWindow = closedCandles.slice(-ENTRY_SWING_BARS);
  const swing = long
    ? Math.min(...swingWindow.map((candle) => candle.low))
    : Math.max(...swingWindow.map((candle) => candle.high));
  const volatility = Math.max(atrPercent(closedCandles), 0.05);
  // Stop phải nằm ngoài cả swing gần nhất lẫn biên độ nhiễu 1 phút, lấy cái xa hơn.
  const swingRisk = Math.abs((livePrice - swing) / livePrice) * 100;
  const riskPercent = Math.max(swingRisk, volatility * ENTRY_ATR_STOP, ENTRY_MIN_RISK);
  const stop = long
    ? livePrice * (1 - riskPercent / 100)
    : livePrice * (1 + riskPercent / 100);
  const target = long
    ? livePrice * (1 + (riskPercent * ENTRY_REWARD) / 100)
    : livePrice * (1 - (riskPercent * ENTRY_REWARD) / 100);

  // Chỉ tính là trễ khi mốc kích hoạt đã bị phá và giá còn chạy xa khỏi nó — tức là đuổi lệnh.
  // Đo từ swing 10 nến sẽ luôn báo trễ vì bản thân swing đã rộng vài ATR.
  const runFromTrigger = brokeStructure
    ? Math.abs((livePrice - structureLevel) / livePrice) * 100
    : 0;
  const distanceAtr = runFromTrigger / volatility;
  const late = brokeStructure && distanceAtr > ENTRY_LATE_ATR;
  const metCount = triggers.filter((trigger) => trigger.met).length;
  const readiness = Math.round((metCount / triggers.length) * 100);
  const state: EntryPlan["state"] = late
    ? "Trễ nhịp"
    : metCount >= 3
      ? "Vào được"
      : metCount >= 1
        ? "Chờ trigger 1m"
        : "Chưa đủ điều kiện";
  const missing = triggers.filter((trigger) => !trigger.met).map((trigger) => trigger.label);
  const note = late
    ? `Giá đã chạy ${round(distanceAtr, 1)}× ATR(1m) khỏi mốc kích hoạt ${round(structureLevel, 6)} — đuổi lệnh lúc này là mua đắt, chờ nhịp lùi về gần mốc.`
    : metCount >= 3
      ? `Đủ ${metCount}/4 điều kiện 1m. Stop ${long ? "dưới" : "trên"} ${round(stop, 6)}, tức rủi ro ${round(riskPercent, 2)}% mỗi lệnh.`
      : `Còn thiếu: ${missing.join(", ")}.`;

  return {
    direction,
    state,
    readiness,
    triggers,
    entry: round(livePrice, 8),
    stop: round(stop, 8),
    target: round(target, 8),
    riskPercent: round(riskPercent, 2),
    rewardRisk: ENTRY_REWARD,
    asOf: last.time + 60_000,
    note,
  };
}

function scoreCoin(input: {
  symbol: string;
  candles15m: Candle[];
  candles1h: Candle[];
  candles4h: Candle[];
  ticker: Record<string, string>;
  fundingRate: number | null;
  depth: { bids?: string[][]; asks?: string[][] };
}): WatchlistItem {
  const { symbol, candles15m, candles1h, candles4h, ticker, fundingRate, depth } = input;
  const orderBook = orderBookImbalance(depth);
  const currentPrice = Number(ticker.lastPrice) || candles15m.at(-1)!.close;
  const change24h = Number(ticker.priceChangePercent) || 0;
  const quoteVolume24h = Number(ticker.quoteVolume) || 0;
  const trend15m = trend(candles15m);
  const trend1h = trend(candles1h);
  const rsi15m = rsi(candles15m);
  const rsi1h = rsi(candles1h);
  const rsi4h = rsi(candles4h);
  const rsiByFrame = { "15m": rsi15m, "1h": rsi1h, "4h": rsi4h };
  const frameData = [
    { frame: "15m" as const, candles: candles15m },
    { frame: "1h" as const, candles: candles1h },
    { frame: "4h" as const, candles: candles4h },
  ];
  const oversoldFrames = (Object.entries(rsiByFrame) as Array<["15m" | "1h" | "4h", number]>)
    .filter(([, value]) => value < RSI_OVERSOLD_THRESHOLD)
    .map(([frame]) => frame);
  const overboughtFrames = (Object.entries(rsiByFrame) as Array<["15m" | "1h" | "4h", number]>)
    .filter(([, value]) => value > RSI_OVERBOUGHT_THRESHOLD)
    .map(([frame]) => frame);
  const bullishDivergences = frameData
    .map(({ frame, candles }) => rsiByFrame[frame] < RSI_OVERSOLD_THRESHOLD
      ? findRsiDivergence(candles, frame, "bullish")
      : null)
    .filter((item): item is RsiDivergence => item !== null);
  const bearishDivergences = frameData
    .map(({ frame, candles }) => rsiByFrame[frame] > RSI_OVERBOUGHT_THRESHOLD
      ? findRsiDivergence(candles, frame, "bearish")
      : null)
    .filter((item): item is RsiDivergence => item !== null);
  const lowestRsi = Math.min(rsi15m, rsi1h, rsi4h);
  const highestRsi = Math.max(rsi15m, rsi1h, rsi4h);
  const candlesByFrame = { "15m": candles15m, "1h": candles1h, "4h": candles4h };
  const bullishFrame = oversoldFrames[0]
    ?? (bullishDivergences[0]?.frame)
    ?? (frameData.find(({ frame }) => rsiByFrame[frame] === lowestRsi)?.frame ?? "15m");
  const bearishFrame = overboughtFrames[0]
    ?? (bearishDivergences[0]?.frame)
    ?? (frameData.find(({ frame }) => rsiByFrame[frame] === highestRsi)?.frame ?? "15m");
  const bullishReversal = oversoldFrames.length
    ? assessReversal({
      candles: candlesByFrame[bullishFrame],
      frame: bullishFrame,
      kind: "bullish",
      divergences: bullishDivergences,
    })
    : null;
  const bearishReversal = overboughtFrames.length
    ? assessReversal({
      candles: candlesByFrame[bearishFrame],
      frame: bearishFrame,
      kind: "bearish",
      divergences: bearishDivergences,
    })
    : null;
  const reversal: ReversalReadiness = (bullishReversal?.score ?? 0) >= (bearishReversal?.score ?? 0)
    ? bullishReversal ?? bearishReversal ?? {
      direction: "none",
      score: 0,
      stage: "Chưa có",
      signals: [],
      candlePattern: null,
      rsiSlope: 0,
      volumeSpike: 0,
    }
    : bearishReversal!;
  const volumeAlerts = collectVolumeAlerts(frameData);
  const volumeVerdict = buildVolumeVerdict(volumeAlerts, orderBook.imbalance);
  const baseProbe = collectBaseProbe(frameData);
  const momentum15m = rsi15m > 55 ? 1 : rsi15m < 45 ? -1 : 0;
  const momentum1h = rsi1h > 55 ? 1 : rsi1h < 45 ? -1 : 0;
  const momentumDirection = (momentum15m + momentum1h) / 2;
  const changeDirection = change24h > 1 ? 1 : change24h < -1 ? -1 : 0;
  const directionStrength = trend15m * 0.36 + trend1h * 0.34 + momentumDirection * 0.2 + changeDirection * 0.1;
  const direction = directionStrength >= 0 ? 1 : -1;
  let signal: Signal = "WAIT";
  if (directionStrength >= 0.32) signal = "LONG";
  if (directionStrength <= -0.32) signal = "SHORT";

  const recentVolume = average(candles15m.slice(-20).map((candle) => candle.volume));
  const baselineVolume = average(candles15m.slice(-120, -20).map((candle) => candle.volume)) || 1;
  const volumeRatio = recentVolume / baselineVolume;
  const volatility = atrPercent(candles15m);
  const aligned = trend15m !== 0 && trend15m === trend1h;
  const alignmentQuality = aligned ? 1 : trend15m || trend1h ? 0.55 : 0.25;
  const momentumQuality = signal === "WAIT"
    ? 0.4
    : clamp(0.5 + direction * momentumDirection * 0.5);
  const volumeQuality = clamp((volumeRatio - 0.55) / 1.25);
  const volatilityQuality = clamp((volatility - 0.025) / 0.45, 0.15, 1);
  const liquidityQuality = clamp((Math.log10(Math.max(quoteVolume24h, 1)) - 6) / 4);
  const crowdingPenalty = fundingRate === null
    ? 0
    : clamp(direction * fundingRate * 18_000, 0, 10);
  const score = Math.round(clamp(
    25 + alignmentQuality * 22 + Math.abs(directionStrength) * 20 + momentumQuality * 10 +
      volumeQuality * 9 + volatilityQuality * 7 + liquidityQuality * 7 - crowdingPenalty,
    0,
    100,
  ));

  const reasons: string[] = [
    `RSI(7) 15m ${round(rsi15m, 1)} · 1h ${round(rsi1h, 1)} · 4h ${round(rsi4h, 1)}`,
  ];
  if (aligned) reasons.push(`15m và 1h cùng xu hướng ${trend15m > 0 ? "tăng" : "giảm"}`);
  else if (trend15m || trend1h) reasons.push("Xu hướng đang hình thành, cần chờ thêm đồng thuận");
  else reasons.push("Giá đang nén quanh EMA20/50");
  if (volumeRatio >= 1) reasons.push(`Volume 15m đạt ${round(volumeRatio, 2)}× trung bình`);
  if (reversal.score > 0) {
    reasons.push(`Đảo chiều ${reversal.stage.toLowerCase()} (${reversal.score}/100): ${reversal.signals.map((item) => item.label).join(", ")}`);
  }
  if (baseProbe.direction !== "none") {
    reasons.push(`${baseProbe.headline} trên ${baseProbe.frame} (${baseProbe.score}/100): ${baseProbe.signals.map((item) => item.label).join(", ")}`);
  }
  const hasOrderBookSignal = Math.abs(orderBook.imbalance) >= ORDER_BOOK_ALERT_THRESHOLD;
  if (volumeAlerts.length || hasOrderBookSignal) {
    reasons.push(`${volumeVerdict.headline}: ${volumeVerdict.detail}`);
    volumeAlerts.forEach((alert) => {
      reasons.push(`${alert.frame} · ${alert.label} → ${alert.conclusion}`);
    });
  }

  return {
    symbol,
    ticker: symbol.replace(/USDT$/, ""),
    price: currentPrice,
    change24h: round(change24h, 2),
    quoteVolume24h,
    score,
    signal,
    // Khung 1m được gắn sau, chỉ cho những coin đã lọt vào danh sách.
    rsi1m: null,
    entryPlan: null,
    rsi15m: round(rsi15m, 1),
    rsi1h: round(rsi1h, 1),
    rsi4h: round(rsi4h, 1),
    lowestRsi: round(lowestRsi, 1),
    highestRsi: round(highestRsi, 1),
    oversoldFrames,
    overboughtFrames,
    bullishDivergences,
    bearishDivergences,
    reversal,
    volumeAlerts,
    volumeVerdict,
    orderBookImbalance: round(orderBook.imbalance, 1),
    baseProbe,
    atrPercent: round(volatility, 2),
    volumeRatio: round(volumeRatio, 2),
    fundingRate,
    reasons,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const market: MarketType = url.searchParams.get("market") === "spot" ? "spot" : "futures";
  const batch = Number(url.searchParams.get("batch") || 0);
  const batchCount = Math.ceil(TOP_VOLUME_LIMIT / BATCH_SIZE);
  if (!Number.isInteger(batch) || batch < 0 || batch >= batchCount) {
    return NextResponse.json({ error: "Batch scanner không hợp lệ." }, { status: 400 });
  }
  const cacheKey = `${market}:${batch}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return NextResponse.json(cached.data, { headers: { "X-PatternDesk-Cache": "HIT" } });
  }

  try {
    const futures = market === "futures";
    const snapshot = await getMarketSnapshot(market);
    const { topTickers, fundingMap } = snapshot;
    const batchTickers = topTickers.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE);

    const scans = await mapSettledWithConcurrency(batchTickers, SCAN_CONCURRENCY, async (ticker) => {
      const symbol = ticker.symbol;
      const [candles15m, candles1h, candles4h, depth] = await Promise.all([
        fetchKlines(market, symbol, "15m", RSI_HISTORY_LIMIT),
        fetchKlines(market, symbol, "1h", RSI_HISTORY_LIMIT),
        fetchKlines(market, symbol, "4h", RSI_HISTORY_LIMIT),
        fetchDepth(market, symbol),
      ]);
      return scoreCoin({
        symbol,
        candles15m,
        candles1h,
        candles4h,
        ticker,
        fundingRate: futures ? fundingMap.get(symbol) ?? null : null,
        depth,
      });
    });

    const successfulItems = scans
      .filter((result): result is PromiseFulfilledResult<WatchlistItem> => result.status === "fulfilled")
      .map((result) => result.value);
    const items = successfulItems
      .filter((item) => item.oversoldFrames.length > 0)
      .sort((left, right) =>
        right.reversal.score - left.reversal.score ||
        volumeAlertBias(right.volumeAlerts, "bullish") - volumeAlertBias(left.volumeAlerts, "bullish") ||
        right.bullishDivergences.length - left.bullishDivergences.length ||
        right.oversoldFrames.length - left.oversoldFrames.length ||
        left.lowestRsi - right.lowestRsi ||
        right.quoteVolume24h - left.quoteVolume24h,
      );
    const overboughtItems = successfulItems
      .filter((item) => item.overboughtFrames.length > 0)
      .sort((left, right) =>
        right.reversal.score - left.reversal.score ||
        volumeAlertBias(right.volumeAlerts, "bearish") - volumeAlertBias(left.volumeAlerts, "bearish") ||
        right.bearishDivergences.length - left.bearishDivergences.length ||
        right.overboughtFrames.length - left.overboughtFrames.length ||
        right.highestRsi - left.highestRsi ||
        right.quoteVolume24h - left.quoteVolume24h,
      );

    // Coin đang dò đáy/đỉnh thường đã thoát vùng RSI cực trị, nên lọc riêng trên toàn bộ coin quét được.
    const probeItems = successfulItems
      .filter((item) => item.baseProbe.direction !== "none" && item.baseProbe.score >= BASE_PROBE_MIN_SCORE)
      .sort((left, right) =>
        right.baseProbe.score - left.baseProbe.score ||
        right.baseProbe.touches - left.baseProbe.touches ||
        right.quoteVolume24h - left.quoteVolume24h,
      );

    if (!successfulItems.length) throw new Error("Không có đủ dữ liệu để quét RSI watchlist.");

    // Chỉ tải nến 1m cho coin đã lọt danh sách — quét 1m cho cả 200 coin là lãng phí rate limit.
    const timingTargets = new Map<string, "long" | "short">();
    const register = (item: WatchlistItem, direction: "long" | "short") => {
      if (!timingTargets.has(item.symbol)) timingTargets.set(item.symbol, direction);
    };
    items.forEach((item) => register(item, "long"));
    overboughtItems.forEach((item) => register(item, "short"));
    probeItems.forEach((item) => register(item, item.baseProbe.direction === "bottom" ? "long" : "short"));

    const timingScans = await mapSettledWithConcurrency(
      [...timingTargets.entries()],
      SCAN_CONCURRENCY,
      async ([symbol, direction]) => {
        const candles1m = await fetchKlines(market, symbol, "1m", ENTRY_HISTORY_LIMIT);
        return {
          symbol,
          rsi1m: round(rsi(candles1m), 1),
          entryPlan: buildEntryPlan(candles1m, direction),
        };
      },
    );
    const timingMap = new Map(
      timingScans
        .filter((result): result is PromiseFulfilledResult<{
          symbol: string;
          rsi1m: number;
          entryPlan: EntryPlan | null;
        }> => result.status === "fulfilled")
        .map((result) => [result.value.symbol, result.value]),
    );
    const withTiming = (item: WatchlistItem): WatchlistItem => {
      const timing = timingMap.get(item.symbol);
      return timing ? { ...item, rsi1m: timing.rsi1m, entryPlan: timing.entryPlan } : item;
    };

    const data: WatchlistResponse = {
      market,
      generatedAt: snapshot.generatedAt,
      scanned: batchTickers.length,
      successfulScans: successfulItems.length,
      matchedCount: items.length,
      overboughtMatchedCount: overboughtItems.length,
      universeSize: topTickers.length,
      batch,
      batchCount,
      refreshIntervalMs: CACHE_TTL_MS,
      items: items.map(withTiming),
      overboughtItems: overboughtItems.map(withTiming),
      probeItems: probeItems.map(withTiming),
      bottomProbeCount: probeItems.filter((item) => item.baseProbe.direction === "bottom").length,
      topProbeCount: probeItems.filter((item) => item.baseProbe.direction === "top").length,
      probeMethodology: "Không dùng ngưỡng RSI — quét cấu trúc giá 60 nến gần nhất trên cả 15m, 1h và 4h để tìm coin đang xây nền. Một vùng giá bị test lại từ 2 lần trở lên trong tối thiểu 6 nến, và phải nằm ở 35% dưới cùng của biên độ (dò đáy) hoặc 35% trên cùng (dò đỉnh) để loại nhiễu tích luỹ giữa range. Điểm 0-100 cộng dồn từ: số lần test lại vùng, đáy sau cao hơn đáy trước, volume cạn dần trong nền, phá nền giả rồi bật lại, biên độ nến co lại, lâu không tạo đáy/đỉnh mới, và giá lấy lại (hoặc đánh mất) EMA20. Mỗi thẻ ghi rõ mức giá làm hỏng kịch bản. Khung 1m gắn thêm bộ bấm giờ điểm vào với 4 điều kiện chốt trên nến đã đóng, kèm giá vào, stop và mục tiêu theo R:R 1:2.",
      methodology: "Bắt buộc RSI(7) < 20 trên 15m, 1h hoặc 4h; gắn nhãn LONG phân kỳ tăng khi giá tạo đáy thấp hơn nhưng RSI tạo đáy cao hơn. Điểm đảo chiều 0-100 cộng dồn từ phân kỳ, RSI bẻ lên khỏi đáy, nến đảo chiều, volume climax, lấy lại EMA20 và phá swing high; bao gồm nến đang chạy. Phần alert đọc thêm volume của 6 nến gần nhất: giá giảm mà lực bán yếu dần nghĩa là người bán đã đuối (canh LONG); giá tăng mà lực mua yếu dần nghĩa là nhịp tăng thiếu tiền (canh SHORT). Order book (20 mức giá quanh giá hiện tại) được đối chiếu thêm: lệch mua/bán cùng chiều với volume thì tăng độ tin cậy, trái chiều thì cảnh báo thận trọng. Nếu các khung nói ngược nhau, thẻ sẽ báo mâu thuẫn và khuyên chờ. Khung 1m chỉ dùng để bấm giờ điểm vào chứ không dùng để lọc coin, và chỉ tải cho coin đã lọt danh sách: 4 điều kiện gồm RSI(7) 1m bẻ hướng, nến lấy lại hoặc đánh mất EMA9, phá đỉnh/đáy 3 nến gần nhất, và volume nến kích hoạt vượt trung bình 20 nến. Tất cả chốt trên nến 1m đã đóng để tín hiệu không tự vẽ lại; stop lấy mức xa hơn giữa swing 10 nến và 1.2× ATR(1m) để nằm ngoài vùng nhiễu.",
      overboughtMethodology: "Bắt buộc RSI(7) > 90 trên 15m, 1h hoặc 4h; gắn nhãn SHORT phân kỳ giảm khi giá tạo đỉnh cao hơn nhưng RSI tạo đỉnh thấp hơn. Điểm đảo chiều 0-100 cộng dồn từ phân kỳ, RSI bẻ xuống khỏi đỉnh, nến đảo chiều, volume climax, mất EMA20 và phá swing low; bao gồm nến đang chạy. Phần alert đọc thêm volume của 6 nến gần nhất: giá tăng mà lực mua yếu dần nghĩa là hết người mua đuổi (canh SHORT); giá tăng cùng volume nghĩa là đà tăng còn thật (chưa nên SHORT). Order book (20 mức giá quanh giá hiện tại) được đối chiếu thêm: lệch mua/bán cùng chiều với volume thì tăng độ tin cậy, trái chiều thì cảnh báo thận trọng. Nếu các khung nói ngược nhau, thẻ sẽ báo mâu thuẫn và khuyên chờ. Khung 1m chỉ dùng để bấm giờ điểm vào chứ không dùng để lọc coin, và chỉ tải cho coin đã lọt danh sách: 4 điều kiện gồm RSI(7) 1m bẻ hướng, nến lấy lại hoặc đánh mất EMA9, phá đỉnh/đáy 3 nến gần nhất, và volume nến kích hoạt vượt trung bình 20 nến. Tất cả chốt trên nến 1m đã đóng để tín hiệu không tự vẽ lại; stop lấy mức xa hơn giữa swing 10 nến và 1.2× ATR(1m) để nằm ngoài vùng nhiễu.",
    };
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, data });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=90, stale-while-revalidate=180", "X-PatternDesk-Cache": "MISS" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể quét watchlist.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
