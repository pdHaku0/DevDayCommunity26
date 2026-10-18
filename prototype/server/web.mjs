import { Service } from "./service.mjs";
import { drain } from "./events.mjs";

const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export async function handleConnect(request, db, ctx) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return json({ error: "ChatGPTでログインしてください。" }, 401);
  const service = new Service(db);
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      const requestId = url.searchParams.get("request_id");
      if (requestId)
        return json(await service.connectionStatus(owner, requestId));
      const account = await service.account(owner);
      return json({
        peers: account.peers.map((p) => ({
          ...p,
          subscribed: account.subscriptions.some((s) => s.peer === p.id),
        })),
      });
    }
    if (request.method !== "POST")
      return json({ error: "Method not allowed" }, 405);
    // Sites verifies identity before dispatch. Browser writes additionally need
    // a same-origin JSON request; neither cross-site forms nor peer MCP tools
    // can create owner-approved requests in this queue.
    if (
      request.headers.get("origin") !== url.origin ||
      ![null, "same-origin"].includes(request.headers.get("sec-fetch-site")) ||
      !request.headers.get("content-type")?.startsWith("application/json")
    )
      return json({ error: "このページから操作してください。" }, 403);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "入力がありません。" }, 400);
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 24000) {
        await reader.cancel();
        return json({ error: "入力が大きすぎます。" }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = await service.queueConnection(
      owner,
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    ctx?.waitUntil(drain(service).catch(() => {}));
    return json(result);
  } catch (e) {
    const status =
      e.code === "forbidden"
        ? 403
        : e.code === "not_found"
          ? 404
          : ["limit", "conflict"].includes(e.code)
            ? 409
            : 400;
    return json(
      {
        error:
          status === 404
            ? "接続要求が見つからないか、期限切れです。"
            : "接続要求を処理できませんでした。画面を再確認してください。",
      },
      status,
    );
  }
}
