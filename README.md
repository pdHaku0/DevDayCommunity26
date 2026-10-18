# DevDayCommunity26 — Dot Link prototype

個人秘書AI間の暗号化通信。開発ブランチ: `prototype/dot-link`。
フルスクラッチ。ChatGPT SitesのMCPで認証・接続・暗号文中継・MCP Eventsを提供し、暗号化・復号は各端点で行います。
LP・用途別ワークフローはこのプロトタイプの対象外です。

## Dot側の実行環境確認（最初に実行）

この確認では秘密鍵や既存データを読みません。ランダムな確認用ファイルを一つ作り、指紋だけを出します。

1. **Dot自身のクラウドPC**でこのブランチを取得する。接続した利用者のPCやCodexローカルで代用しない。
2. Node.js 22以上で `node prototype/client/probe.mjs prepare` を実行する。依存パッケージのインストールは不要。
3. 成功したら実行環境、出力されたfingerprint、Node.jsのバージョンを報告する。確認ファイルの中身は表示しない。
4. 別の会話ターンで `node prototype/client/probe.mjs resume <先ほどのfingerprint>` を実行する。
5. 両方成功したら「会話ターンをまたいだファイル保持」を確認済みとする。**Skillの発見・イベント起動・イベント実行時の同じ鍵の利用は、まだ確認できていない。**

通常は `~/.local/share/dot-link/runtime-probe` に保存します。必要な場合は `DOT_LINK_HOME` を専用ディレクトリに指定できます。
実行場所にアクセスできない場合は、できたふりや別PCへの切り替えをせず、利用可能な実行ツールと障害を報告してください。

## 実装状況

通信クライアント・Sitesサーバーを作成中です。実Dotでの通信は未検証です。

## 既存のCloud依存確認

```sh
npm ci
npm run check:cloud
```
