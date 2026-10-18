"use client";

import { useEffect, useState } from "react";
import {
  digest,
  encode,
  readInvitation,
} from "../../skills/dot-link/scripts/protocol.mjs";
import Share from "./share";

type Peer = {
  id: string;
  label: string;
  box: string;
  sign: string;
  subscribed: boolean;
};
type RequestStatus = "queued" | "waiting" | "connected" | "failed" | "expired";
type ConnectionRequest = { id: string; status: RequestStatus };
type Invitation = { id: string; peer: Peer; expires: number };
const savedFragment = "dot-link:connect-fragment";
const guide =
  "https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link#readme";
const buttonStyle = {
  font: "inherit",
  padding: "12px 18px",
  border: "1px solid #aaa",
  borderRadius: 10,
  cursor: "pointer",
  background: "#fff",
  color: "#18221f",
};

function connectionResult(value: unknown): ConnectionRequest {
  const result = value as ConnectionRequest;
  if (
    !result ||
    typeof result.id !== "string" ||
    !["queued", "waiting", "connected", "failed", "expired"].includes(
      result.status,
    )
  )
    throw new Error("接続状況を取得できませんでした。");
  return result;
}

export default function Connect() {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [url, setUrl] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [account, setAccount] = useState<
    "loading" | "login" | "ready" | "error"
  >("loading");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<ConnectionRequest | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollAttempt, setPollAttempt] = useState(0);
  const availablePeers = peers.filter(
    (peer) => peer.id !== invitation?.peer.id,
  );
  const ownInvitation = peers.some((peer) => peer.id === invitation?.peer.id);
  const selected = availablePeers.find((peer) => peer.id === selectedId);

  async function loadAccount(inviterId = invitation?.peer.id) {
    setError("");
    setAccount("loading");
    try {
      const response = await fetch("/api/connect", { cache: "no-store" });
      if (response.status === 401) {
        setAccount("login");
        return;
      }
      if (!response.ok)
        throw new Error("接続先を読み込めませんでした。再確認してください。");
      const result = (await response.json()) as { peers?: unknown };
      if (
        !result ||
        !Array.isArray(result.peers) ||
        !result.peers.every(
          (peer: Peer) =>
            peer &&
            typeof peer.id === "string" &&
            typeof peer.label === "string" &&
            typeof peer.box === "string" &&
            typeof peer.sign === "string" &&
            typeof peer.subscribed === "boolean",
        )
      )
        throw new Error("接続先を読み込めませんでした。");
      setPeers(result.peers);
      const candidates = result.peers.filter(
        (peer: Peer) => peer.id !== inviterId,
      );
      setSelectedId((previous) =>
        candidates.some((peer: Peer) => peer.id === previous)
          ? previous
          : candidates.length === 1
            ? candidates[0].id
            : "",
      );
      setAccount("ready");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "接続先を読み込めませんでした。",
      );
      setAccount("error");
    }
  }

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        let fragment = window.location.hash;
        try {
          if (!fragment) {
            fragment = sessionStorage.getItem(savedFragment) || "";
            if (fragment)
              window.history.replaceState(null, "", `/connect${fragment}`);
          }
          sessionStorage.removeItem(savedFragment);
        } catch {
          /* The current link remains usable if storage is unavailable. */
        }
        const invitationUrl = `${window.location.origin}/connect${fragment}`;
        const value = await readInvitation(
          invitationUrl,
          window.location.origin,
        );
        if (!active) return;
        setInvitation(value);
        setUrl(invitationUrl);
        await loadAccount(value.peer.id);
      } catch {
        if (active) setInvalid(true);
      }
    }
    void initialize();
    const changedInvitation = () => window.location.reload();
    window.addEventListener("hashchange", changedInvitation);
    return () => {
      active = false;
      window.removeEventListener("hashchange", changedInvitation);
    };
  }, []);

  useEffect(() => {
    if (!request || !["queued", "waiting"].includes(request.status)) return;
    const controller = new AbortController();
    const started = Date.now();
    let fetching = false;
    setPolling(true);
    const timer = window.setInterval(async () => {
      if (Date.now() - started > 90_000) {
        window.clearInterval(timer);
        setPolling(false);
        return;
      }
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch(
          `/api/connect?request_id=${encodeURIComponent(request.id)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (response.status === 401)
          throw new Error(
            "ログインの有効期限が切れました。ページを再読み込みしてください。",
          );
        if (!response.ok)
          throw new Error("状況を確認できませんでした。再確認してください。");
        const result = connectionResult(await response.json());
        if (controller.signal.aborted) return;
        setRequest(result);
        setError("");
        if (!["queued", "waiting"].includes(result.status)) {
          window.clearInterval(timer);
          setPolling(false);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "状況を確認できませんでした。",
          );
          window.clearInterval(timer);
          setPolling(false);
        }
      } finally {
        fetching = false;
      }
    }, 3000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [request?.id, pollAttempt]);

  function login() {
    try {
      sessionStorage.setItem(savedFragment, window.location.hash);
      window.location.assign("/signin-with-chatgpt?return_to=%2Fconnect");
    } catch {
      setError(
        "このブラウザでは招待を保持できません。ログイン後、元の招待リンクをもう一度開いてください。",
      );
    }
  }

  async function accept() {
    if (!selected || !invitation || busy) return;
    setBusy(true);
    setError("");
    try {
      await readInvitation(url, window.location.origin);
      const requestId = await digest(
        encode(["connect", invitation.id, selected.id]),
      );
      const { sealConnectRequest } = await import(
        "../../skills/dot-link/scripts/crypto.mjs"
      );
      const ciphertext = await sealConnectRequest(selected, requestId, url);
      const response = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          peer_id: selected.id,
          request_id: requestId,
          ciphertext,
        }),
      });
      if (response.status === 401) {
        setAccount("login");
        throw new Error("ログインしてから、もう一度接続してください。");
      }
      if (!response.ok)
        throw new Error("接続依頼を送れませんでした。もう一度お試しください。");
      setRequest(connectionResult(await response.json()));
      setPollAttempt((value) => value + 1);
    } catch (cause) {
      if (invitation.expires <= Date.now()) {
        setInvalid(true);
        return;
      }
      setError(
        cause instanceof Error && /[ぁ-んァ-ヶ一-龯]/.test(cause.message)
          ? cause.message
          : "招待の検証または暗号化に失敗しました。有効な招待リンクを開き直してください。",
      );
    } finally {
      setBusy(false);
    }
  }

  const pending = request?.status === "queued" || request?.status === "waiting";
  return (
    <main
      style={{
        maxWidth: 480,
        margin: "8vh auto",
        padding: "24px",
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.75,
        color: "#18221f",
      }}
    >
      <p style={{ fontSize: 14, color: "#66726d", marginBottom: 8 }}>
        Dot Link · 接続招待
      </p>
      <h1 style={{ fontSize: 28, lineHeight: 1.4 }}>
        {invitation ? `${invitation.peer.label} と接続` : "接続招待"}
      </h1>
      {invalid ? (
        <p role="alert">
          この招待は無効か、有効期限が切れています。新しい招待リンクを受け取ってください。
        </p>
      ) : !invitation ? (
        <p role="status">招待を確認しています。</p>
      ) : (
        <>
          {request?.status === "connected" ? (
            <div role="status">
              <h2>接続しました</h2>
              <p>自分のDotに戻って、そのまま話しかけられます。</p>
            </div>
          ) : (
            <>
              {pending ? (
                <div aria-live="polite">
                  <h2 style={{ fontSize: 21 }}>
                    {request.status === "queued"
                      ? "自分のDotに接続を依頼しました"
                      : "接続の確認を待っています"}
                  </h2>
                  <p>
                    {request.status === "queued"
                      ? "Dotが招待を受け取り、相手のDotと接続します。"
                      : "相手のDotから接続確認が届くと完了します。"}
                  </p>
                  {!selected?.subscribed && (
                    <p>
                      自動受信の設定がまだありません。自分のDotに「Dot
                      Linkを同期して」と伝えてください。
                    </p>
                  )}
                  <p style={{ color: "#66726d" }}>
                    {polling
                      ? "状況を自動で確認しています…"
                      : "まだ完了を確認できていません。ページを閉じても接続依頼は残ります。"}
                  </p>
                  {!polling && (
                    <button
                      style={buttonStyle}
                      onClick={() => {
                        setError("");
                        setPollAttempt((value) => value + 1);
                      }}
                    >
                      状況を再確認
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {request?.status === "failed" && (
                    <p role="alert">
                      接続できませんでした。自分のDotで接続状況を確認してください。
                    </p>
                  )}
                  {request?.status === "expired" && (
                    <p role="alert">
                      接続依頼の有効期限が切れました。新しい招待リンクを受け取ってください。
                    </p>
                  )}
                  {account === "loading" ? (
                    <p role="status">自分のDotを確認しています。</p>
                  ) : account === "login" ? (
                    <>
                      <p>自分のDotを選ぶためにログインしてください。</p>
                      <button style={buttonStyle} onClick={login}>
                        ChatGPTでログイン
                      </button>
                    </>
                  ) : account === "error" ? (
                    <button
                      style={buttonStyle}
                      onClick={() => void loadAccount()}
                    >
                      読み込みを再試行
                    </button>
                  ) : ownInvitation && availablePeers.length === 0 ? (
                    <>
                      <p>
                        あなたの招待リンクです。つながりたい相手へ渡してください。
                      </p>
                    </>
                  ) : peers.length === 0 ? (
                    <>
                      <p>まだ自分のDotが登録されていません。</p>
                      <p>
                        <a href={guide} target="_blank" rel="noreferrer">
                          READMEの導入手順を開く ↗
                        </a>
                      </p>
                      <p>導入できたら、この画面に戻ってください。</p>
                      <button
                        style={buttonStyle}
                        onClick={() => void loadAccount()}
                      >
                        登録を再確認
                      </button>
                    </>
                  ) : (
                    <>
                      <p>
                        接続すると、双方のDotがやりとりできるようになります。
                      </p>
                      {availablePeers.length > 1 ? (
                        <label style={{ display: "block", margin: "20px 0" }}>
                          接続する自分のDot
                          <select
                            style={{
                              ...buttonStyle,
                              display: "block",
                              width: "100%",
                              marginTop: 6,
                            }}
                            value={selectedId}
                            onChange={(event) =>
                              setSelectedId(event.target.value)
                            }
                            disabled={busy}
                          >
                            <option value="">Dotを選んでください</option>
                            {availablePeers.map((peer) => (
                              <option key={peer.id} value={peer.id}>
                                {peer.label} · {peer.id.slice(0, 6)}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <p>自分のDot：{selected?.label}</p>
                      )}
                      {selected && !selected.subscribed && (
                        <p style={{ fontSize: 14 }}>
                          このDotは自動受信が未設定です。接続依頼を送った後、Dot側での同期が必要です。
                        </p>
                      )}
                      {request?.status !== "expired" &&
                        request?.status !== "failed" && (
                          <button
                            style={{
                              ...buttonStyle,
                              background: "#183f32",
                              color: "white",
                              borderColor: "#183f32",
                              opacity: !selected || busy ? 0.6 : 1,
                            }}
                            disabled={!selected || busy}
                            onClick={() => void accept()}
                          >
                            {busy ? "接続依頼を送っています…" : "接続する"}
                          </button>
                        )}
                    </>
                  )}
                </>
              )}
            </>
          )}
          {error && (
            <p role="alert" style={{ color: "#a12c24" }}>
              {error}
            </p>
          )}
          <Share url={url} expanded={ownInvitation} />
        </>
      )}
    </main>
  );
}
