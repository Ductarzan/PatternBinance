"use client";

import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleDot,
  Clock3,
  Database,
  Gauge,
  Layers3,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Waves,
  Zap,
} from "lucide-react";
import type { CSSProperties, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiExplanation, Candle, MarketAnalysis, MarketType } from "../lib/market-types";

const POPULAR_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"];

function priceDigits(value: number) {
  if (value >= 1000) return 2;
  if (value >= 1) return 4;
  return 6;
}

function formatPrice(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: priceDigits(value),
    maximumFractionDigits: priceDigits(value),
  }).format(value);
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(value);
}

function MarketChart({ candles }: { candles: Candle[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !candles.length) return;

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(bounds.width * ratio));
      canvas.height = Math.max(1, Math.floor(bounds.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      const width = bounds.width;
      const height = bounds.height;
      const chartHeight = height * 0.79;
      const left = 12;
      const right = 56;
      const plotWidth = width - left - right;
      const maximum = Math.max(...candles.map((candle) => candle.high));
      const minimum = Math.min(...candles.map((candle) => candle.low));
      const priceRange = maximum - minimum || maximum * 0.01 || 1;
      const top = maximum + priceRange * 0.08;
      const bottom = minimum - priceRange * 0.08;
      const range = top - bottom;
      const xStep = plotWidth / candles.length;
      const y = (price: number) => 8 + ((top - price) / range) * (chartHeight - 18);

      context.clearRect(0, 0, width, height);
      context.fillStyle = "#0a0d12";
      context.fillRect(0, 0, width, height);

      context.strokeStyle = "rgba(139, 151, 170, 0.10)";
      context.lineWidth = 1;
      context.font = "10px var(--font-geist-mono), monospace";
      context.fillStyle = "#697383";
      for (let row = 0; row <= 4; row += 1) {
        const gridY = 8 + (chartHeight - 18) * (row / 4);
        context.beginPath();
        context.moveTo(left, gridY + 0.5);
        context.lineTo(width - right, gridY + 0.5);
        context.stroke();
        const label = top - range * (row / 4);
        context.fillText(formatPrice(label), width - right + 7, gridY + 3);
      }
      for (let column = 0; column <= 4; column += 1) {
        const gridX = left + plotWidth * (column / 4);
        context.beginPath();
        context.moveTo(gridX + 0.5, 8);
        context.lineTo(gridX + 0.5, chartHeight);
        context.stroke();
      }

      const maxVolume = Math.max(...candles.map((candle) => candle.volume)) || 1;
      const bodyWidth = Math.max(1, Math.min(5.4, xStep * 0.7));
      candles.forEach((candle, index) => {
        const centerX = left + index * xStep + xStep / 2;
        const isUp = candle.close >= candle.open;
        const color = isUp ? "#13c784" : "#ef4868";
        context.strokeStyle = color;
        context.fillStyle = color;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(centerX, y(candle.high));
        context.lineTo(centerX, y(candle.low));
        context.stroke();
        const bodyTop = Math.min(y(candle.open), y(candle.close));
        const bodyHeight = Math.max(1.2, Math.abs(y(candle.open) - y(candle.close)));
        context.fillRect(centerX - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);

        const volumeHeight = (candle.volume / maxVolume) * (height - chartHeight - 24);
        context.globalAlpha = 0.34;
        context.fillRect(centerX - bodyWidth / 2, height - 18 - volumeHeight, bodyWidth, volumeHeight);
        context.globalAlpha = 1;
      });

      const multiplier = 2 / 21;
      const emaValues: number[] = [candles[0].close];
      for (let index = 1; index < candles.length; index += 1) {
        emaValues.push(candles[index].close * multiplier + emaValues[index - 1] * (1 - multiplier));
      }
      context.strokeStyle = "#f6c746";
      context.lineWidth = 1.4;
      context.beginPath();
      emaValues.forEach((value, index) => {
        const pointX = left + index * xStep + xStep / 2;
        const pointY = y(value);
        if (index === 0) context.moveTo(pointX, pointY);
        else context.lineTo(pointX, pointY);
      });
      context.stroke();

      const last = candles.at(-1)!;
      const lastY = y(last.close);
      context.setLineDash([4, 4]);
      context.strokeStyle = last.close >= last.open ? "rgba(19,199,132,.75)" : "rgba(239,72,104,.75)";
      context.beginPath();
      context.moveTo(left, lastY);
      context.lineTo(width - right, lastY);
      context.stroke();
      context.setLineDash([]);

      const dateIndexes = [0, Math.floor(candles.length / 2), candles.length - 1];
      context.fillStyle = "#697383";
      dateIndexes.forEach((index, position) => {
        const candle = candles[index];
        const label = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit" }).format(candle.time);
        const x = left + index * xStep;
        context.textAlign = position === 0 ? "left" : position === 2 ? "right" : "center";
        context.fillText(label, x, height - 2);
      });
      context.textAlign = "left";
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [candles]);

  return <canvas ref={canvasRef} className="market-canvas" aria-label="Biểu đồ nến 15 phút với EMA 20 và volume" />;
}

function LoadingTerminal({ symbol }: { symbol: string }) {
  return (
    <div className="loading-state panel">
      <div className="scanner-radar"><Search size={26} /></div>
      <div>
        <span className="eyebrow">ĐANG QUÉT DỮ LIỆU THẬT</span>
        <h2>Đang đối chiếu 5.000 nến {symbol}</h2>
        <p>Tải nến 15m, đa khung thời gian, funding, volume và order book. Thường mất vài giây.</p>
      </div>
      <div className="loading-track"><span /></div>
    </div>
  );
}

export function MarketTerminal() {
  const [symbolInput, setSymbolInput] = useState("BTCUSDT");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [market, setMarket] = useState<MarketType>("futures");
  const [analysis, setAnalysis] = useState<MarketAnalysis | null>(null);
  const [ai, setAi] = useState<AiExplanation | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadMarket = useCallback(async (signalController: AbortSignal) => {
    setLoading(true);
    setError(null);
    setAi(null);
    try {
      const response = await fetch(`/api/market?symbol=${encodeURIComponent(symbol)}&market=${market}`, {
        cache: "no-store",
        signal: signalController,
      });
      const payload = await response.json() as MarketAnalysis & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Không thể tải dữ liệu Binance.");
      setAnalysis(payload as MarketAnalysis);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      setError(requestError instanceof Error ? requestError.message : "Không thể tải dữ liệu Binance.");
      setAnalysis(null);
    } finally {
      setLoading(false);
    }
  }, [market, symbol]);

  useEffect(() => {
    const controller = new AbortController();
    loadMarket(controller.signal);
    return () => controller.abort();
  }, [loadMarket, refreshKey]);

  useEffect(() => {
    if (!analysis) return;
    const controller = new AbortController();
    const explain = async () => {
      setAiLoading(true);
      try {
        const response = await fetch("/api/explain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ analysis }),
          signal: controller.signal,
        });
        const payload = await response.json() as AiExplanation & { error?: string };
        if (response.ok) setAi(payload as AiExplanation);
        else if (payload.configured === false) setAi(null);
      } catch {
        // The deterministic explanation remains visible when Gemini is unavailable.
      } finally {
        setAiLoading(false);
      }
    };
    explain();
    return () => controller.abort();
  }, [analysis]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const next = symbolInput.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
    if (next.length < 5) return;
    setSymbolInput(next);
    if (next === symbol) setRefreshKey((key) => key + 1);
    else setSymbol(next);
  };

  const signalClass = analysis?.signal === "LONG" ? "positive" : analysis?.signal === "SHORT" ? "negative" : "neutral";
  const signalLabel = analysis?.signal === "LONG" ? "ƯU TIÊN LONG" : analysis?.signal === "SHORT" ? "ƯU TIÊN SHORT" : "CHỜ XÁC NHẬN";
  const fallbackAi = useMemo(() => analysis ? {
    title: analysis.signal === "WAIT" ? "Chưa có điểm vào đạt chuẩn" : `Thiên hướng ${analysis.signal} có điều kiện`,
    narrative: analysis.deterministicSummary,
    keyDrivers: analysis.factors.slice(0, 3).map((factor) => `${factor.label}: ${factor.value}`),
    invalidation: `Kịch bản bị vô hiệu tại ${formatPrice(analysis.setup.stopLoss)}.`,
    caution: analysis.warnings[0],
  } : null, [analysis]);
  const explanation = ai ?? fallbackAi;

  return (
    <main className="app-shell">
      <nav className="topbar">
        <div className="brand" aria-label="Pattern Desk">
          <span className="brand-mark"><BarChart3 size={18} /></span>
          <span>PATTERN<span>DESK</span></span>
          <small>PRO</small>
        </div>
        <div className="topbar-center">
          <span className="status-dot" />
          <span>Binance public feed</span>
          <i />
          <span>15m · 5.000 nến</span>
        </div>
        <div className="nav-actions">
          <span className="utc-clock"><Clock3 size={14} /> {analysis ? formatTime(analysis.generatedAt) : "Đang đồng bộ"}</span>
          <button
            className="icon-button"
            aria-label="Làm mới dữ liệu"
            onClick={() => setRefreshKey((key) => key + 1)}
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? "spinning" : ""} />
          </button>
        </div>
      </nav>

      <header className="control-deck">
        <form className="symbol-search" onSubmit={handleSubmit}>
          <Search size={17} />
          <input
            value={symbolInput}
            onChange={(event) => setSymbolInput(event.target.value.toUpperCase())}
            aria-label="Mã giao dịch"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="symbol-submit" type="submit" aria-label="Phân tích mã">
            <ArrowRight size={15} />
          </button>
        </form>
        <div className="market-switch" aria-label="Chọn thị trường">
          <button className={market === "futures" ? "active" : ""} onClick={() => setMarket("futures")}>USD-M Futures</button>
          <button className={market === "spot" ? "active" : ""} onClick={() => setMarket("spot")}>Spot</button>
        </div>
        <div className="popular-pairs">
          {POPULAR_SYMBOLS.map((pair) => (
            <button
              key={pair}
              className={symbol === pair ? "active" : ""}
              onClick={() => { setSymbolInput(pair); setSymbol(pair); }}
            >
              {pair.replace("USDT", "")}
            </button>
          ))}
        </div>
        <button className="scan-button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}>
          <Zap size={16} fill="currentColor" /> Quét lại
        </button>
      </header>

      {loading && !analysis ? <LoadingTerminal symbol={symbol} /> : null}

      {error ? (
        <section className="error-state panel">
          <AlertTriangle size={26} />
          <div><strong>Chưa thể hoàn tất lần quét</strong><p>{error}</p></div>
          <button onClick={() => setRefreshKey((key) => key + 1)}>Thử lại</button>
        </section>
      ) : null}

      {analysis ? (
        <div className={loading ? "terminal-grid refreshing" : "terminal-grid"}>
          <section className="market-hero panel">
            <div className="hero-identity">
              <div className="asset-icon">{analysis.symbol.slice(0, 1)}</div>
              <div>
                <div className="pair-line"><h1>{analysis.symbol.replace("USDT", "")}/USDT</h1><span>PERP</span></div>
                <p>{analysis.market === "futures" ? "Binance USDⓈ-M Futures" : "Binance Spot"} · dữ liệu công khai</p>
              </div>
            </div>
            <div className="hero-price">
              <span>GIÁ GẦN NHẤT</span>
              <strong>{formatPrice(analysis.current.price)}</strong>
              <em className={analysis.current.change24h >= 0 ? "positive-text" : "negative-text"}>
                {analysis.current.change24h >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}
                {analysis.current.change24h >= 0 ? "+" : ""}{analysis.current.change24h.toFixed(2)}% / 24h
              </em>
            </div>
            <div className="hero-stat"><span>VOLUME 24H</span><strong>${formatCompact(analysis.current.quoteVolume24h)}</strong><small>quote volume</small></div>
            <div className="hero-stat"><span>ATR 15M</span><strong>{analysis.indicators.atrPercent.toFixed(2)}%</strong><small>{formatPrice(analysis.indicators.atr14)} USDT</small></div>
            <div className="hero-stat"><span>FUNDING / 8H</span><strong className={(analysis.funding.rate ?? 0) > 0 ? "negative-text" : "positive-text"}>{analysis.funding.rate === null ? "N/A" : `${((analysis.funding.rate ?? 0) * 100).toFixed(4)}%`}</strong><small>{analysis.funding.annualized === null ? "Spot market" : `${analysis.funding.annualized}% annualized`}</small></div>
          </section>

          <section className="chart-panel panel">
            <div className="panel-header chart-header">
              <div>
                <span className="eyebrow">PRICE ACTION</span>
                <h2>Biểu đồ 15 phút</h2>
              </div>
              <div className="chart-legend"><span><i className="ema-dot" /> EMA 20</span><span><i className="volume-dot" /> Volume</span></div>
              <div className="chart-tabs"><button>5m</button><button className="active">15m</button><button>1h</button><button>4h</button></div>
            </div>
            <MarketChart candles={analysis.chartCandles} />
            <div className="chart-footer">
              <span><Database size={13} /> {analysis.candlesAnalyzed.toLocaleString("vi-VN")} nến đã xử lý</span>
              <span><Waves size={13} /> Pattern 30 nến</span>
              <span><CircleDot size={13} /> Dự phóng {analysis.forwardBars} nến</span>
            </div>
          </section>

          <aside className="signal-panel panel">
            <div className="panel-header">
              <div><span className="eyebrow">SIGNAL ENGINE</span><h2>Điểm đồng thuận</h2></div>
              <span className="grade-badge">Hạng {analysis.grade}</span>
            </div>
            <div className="score-area">
              <div className={`score-ring ${signalClass}`} style={{ "--score-angle": `${analysis.score * 3.6}deg` } as CSSProperties}>
                <div><strong>{analysis.score}</strong><span>/ 100</span></div>
              </div>
              <div className={`signal-call ${signalClass}`}>
                {analysis.signal === "LONG" ? <TrendingUp size={19} /> : analysis.signal === "SHORT" ? <TrendingDown size={19} /> : <Gauge size={19} />}
                <div><span>TÍN HIỆU HỆ THỐNG</span><strong>{signalLabel}</strong></div>
              </div>
            </div>
            <div className="probability-list">
              <div><span>Khả năng tăng</span><strong>{analysis.probabilities.bullish}%</strong><i><b className="positive-bg" style={{ width: `${analysis.probabilities.bullish}%` }} /></i></div>
              <div><span>Đi ngang</span><strong>{analysis.probabilities.neutral}%</strong><i><b className="neutral-bg" style={{ width: `${analysis.probabilities.neutral}%` }} /></i></div>
              <div><span>Khả năng giảm</span><strong>{analysis.probabilities.bearish}%</strong><i><b className="negative-bg" style={{ width: `${analysis.probabilities.bearish}%` }} /></i></div>
            </div>
            <div className="confidence-line"><span>Độ tin cậy pattern</span><strong>{analysis.confidence}%</strong></div>
            <p className="signal-note">Tín hiệu chỉ kích hoạt khi pattern, xu hướng và momentum cùng hướng.</p>
          </aside>

          <section className="setup-panel panel">
            <div className="panel-header">
              <div><span className="eyebrow">RISK MAP</span><h2>Kịch bản giao dịch</h2></div>
              <span className={`scenario-status ${signalClass}`}><CircleDot size={12} /> {analysis.signal === "WAIT" ? "Theo dõi" : "Có điều kiện"}</span>
            </div>
            <div className="setup-grid">
              <div className="setup-level entry"><span><Target size={15} /> VÙNG VÀO</span><strong>{formatPrice(analysis.setup.entryLow)} — {formatPrice(analysis.setup.entryHigh)}</strong><small>Chờ nến xác nhận, không đuổi giá</small></div>
              <div className="setup-level stop"><span><ShieldCheck size={15} /> VÔ HIỆU / SL</span><strong>{formatPrice(analysis.setup.stopLoss)}</strong><small>Khoảng {analysis.indicators.atrPercent.toFixed(2)}% ATR</small></div>
              <div className="setup-level target"><span><Check size={15} /> MỤC TIÊU 1</span><strong>{formatPrice(analysis.setup.takeProfit1)}</strong><small>Risk : Reward 1 : 1.5</small></div>
              <div className="setup-level target"><span><Check size={15} /> MỤC TIÊU 2</span><strong>{formatPrice(analysis.setup.takeProfit2)}</strong><small>Risk : Reward 1 : {analysis.setup.riskReward}</small></div>
            </div>
            {analysis.signal === "WAIT" ? <div className="wait-banner"><AlertTriangle size={15} /> Các mức trên là bản đồ quan sát; chưa phải điểm vào hợp lệ khi hệ thống đang WAIT.</div> : null}
          </section>

          <section className="timeframe-panel panel">
            <div className="panel-header">
              <div><span className="eyebrow">MULTI-TIMEFRAME</span><h2>Đồng thuận xu hướng</h2></div>
              <Layers3 size={18} />
            </div>
            <div className="timeframe-grid">
              {analysis.timeframes.map((frame) => (
                <div key={frame.interval} className="timeframe-card">
                  <span>{frame.label}</span>
                  <strong className={frame.bias === "Tăng" ? "positive-text" : frame.bias === "Giảm" ? "negative-text" : "neutral-text"}>{frame.bias}</strong>
                  <small>RSI {frame.rsi}</small>
                  <em className={frame.change >= 0 ? "positive-text" : "negative-text"}>{frame.change >= 0 ? "+" : ""}{frame.change}%</em>
                </div>
              ))}
            </div>
          </section>

          <section className="ai-panel panel">
            <div className="panel-header">
              <div className="ai-title"><span className="ai-icon"><BrainCircuit size={18} /></span><div><span className="eyebrow">GEMINI INTERPRETER</span><h2>Diễn giải tín hiệu</h2></div></div>
              <span className={ai ? "ai-status online" : "ai-status"}><Sparkles size={12} /> {aiLoading ? "Đang diễn giải" : ai ? "Gemini online" : "Logic hệ thống"}</span>
            </div>
            {explanation ? (
              <div className="ai-content">
                <h3>{explanation.title}</h3>
                <p>{explanation.narrative}</p>
                <div className="driver-list">
                  {explanation.keyDrivers.map((driver) => <span key={driver}><Check size={13} /> {driver}</span>)}
                </div>
                <div className="invalidation"><ShieldCheck size={15} /><span><b>Điểm vô hiệu</b>{explanation.invalidation}</span></div>
                <div className="ai-caution"><AlertTriangle size={13} /> {explanation.caution}</div>
              </div>
            ) : null}
            <footer><Bot size={13} /> Gemini không được phép tạo hay sửa giá, xác suất và tín hiệu.</footer>
          </section>

          <section className="factor-panel panel">
            <div className="panel-header"><div><span className="eyebrow">FACTOR MATRIX</span><h2>Các thành phần chấm điểm</h2></div><Activity size={18} /></div>
            <div className="factor-list">
              {analysis.factors.map((factor) => (
                <div key={factor.label}><i className={factor.state} /><span>{factor.label}</span><strong>{factor.value}</strong></div>
              ))}
            </div>
          </section>

          <section className="orderbook-panel panel">
            <div className="panel-header">
              <div><span className="eyebrow">MARKET DEPTH</span><h2>Order book</h2></div>
              <span className={analysis.indicators.orderBookImbalance >= 0 ? "positive-text" : "negative-text"}>{analysis.indicators.orderBookImbalance >= 0 ? "Bid" : "Ask"} {Math.abs(analysis.indicators.orderBookImbalance)}%</span>
            </div>
            <div className="orderbook-head"><span>Giá (USDT)</span><span>Khối lượng</span><span>Tích lũy</span></div>
            <div className="orderbook-rows asks">
              {analysis.orderBook.asks.slice(-5).map((level) => <div key={`a-${level.price}`}><span>{formatPrice(level.price)}</span><span>{formatCompact(level.quantity)}</span><span>{formatCompact(level.total)}</span></div>)}
            </div>
            <div className={`book-mid ${analysis.current.change24h >= 0 ? "positive-text" : "negative-text"}`}>{formatPrice(analysis.current.price)} <ChevronDown size={14} /></div>
            <div className="orderbook-rows bids">
              {analysis.orderBook.bids.slice(0, 5).map((level) => <div key={`b-${level.price}`}><span>{formatPrice(level.price)}</span><span>{formatCompact(level.quantity)}</span><span>{formatCompact(level.total)}</span></div>)}
            </div>
          </section>

          <section className="method-panel panel">
            <div className="method-heading"><span><BookOpen size={17} /></span><div><small>MINH BẠCH PHƯƠNG PHÁP</small><h2>AI không quyết định tín hiệu</h2></div></div>
            <div className="method-flow">
              <div><Database size={17} /><span><b>01</b>Dữ liệu Binance</span></div>
              <i />
              <div><BarChart3 size={17} /><span><b>02</b>Pattern + chỉ báo</span></div>
              <i />
              <div><Gauge size={17} /><span><b>03</b>Điểm 0–100</span></div>
              <i />
              <div><BrainCircuit size={17} /><span><b>04</b>Gemini diễn giải</span></div>
            </div>
            <p>Mẫu 30 nến hiện tại được chuẩn hóa theo ATR và volume, đối chiếu với lịch sử {analysis.pattern.sampleSpanDays} ngày; sau đó đo kết quả {analysis.forwardBars} nến tiếp theo của {analysis.pattern.matches} mẫu gần nhất.</p>
          </section>
        </div>
      ) : null}

      <footer className="app-footer">
        <span><ShieldCheck size={14} /> Read-only · Không kết nối tài khoản giao dịch</span>
        <p>Phân tích xác suất, không phải lời khuyên tài chính. Futures có rủi ro mất vốn cao.</p>
        <span>PatternDesk v1.0</span>
      </footer>
    </main>
  );
}
