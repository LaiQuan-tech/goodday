"use client";

// App Router 最外層的 error boundary。root layout 以內任何沒被接住的 render 例外
// 都會走到這裡 —— 這是瀏覽器端「未捕捉例外送進 Sentry」的關鍵接線,
// 少了它,React render 期間炸掉的錯誤只會白畫面而不會回報。
// 這支會取代整個 root layout,所以要自帶 <html>/<body>,樣式也用 inline
// (globals.css 由 root layout 載入,這裡拿不到)。
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="zh-TW">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "2rem",
          textAlign: "center",
          fontFamily: "system-ui, -apple-system, 'Noto Sans TC', sans-serif",
          color: "#2b2724",
          background: "#fbf9f6",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>頁面發生錯誤</h1>
        <p style={{ fontSize: "0.875rem", color: "#6f6660", margin: 0 }}>
          我們已收到錯誤通知,請稍後再試一次。
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: "0.5rem",
            padding: "0.625rem 1.5rem",
            border: "1px solid #2b2724",
            borderRadius: "999px",
            background: "transparent",
            color: "#2b2724",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          重新載入
        </button>
      </body>
    </html>
  );
}
