import { mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
const directory =
  process.env.DOT_LINK_HOME || join(homedir(), ".local", "share", "dot-link");
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = join(directory, "runtime-probe");
if (process.argv[2] === "prepare") {
  try {
    const f = await open(path, "wx", 0o600);
    try {
      await f.writeFile(randomBytes(32));
      await f.sync();
    } finally {
      await f.close();
    }
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
} else if (process.argv[2] !== "resume")
  throw new Error("Use prepare or resume EXPECTED_FINGERPRINT");
const fingerprint = createHash("sha256")
  .update(await readFile(path))
  .digest("hex");
if (process.argv[2] === "resume" && fingerprint !== process.argv[3])
  throw new Error("Persisted state not available or changed");
console.log(
  JSON.stringify({
    ok: true,
    node: process.version,
    fingerprint,
    path,
    scope:
      "Filesystem persistence only; no proof of Skill discovery or event-triggered execution.",
  }),
);
