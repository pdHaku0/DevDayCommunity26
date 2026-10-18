import { registration } from "./crypto.mjs";
import { publicIdentity, validateRelay } from "./protocol.mjs";
import {
  transact,
  initialize,
  invite,
  accept,
  ingest,
  send,
  inbox,
  call,
  retry,
  disconnect,
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
      if (!args[0] || !args[1]) throw new Error("Usage: init LABEL OWN_SITE_URL");
      const relay = validateRelay(args[1]);
      if (!state) state = await initialize(args[0], relay);
      else if (state.identity.relay !== relay)
        throw new Error("State belongs to another site; use a separate DOT_LINK_HOME");
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
          relay: state.identity.relay,
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
      case "retry":
        output = await retry(state, args[0]);
        break;
      case "inbox":
        output = await inbox(state);
        break;
      case "read": {
        if (!state.inbox[args[0]]) throw new Error("Unknown message");
        state.inbox[args[0]].read = true;
        output = { read: true };
        break;
      }
      case "disconnect":
        output = await disconnect(state, args[0]);
        break;
      default:
        throw new Error(
          "Commands: init LABEL OWN_SITE_URL, status, invite, accept URL, sync, ingest < result.json, send PEER < body.json, retry PACKET_ID, inbox, read ID, disconnect PEER",
        );
    }
    return { state, output };
  });
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
