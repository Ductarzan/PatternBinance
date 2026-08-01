# PatternDesk — Binance Pattern AI

Web app phân tích dữ liệu công khai Binance Spot và USDⓈ-M Futures. Lõi tín hiệu chạy hoàn toàn bằng quy tắc cố định; Gemini chỉ diễn giải kết quả đã tính.

## Logic chính

- 5.000 nến 15 phút cho mỗi lần quét.
- Pattern 30 nến chuẩn hóa theo ATR và volume, đối chiếu lịch sử rồi đo 12 nến tiếp theo.
- Xác nhận đa khung 5m / 15m / 1h / 4h.
- Kết hợp RSI, EMA, MACD, ATR, volume, funding và order book.
- Điểm đồng thuận 0–100, vùng vào, vô hiệu hóa và hai mục tiêu.
- Không cần Binance API key vì app chỉ đọc market data công khai.

## Chạy local

Yêu cầu Node.js 22.13 trở lên.

```bash
npm install
copy .env.example .env.local
npm run dev
```

Thêm `GEMINI_API_KEY` vào `.env.local` nếu muốn bật phần diễn giải AI. Không có key, toàn bộ phân tích định lượng vẫn hoạt động và app hiển thị diễn giải deterministic.

## Build và triển khai

```bash
npm run build
```

Project giữ cấu trúc Next-compatible để triển khai Vercel và cấu hình vinext/Sites để đóng gói Cloudflare Worker-compatible.

## An toàn

App không đặt lệnh, không đọc tài khoản và không lưu API key phía trình duyệt. Tín hiệu là phân tích xác suất, không phải lời khuyên tài chính.
