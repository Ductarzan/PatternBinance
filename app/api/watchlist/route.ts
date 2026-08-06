import { NextResponse } from "next/server";
import symbolCatalog from "../../../lib/binance-usdt-symbols.json";
import type {
  Candle,
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
const DEPTH_LIMIT = 20;
const ORDER_BOOK_LEVELS = 20;
const ORDER_BOOK_ALERT_THRESHOLD = 20;
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

    if (!successfulItems.length) throw new Error("Không có đủ dữ liệu để quét RSI watchlist.");
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
      items,
      overboughtItems,
      methodology: "Bắt buộc RSI(7) < 20 trên 15m, 1h hoặc 4h; gắn nhãn LONG phân kỳ tăng khi giá tạo đáy thấp hơn nhưng RSI tạo đáy cao hơn. Điểm đảo chiều 0-100 cộng dồn từ phân kỳ, RSI bẻ lên khỏi đáy, nến đảo chiều, volume climax, lấy lại EMA20 và phá swing high; bao gồm nến đang chạy. Phần alert đọc thêm volume của 6 nến gần nhất: giá giảm mà lực bán yếu dần nghĩa là người bán đã đuối (canh LONG); giá tăng mà lực mua yếu dần nghĩa là nhịp tăng thiếu tiền (canh SHORT). Order book (20 mức giá quanh giá hiện tại) được đối chiếu thêm: lệch mua/bán cùng chiều với volume thì tăng độ tin cậy, trái chiều thì cảnh báo thận trọng. Nếu các khung nói ngược nhau, thẻ sẽ báo mâu thuẫn và khuyên chờ.",
      overboughtMethodology: "Bắt buộc RSI(7) > 90 trên 15m, 1h hoặc 4h; gắn nhãn SHORT phân kỳ giảm khi giá tạo đỉnh cao hơn nhưng RSI tạo đỉnh thấp hơn. Điểm đảo chiều 0-100 cộng dồn từ phân kỳ, RSI bẻ xuống khỏi đỉnh, nến đảo chiều, volume climax, mất EMA20 và phá swing low; bao gồm nến đang chạy. Phần alert đọc thêm volume của 6 nến gần nhất: giá tăng mà lực mua yếu dần nghĩa là hết người mua đuổi (canh SHORT); giá tăng cùng volume nghĩa là đà tăng còn thật (chưa nên SHORT). Order book (20 mức giá quanh giá hiện tại) được đối chiếu thêm: lệch mua/bán cùng chiều với volume thì tăng độ tin cậy, trái chiều thì cảnh báo thận trọng. Nếu các khung nói ngược nhau, thẻ sẽ báo mâu thuẫn và khuyên chờ.",
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
