import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "latin-ext"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "latin-ext"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "PatternDesk — Binance Pattern AI";
  const description = "Terminal phân tích Binance với pattern 30 nến trên 5.000 nến 15m, đa khung thời gian và Gemini chỉ làm lớp diễn giải.";

  return {
    metadataBase: new URL(origin),
    title,
    description,
    applicationName: "PatternDesk",
    openGraph: {
      title,
      description,
      type: "website",
      locale: "vi_VN",
      images: [{ url: `${origin}/og.png`, width: 1742, height: 911, alt: "PatternDesk Binance Pattern AI terminal" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
