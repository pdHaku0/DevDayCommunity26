# Dot Link implementation

`skills/dot-link/` is the distributable client and skill. `server/` implements the authenticated MCP endpoint; `db/schema.ts` is the current database schema. Only MCP `2026-07-28` is implemented.

```sh
npm ci
npm test
npx tsc --noEmit
npm run build
```

See the repository README for installation and runtime checks.

## Boundaries

- The client uses libsodium sealed boxes (X25519/XSalsa20-Poly1305) and Ed25519 signatures. The relay never receives plaintext or private keys. This is not a ratcheting protocol and does not provide forward secrecy against later compromise of a recipient's long-term key.
- The Web page uses the same Site-scoped authenticated user ID as MCP. Owner approvals require a same-origin JSON POST; invitation URLs are encrypted to the selected endpoint before transmission. Only this dedicated owner queue can authorize the endpoint to accept an invitation. Peer message bodies cannot create these approvals. Queue ciphertext expires after 24 hours and is erased after endpoint processing; connected is displayed only when both permissions are active.
- Invitations pin the inviter's keys. The accepter returns the invitation secret inside signed ciphertext; the inviter verifies it locally before confirming. The relay stores only the invitation hash, not the secret. Share invitation URLs over an existing trusted channel; possession of a forwarded URL does not prove a person's real identity.
- Account authentication is supplied by Sites on `/mcp`. Deployment must remain behind Sites dispatch; do not expose a worker origin that accepts user-supplied identity headers.
- The server stores a Site-scoped owner ID, endpoint public keys/labels, connection permissions, temporary invitation receipts, ciphertext, and event subscription metadata. It does not persist name/email headers.
- Messages expire after 24 hours; invitation records after seven days; event subscriptions after at most 24 hours. Expired records cannot be read; physical row cleanup occurs on subsequent client operations. This is not a promise of immediate deletion from platform backups.
- `ack` erases relay ciphertext after the client durably stores and verifies it. A message ID/hash tombstone remains until expiry to prevent a retry from resurrecting acknowledged content. It is not a human read receipt.
- Events contain only `peer_id`. Pending notifications persist; request-scoped background processing makes bounded retries. After sustained failure, a subsequent client operation or manual synchronization is required; no independent scheduler is deployed. `link_account` reports terminal notification failures.
- Callback destinations are restricted to HTTPS on OpenAI-owned `chatgpt.com`/`openai.com` domains, with redirects forbidden. A different genuine platform callback host must be inspected and added explicitly; arbitrary user webhooks are unsupported.
- Endpoint copies and keys remain in the endpoint's private directory. Client state uses an exclusive operation lock and atomic, fsynced writes. Do not run two processes against the same state directory concurrently. If a process was killed and left `.lock`, confirm no client is running before removing only that empty lock directory.
- No backward compatibility, account/key recovery, group messaging, attachment storage, or product-specific agent logic is included.

## Verification scope

The automated checks exercise the real client cryptography, SQLite-backed server operations, persistence-before-ack, cross-account isolation, and webhook signatures/lifecycle. They do not simulate successful Dot installation or real webhook delivery.
