import { NextResponse } from "next/server";
import type { MarketAnalysis } from "../../../lib/market-types";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    narrative: { type: "string" },
    keyDrivers: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
    invalidation: { type: "string" },
    caution: { type: "string" },
  },
  required: ["title", "narrative", "keyDrivers", "invalidation", "caution"],
};

function compactAnalysis(analysis: MarketAnalysis) {
  return {
    symbol: analysis.symbol,
    market: analysis.market,
    generatedAt: new Date(analysis.generatedAt).toISOString(),
    candlesAnalyzed: analysis.candlesAnalyzed,
    signal: analysis.signal,
    score: analysis.score,
    confidence: analysis.confidence,
    current: analysis.current,
    probabilities: analysis.probabilities,
    setup: analysis.setup,
    indicators: analysis.indicators,
    funding: analysis.funding,
    pattern: analysis.pattern,
    timeframes: analysis.timeframes,
    factors: analysis.factors,
    warnings: analysis.warnings,
  };
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { configured: false, error: "Gemini chưa được cấu hình trên máy chủ." },
      { status: 503 },
    );
  }

  try {
    const body = await request.json() as { analysis?: MarketAnalysis };
    const analysis = body.analysis;
    if (!analysis || !analysis.symbol || typeof analysis.score !== "number") {
      return NextResponse.json({ error: "Dữ liệu phân tích không hợp lệ." }, { status: 400 });
    }

    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "Bạn là biên tập viên phân tích định lượng. Chỉ diễn giải JSON đã cho bằng tiếng Việt rõ ràng. Tuyệt đối không sửa, suy đoán hoặc tạo thêm giá, phần trăm, tín hiệu, mức entry/SL/TP. Không đưa lời hứa lợi nhuận hay lời khuyên tài chính cá nhân. Nếu tín hiệu WAIT, phải nói rõ là chưa có điểm vào hợp lệ.",
            }],
          },
          contents: [{
            role: "user",
            parts: [{ text: `Diễn giải ngắn gọn kết quả sau, giữ nguyên mọi con số:\n${JSON.stringify(compactAnalysis(analysis))}` }],
          }],
          generationConfig: {
            temperature: 0.15,
            maxOutputTokens: 700,
            responseMimeType: "application/json",
            responseSchema: OUTPUT_SCHEMA,
          },
        }),
      },
    );

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Gemini ${response.status}: ${message.slice(0, 180)}`);
    }
    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini không trả về nội dung.");
    return NextResponse.json({ configured: true, ...JSON.parse(text) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể diễn giải bằng Gemini.";
    return NextResponse.json({ configured: true, error: message }, { status: 502 });
  }
}
