import { NextResponse } from "next/server";
import symbolCatalog from "../../../lib/binance-usdt-symbols.json";
import type { Candle, MarketType, Signal, WatchlistItem, WatchlistResponse } from "../../../lib/market-types";

const FUTURES_BASE = "https://fapi.binance.com";
const SPOT_BASE = "https://data-api.binance.vision";
const TOP_VOLUME_LIMIT = 100;
const BATCH_SIZE = 25;
const SCAN_CONCURRENCY = 6;
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

function aggregateTo1h(candles: Candle[]) {
  const groups = new Map<number, Candle>();
  candles.forEach((candle) => {
    const time = Math.floor(candle.time / 3_600_000) * 3_600_000;
    const current = groups.get(time);
    if (!current) {
      groups.set(time, { ...candle, time });
      return;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  });
  return [...groups.values()].sort((left, right) => left.time - right.time);
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

function rsi(candles: Candle[], period = 14) {
  if (candles.length <= period) return 50;
  const closes = candles.map((candle) => candle.close);
  const changes = closes.slice(1).map((close, index) => close - closes[index]);
  const recent = changes.slice(-period);
  const gains = average(recent.map((change) => Math.max(change, 0)));
  const losses = average(recent.map((change) => Math.max(-change, 0)));
  if (!losses) return gains ? 100 : 50;
  return 100 - 100 / (1 + gains / losses);
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
  ticker: Record<string, string>;
  fundingRate: number | null;
}): WatchlistItem {
  const { symbol, candles15m, candles1h, ticker, fundingRate } = input;
  const currentPrice = Number(ticker.lastPrice) || candles15m.at(-1)!.close;
  const change24h = Number(ticker.priceChangePercent) || 0;
  const quoteVolume24h = Number(ticker.quoteVolume) || 0;
  const trend15m = trend(candles15m);
  const trend1h = trend(candles1h);
  const rsi15m = rsi(candles15m);
  const rsi1h = rsi(candles1h);
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

  const reasons: string[] = [];
  if (aligned) reasons.push(`15m và 1h cùng xu hướng ${trend15m > 0 ? "tăng" : "giảm"}`);
  else if (trend15m || trend1h) reasons.push("Xu hướng đang hình thành, cần chờ thêm đồng thuận");
  else reasons.push("Giá đang nén quanh EMA20/50");
  if (volumeRatio >= 1) reasons.push(`Volume 15m đạt ${round(volumeRatio, 2)}× trung bình`);
  else reasons.push(`RSI 15m ${round(rsi15m, 1)} · RSI 1h ${round(rsi1h, 1)}`);

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
      const candles15m = await fetchKlines(market, symbol, "15m", 240);
      const candles1h = aggregateTo1h(candles15m);
      return scoreCoin({
        symbol,
        candles15m,
        candles1h,
        ticker,
        fundingRate: futures ? fundingMap.get(symbol) ?? null : null,
      });
    });

    const items = scans
      .filter((result): result is PromiseFulfilledResult<WatchlistItem> => result.status === "fulfilled")
      .map((result) => result.value)
      .sort((left, right) => right.score - left.score || Math.abs(right.change24h) - Math.abs(left.change24h));

    if (!items.length) throw new Error("Không có đủ dữ liệu để xếp hạng watchlist.");
    const data: WatchlistResponse = {
      market,
      generatedAt: snapshot.generatedAt,
      scanned: batchTickers.length,
      successfulScans: items.length,
      universeSize: topTickers.length,
      batch,
      batchCount,
      refreshIntervalMs: CACHE_TTL_MS,
      items,
      methodology: "Luôn quét top 100 cặp theo quote volume 24h; xếp hạng bằng xu hướng 15m/1h, RSI, volume, ATR và funding.",
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
