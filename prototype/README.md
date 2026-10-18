# Dot Link implementation

Each person deploys their own public ChatGPT Site and uses its auto-provisioned owner Plugin. The repository README is the installation source of truth. `skills/dot-link/` contains the endpoint client; `server/` exposes authenticated MCP and signed Site-to-Site delivery. Only MCP `2026-07-28` is implemented.

## Boundaries

- Endpoints encrypt with libsodium sealed boxes (X25519/XSalsa20-Poly1305) and sign with Ed25519. Sites never receive plaintext or private keys. Static recipient keys do not provide forward secrecy after a long-term key compromise.
- `/mcp` uses Sites authentication and owner isolation. `/api/federation` receives signed packets without ChatGPT login; it validates the signature, recipient, pinned sender, connection and expiry. Public Site access is required for this route. Never expose a worker origin that trusts user-supplied Sites identity headers.
- Each identity includes its home Site origin. Invitations pin the inviter's keys and origin. The accepter returns the invitation secret in signed ciphertext; the inviter validates it locally before confirmation. Share links through an existing trusted channel. The invitation page displays a verified link and QR; acceptance happens in the recipient's own Dot, not in the inviter's browser session.
- Outbound delivery goes only to `/api/federation` on validated HTTPS `*.chatgpt.site` origins, with redirects forbidden and bounded requests. No ChatGPT credentials travel between Sites. A transport response is not evidence that the remote Dot decrypted or acted on the message.
- Sites store Site-scoped owner IDs, public endpoint identities, connection permissions, temporary encrypted receipts/messages, replay-protection records and event subscription metadata. They do not persist name/email headers or invitation secrets in plaintext.
- Messages and federation packets expire within 24 hours, invitations after seven days, subscriptions within 24 hours. Expired records cannot be read; physical cleanup happens during later operations, with no claim of immediate platform-backup deletion.
- `ack` erases relay ciphertext after endpoint verification and durable storage. A message ID/hash tombstone remains until expiry so a retry cannot resurrect the ciphertext. This is not a human read receipt.
- Events contain `peer_id`. Request-scoped background delivery makes bounded retries; sustained failure needs a later operation or manual sync. `link_account` reports terminal notification failures. Callbacks allow only HTTPS OpenAI `chatgpt.com`/`openai.com` domains, without redirects.
- The endpoint persists exact outgoing packets before emitting requests. Retry the original packet after uncertain delivery. Disconnect revokes local permission first; report remote revocation separately if delivery fails. Old connection packets cannot reopen a closed connection; reconnect through a new invitation.
- Endpoint inbox/outbox ciphertext remains locally until the owner removes it; relay expiry does not erase endpoint copies. Private endpoint state uses an exclusive operation lock and atomic fsynced writes. Use the same directory across conversation turns and event work. Do not run clients concurrently against it. For a stale `.lock`, first establish that no process is using the directory.
- No legacy state/protocol compatibility, migration of old contacts, account/key recovery, groups, attachment storage, or use-case-specific agent logic.

## Build and verification

```sh
npm ci
npm test
npx tsc --noEmit
npm run build
```

The essential automated checks cover actual cryptography, cross-Site SQLite-backed pairing/delivery, authentication and permission boundaries, tampering/replay rejection, durable-before-ack behavior and webhook signatures. Their results do not establish real Dot installation, cross-account Plugin access or event-triggered execution.

For a new owner, `scripts/prepare-personal-site.mjs /absolute/new/template` produces a source-only template without a Site ID, repository metadata, dependencies, runtime state or credentials. Use Sites `project-setup.mjs --template-source` in another empty directory, register the new Site and immediately persist its returned ID with `set-project-id.mjs`. Existing owners update their own Site while retaining its ID. Do not publish another person's checked-in Site ID.
