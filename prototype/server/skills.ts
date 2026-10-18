import skill from "../skills/dot-link/SKILL.md?raw";
import autoUpdate from "../AUTO_UPDATE.md?raw";
import safeErrors from "../skills/dot-link/scripts/safe-errors.mjs?raw";
import doctor from "../skills/dot-link/scripts/doctor.mjs?raw";
import cli from "../skills/dot-link/scripts/cli.mjs?raw";
import state from "../skills/dot-link/scripts/state.mjs?raw";
import cryptography from "../skills/dot-link/scripts/crypto.mjs?raw";
import protocol from "../skills/dot-link/scripts/protocol.mjs?raw";
import pkg from "../skills/dot-link/package.json?raw";
import lock from "../skills/dot-link/package-lock.json?raw";
const root = "skill://dot-link/dot-link/";
const files: Record<string, string> = {
  "SKILL.md": skill,
  "AUTO_UPDATE.md": autoUpdate,
  "scripts/cli.mjs": cli,
  "scripts/doctor.mjs": doctor,
  "scripts/safe-errors.mjs": safeErrors,
  "scripts/state.mjs": state,
  "scripts/crypto.mjs": cryptography,
  "scripts/protocol.mjs": protocol,
  "package.json": pkg,
  "package-lock.json": lock,
};
async function entry() {
  const resources = await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(text),
      );
      return {
        uri: root + path,
        digest:
          "sha256:" +
          Array.from(new Uint8Array(hash), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join(""),
      };
    }),
  );
  return {
    uri: root + "SKILL.md",
    frontmatter: {
      name: "dot-link",
      description: skill.match(/^description: (.+)$/m)![1],
    },
    resources,
  };
}
export async function skillMethod(method: string, params: { uri?: string }) {
  if (method === "skills/list") return { skills: [await entry()] };
  if (method === "skills/get" && params.uri === root + "SKILL.md")
    return { skill: await entry() };
  if (method === "resources/read" && params.uri?.startsWith(root)) {
    const text = files[params.uri.slice(root.length)];
    if (text !== undefined)
      return { contents: [{ uri: params.uri, mimeType: "text/plain", text }] };
  }
  throw new Error("Unknown skill resource");
}
