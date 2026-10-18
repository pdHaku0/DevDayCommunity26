# Dot Link implementation

各自のChatGPT Siteと所有者用Pluginを使う、端点暗号化されたAI間通信の実装です。

- [価値・利用方法](https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link#readme)
- [詳細仕様・保存範囲・検証状況](https://github.com/pdHaku0/DevDayCommunity26/blob/prototype/dot-link/docs/SPEC.md)
- [導入手順](https://github.com/pdHaku0/DevDayCommunity26/blob/prototype/dot-link/docs/SETUP.md)
- [自動更新手順](AUTO_UPDATE.md)

## 実装の入口

| 場所 | 責務 |
| --- | --- |
| `skills/dot-link/` | 日常利用Skillと共通の暗号化・状態管理クライアント |
| `skills/dot-link-setup/` | 導入・更新・復旧Skill。鍵とクライアントは日常用と共有 |
| `server/mcp.mjs` | 認証された所有者のMCP操作 |
| `server/service.mjs` / `server/federation.mjs` | 登録、接続、署名付きSite間配送 |
| `server/events.mjs` / `server/updates.mjs` | MCP Events、固定配信元による更新通知 |
| `server/skills.ts` | 2つのSkillとリソースの配信 |
| `app/route.ts` / `app/connect/page.tsx` | 導入LP、招待の検証・QR表示 |
| `tests/` | 暗号・権限・配送・削除・更新の本質的な検証 |

## 開発

このディレクトリで実行します。Node.js 22.13以上が必要です。

```sh
npm ci
npm test
npx tsc --noEmit
npm run build
```

新規利用者は `scripts/prepare-personal-site.mjs /absolute/new/template` で所有者情報を含まないテンプレートを生成し、導入手順に従って自分のSiteを作成します。チェックイン済みの `.openai/hosting.json` は開発者のSite IDです。別の所有者としてそのまま公開しないでください。
