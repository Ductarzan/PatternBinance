import { NextResponse } from "next/server";
import { analyzeMarket } from "../../../lib/analyze-market";
import type { Candle, MarketType } from "../../../lib/market-types";

const VALID_SYMBOL = /^[\p{L}\p{N}]{5,40}$/u;
const FUTURES_BASE = "https://fapi.binance.com";
const SPOT_BASE = "https://data-api.binance.vision";

async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "PatternDesk/1.0" },
      cache: "no-store",
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Binance ${response.status}: ${message.slice(0, 160)}`);
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

async function fetchKlines(market: MarketType, symbol: string, interval: string, count: number) {
  const futures = market === "futures";
  const base = futures ? FUTURES_BASE : SPOT_BASE;
  const path = futures ? "/fapi/v1/klines" : "/api/v3/klines";
  const maxLimit = futures ? 1500 : 1000;
  let endTime = Date.now();
  let rows: Array<Array<string | number>> = [];

  while (rows.length < count) {
    const limit = Math.min(maxLimit, count - rows.length);
    const url = `${base}${path}?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${endTime}`;
    const batch = await getJson<Array<Array<string | number>>>(url);
    if (!batch.length) break;
    rows = [...batch, ...rows];
    endTime = Number(batch[0][0]) - 1;
    if (batch.length < limit) break;
  }

  const unique = new Map<number, Candle>();
  rows.forEach((row) => {
    const candle = toCandle(row);
    unique.set(candle.time, candle);
  });
  return [...unique.values()].sort((a, b) => a.time - b.time).slice(-count);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase().trim();
  const market: MarketType = url.searchParams.get("market") === "spot" ? "spot" : "futures";

  if (!VALID_SYMBOL.test(symbol)) {
    return NextResponse.json({ error: "Mã giao dịch không hợp lệ." }, { status: 400 });
  }

  try {
    const futures = market === "futures";
    const base = futures ? FUTURES_BASE : SPOT_BASE;
    const tickerPath = futures ? "/fapi/v1/ticker/24hr" : "/api/v3/ticker/24hr";
    const depthPath = futures ? "/fapi/v1/depth" : "/api/v3/depth";

    const [main, candles1m, candles1h, candles4h, ticker, depth, funding] = await Promise.all([
      fetchKlines(market, symbol, "15m", 5000),
      fetchKlines(market, symbol, "1m", 320),
      fetchKlines(market, symbol, "1h", 320),
      fetchKlines(market, symbol, "4h", 320),
      getJson<Record<string, string>>(`${base}${tickerPath}?symbol=${symbol}`),
      getJson<{ bids: string[][]; asks: string[][] }>(`${base}${depthPath}?symbol=${symbol}&limit=100`),
      futures
        ? getJson<Record<string, string | number>>(`${base}/fapi/v1/premiumIndex?symbol=${symbol}`)
        : Promise.resolve(null),
    ]);

    const analysis = analyzeMarket({
      symbol,
      market,
      main,
      timeframes: { "1m": candles1m, "1h": candles1h, "4h": candles4h },
      ticker,
      depth,
      funding,
    });

    return NextResponse.json(analysis, {
      headers: {
        "Cache-Control": "public, s-maxage=45, stale-while-revalidate=120",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể tải dữ liệu thị trường.";
    const status = message.includes("Invalid symbol") || message.includes("-1121") ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
