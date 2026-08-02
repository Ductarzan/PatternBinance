import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the PatternDesk application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /PatternDesk — Binance Pattern AI/i);
  assert.match(html, /PATTERN/);
  assert.match(html, /5\.000 nến/i);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/i);
});

test("keeps market logic deterministic and Gemini server-only", async () => {
  const [marketRoute, watchlistRoute, analyzer, explainRoute, terminal, packageJson, catalogText] = await Promise.all([
    readFile(new URL("../app/api/market/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/watchlist/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/analyze-market.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/explain/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/terminal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/binance-usdt-symbols.json", import.meta.url), "utf8"),
  ]);
  const catalog = JSON.parse(catalogText);

  assert.match(marketRoute, /fetchKlines\(market, symbol, "15m", 5000\)/);
  assert.match(watchlistRoute, /TOP_VOLUME_LIMIT = 100/);
  assert.match(watchlistRoute, /BATCH_SIZE = 15/);
  assert.match(watchlistRoute, /RSI_HISTORY_LIMIT = 200/);
  assert.match(watchlistRoute, /RSI_PERIOD = 12/);
  assert.match(watchlistRoute, /Number\(right\.quoteVolume\) - Number\(left\.quoteVolume\)/);
  assert.match(watchlistRoute, /fetchKlines\(market, symbol, "4h", RSI_HISTORY_LIMIT\)/);
  assert.match(watchlistRoute, /averageGain \* \(period - 1\)/);
  assert.match(watchlistRoute, /value < 15/);
  assert.match(watchlistRoute, /oversoldFrames\.length/);
  assert.match(watchlistRoute, /trend15m \* 0\.36/);
  assert.match(analyzer, /patternWindow = 30/);
  assert.match(analyzer, /forwardBars = 12/);
  assert.match(explainRoute, /process\.env\.GEMINI_API_KEY/);
  assert.match(explainRoute, /không sửa, suy đoán hoặc tạo thêm giá/);
  assert.doesNotMatch(explainRoute, /additionalProperties/);
  assert.match(terminal, /setAiError\(payload\.error/);
  assert.match(terminal, /Gemini lỗi/);
  assert.match(terminal, /aria-label="Chọn coin nhanh"/);
  assert.match(terminal, /onClick=\{\(\) => selectSymbol\(coin\.symbol\)\}/);
  assert.match(terminal, /COIN_OPTIONS\[market\]/);
  assert.match(terminal, /WATCHLIST_REFRESH_MS = 90_000/);
  assert.match(terminal, /WATCHLIST_REQUEST_CONCURRENCY = 2/);
  assert.match(terminal, /Top coin RSI/);
  assert.match(terminal, /RSI thấp nhất/);
  assert.ok(catalog.futures.length > 500);
  assert.ok(catalog.spot.length > 450);
  assert.ok(catalog.futures.includes("SOLUSDT"));
  assert.ok(catalog.spot.includes("SOLUSDT"));
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", root)));
});
