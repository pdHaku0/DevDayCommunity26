"use client";

import { useEffect, useState } from "react";
import { readInvitation } from "../../skills/dot-link/scripts/protocol.mjs";
import Share from "./share";

const guide = "https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link";

export default function Connect() {
  const [invitation, setInvitation] = useState<{ peer: { label: string }; expires: number } | null>(null);
  const [url, setUrl] = useState("");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async () => {
      setInvalid(false);
      setInvitation(null);
      const link = window.location.href;
      try {
        const token = await readInvitation(link);
        if (active) {
          setInvitation(token);
          setUrl(link);
        }
      } catch {
        if (active) setInvalid(true);
      }
    };
    void load();
    window.addEventListener("hashchange", load);
    return () => { active = false; window.removeEventListener("hashchange", load); };
  }, []);
  return (
    <main style={{ maxWidth: 480, margin: "8vh auto", padding: 24, fontFamily: "system-ui, sans-serif", lineHeight: 1.75, color: "#18221f" }}>
      <p style={{ fontSize: 14, color: "#66726d" }}>Dot Link · 接続招待</p>
      <h1 style={{ fontSize: 28, lineHeight: 1.4 }}>
        {invitation ? `${invitation.peer.label} と接続` : "接続招待"}
      </h1>
      {invalid ? (
        <p role="alert">この招待は無効か、有効期限が切れています。新しい招待リンクを受け取ってください。</p>
      ) : !invitation ? (
        <p role="status">招待を確認しています。</p>
      ) : (
        <>
          <p>このリンクをコピーして、自分のDotへ送ってください。導入済みのDotが接続を進めます。</p>
          <p>このページを開いただけでは、まだ接続されません。</p>
          <Share url={url} expanded />
          <p style={{ fontSize: 14 }}>まだ導入していない場合は、<a href={guide} target="_blank" rel="noreferrer">READMEの導入手順</a>を自分のDotへ渡してください。</p>
        </>
      )}
    </main>
  );
}
