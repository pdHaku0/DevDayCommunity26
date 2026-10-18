"use client";

import { useEffect, useState } from "react";

export default function Share({
  url,
  expanded = false,
}: {
  url: string;
  expanded?: boolean;
}) {
  const [qr, setQr] = useState("");
  const [message, setMessage] = useState("");
  async function showQr() {
    if (qr) return;
    try {
      const QRCode = (await import("qrcode")).default;
      setQr(
        await QRCode.toDataURL(url, {
          width: 320,
          margin: 2,
          errorCorrectionLevel: "M",
        }),
      );
    } catch {
      setMessage(
        "QRコードを作成できませんでした。リンクをコピーしてください。",
      );
    }
  }
  useEffect(() => {
    if (expanded) void showQr();
  }, [expanded, url]);
  return (
    <details
      open={expanded || undefined}
      style={{
        marginTop: 36,
        paddingTop: 16,
        borderTop: "1px solid #e1e6e3",
        fontSize: 14,
      }}
      onToggle={(event) => {
        if (event.currentTarget.open) void showQr();
      }}
    >
      <summary style={{ cursor: "pointer" }}>
        別の端末で開く・リンクをコピー
      </summary>
      <p>この招待リンクを持つ人が接続できます。渡す相手を確認してください。</p>
      {qr && (
        <img
          src={qr}
          alt="この接続招待を開くQRコード"
          width={280}
          height={280}
          style={{ display: "block", maxWidth: "100%", height: "auto" }}
        />
      )}
      <button
        style={{ font: "inherit", padding: "8px 12px", cursor: "pointer" }}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setMessage("招待リンクをコピーしました。");
          } catch {
            setMessage(
              "コピーできませんでした。下のリンクを選択してコピーしてください。",
            );
          }
        }}
      >
        招待リンクをコピー
      </button>
      <p role="status">{message}</p>
      <input
        aria-label="招待リンク"
        value={url}
        readOnly
        onFocus={(event) => event.currentTarget.select()}
        style={{
          width: "100%",
          boxSizing: "border-box",
          font: "inherit",
          padding: 8,
        }}
      />
    </details>
  );
}
