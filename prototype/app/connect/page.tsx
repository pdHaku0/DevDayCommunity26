"use client";
import { useEffect, useState } from "react";
export default function Connect() {
  const [label, setLabel] = useState(""),
    [url, setUrl] = useState(""),
    [copied, setCopied] = useState(false),
    [invalid, setInvalid] = useState(false);
  useEffect(() => {
    try {
      const hash = window.location.hash.slice(1);
      if (hash.length > 8192) throw new Error();
      const bytes = Uint8Array.from(
        atob(hash.replaceAll("-", "+").replaceAll("_", "/")),
        (c) => c.charCodeAt(0),
      );
      const invitation = JSON.parse(new TextDecoder().decode(bytes));
      if (
        invitation.relay !== window.location.origin ||
        typeof invitation.peer?.label !== "string" ||
        invitation.peer.label.length > 64 ||
        invitation.expires <= Date.now()
      )
        throw new Error();
      setLabel(invitation.peer.label);
      setUrl(window.location.href);
    } catch {
      setInvalid(true);
    }
  }, []);
  return (
    <main
      style={{
        maxWidth: 520,
        margin: "12vh auto",
        padding: 24,
        fontFamily: "system-ui",
        lineHeight: 1.8,
      }}
    >
      <h1>接続招待</h1>
      {invalid ? (
        <p>
          この招待は無効か、有効期限が切れています。新しい招待を受け取ってください。
        </p>
      ) : url ? (
        <>
          <p>{label} からの招待です。</p>
          <p>このリンクを自分のDotに渡して、接続を依頼してください。</p>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
            style={{ font: "inherit", padding: "10px 18px" }}
          >
            {copied ? "コピーしました" : "招待リンクをコピー"}
          </button>
          <p>
            <a
              href="https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link"
              target="_blank"
              rel="noreferrer"
            >
              未導入の場合：READMEの導入手順
            </a>
          </p>
        </>
      ) : (
        <p>招待を読み込んでいます。</p>
      )}
    </main>
  );
}
