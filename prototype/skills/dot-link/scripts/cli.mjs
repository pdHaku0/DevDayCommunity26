import { readFile } from "node:fs/promises";
import { registration } from "./crypto.mjs";
import { publicIdentity } from "./protocol.mjs";
import {
  transact,
  initialize,
  invite,
  accept,
  ingest,
  send,
  inbox,
  call,
} from "./state.mjs";
const [command, ...args] = process.argv.slice(2);
const input = async () => {
  let s = "";
  for await (const c of process.stdin) {
    s += c;
    // A sync can contain 50 ciphertexts plus pending pairing receipts.
    const limit = command === "ingest" ? 8 * 1024 * 1024 : 256 * 1024;
    if (Buffer.byteLength(s) > limit) throw new Error("Input too large");
  }
  return s;
};
try {
  const stdin = ["ingest", "send"].includes(command) ? await input() : null;
  const result = await transact(async (state) => {
    if (command === "init") {
      const relay =
        args[1] ||
        JSON.parse(
          await readFile(new URL("../relay.json", import.meta.url), "utf8"),
        ).origin;
      if (!state) state = await initialize(args[0] || "My dot", relay);
      else if (state.relay !== new URL(relay).origin)
        throw new Error(
          "State belongs to another relay; use a separate DOT_LINK_HOME",
        );
      return {
        state,
        output: {
          tool: "link_register",
          arguments: registration(state.identity),
        },
      };
    }
    if (!state) throw new Error("Run init first");
    let output;
    switch (command) {
      case "status":
        output = {
          identity: publicIdentity(state.identity),
          relay: state.relay,
          contacts: Object.values(state.peers),
          unread: Object.values(state.inbox).filter((m) => !m.read).length,
        };
        break;
      case "invite":
        output = await invite(state);
        break;
      case "accept":
        output = await accept(state, args[0]);
        break;
      case "sync":
        output = call("sync", { peer_id: state.identity.id });
        break;
      case "ingest":
        output = await ingest(state, JSON.parse(stdin));
        break;
      case "send":
        output = await send(state, args[0], JSON.parse(stdin));
        break;
      case "retry": {
        const envelope = state.outbox[args[0]];
        if (!envelope) throw new Error("Unknown outgoing message");
        output = call("send", { envelope });
        break;
      }
      case "inbox":
        output = await inbox(state);
        break;
      case "read": {
        if (!state.inbox[args[0]]) throw new Error("Unknown message");
        state.inbox[args[0]].read = true;
        output = { read: true };
        break;
      }
      case "disconnect": {
        if (!state.peers[args[0]]) throw new Error("Unknown contact");
        state.peers[args[0]].active = false;
        output = call("disconnect", {
          peer_id: state.identity.id,
          other: args[0],
        });
        break;
      }
      default:
        throw new Error(
          "Commands: init [label] [relay], status, invite, accept URL, sync, ingest < result.json, send PEER < body.json, retry ID, inbox, read ID, disconnect PEER",
        );
    }
    return { state, output };
  });
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
