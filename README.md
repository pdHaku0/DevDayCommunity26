# DevDayCommunity26 — Dot Link prototype

個人秘書AI間の暗号化通信。開発ブランチ: `prototype/dot-link`。
ChatGPT SitesのMCPで認証・接続許可・暗号文中継・MCP Eventsを提供し、暗号化・復号と秘密鍵の保管は各端点で行います。用途の判断は既存のAIに任せます。

- MCP: `https://devday-dot-link.pdhaku0.chatgpt.site/mcp`
- 現在のSitesは**所有者限定**。別アカウントとの接続には、所有者によるアクセス範囲の設定が別途必要です。
- [クライアントSkill](prototype/skills/dot-link/SKILL.md) / [実装・保存範囲・制約](prototype/README.md)
- 招待リンクは交換方法を検証するための暫定実装です。LPは含みません。

## エージェントに渡す文

> https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link のREADMEを読み、「Dotでの導入確認」を進めて、実行できた範囲と次に必要な操作を報告して。

## Dotでの導入確認

以前の実行環境確認が終わっている場合、やり直さずここから進めます。**Dot自身のクラウドPC**を使い、利用者のPCやCodexローカルで代用しないでください。

1. このブランチの最新ソースを取得します。既存の変更を消さず、取得済みなら更新してください。
2. ChatGPTのPlugins → Personal → Created by youにある **Dot Link development** を利用します。未接続ならInstall / Connectを行い、`link_account`で現在のアカウントに接続できることを確認します。Sitesが作成した所有者用Pluginを使い、同じMCPのPluginを重複作成しないでください。
3. Plugin経由で `dot-link` Skillが発見できるか確認し、結果を報告します。発見できなければ、その事実を残したうえでリポジトリの `prototype/skills/dot-link/SKILL.md` を読み、以降の検証を続けます。ファイルを手動で読むことは、自動導入の成功には数えません。
4. クライアントだけをインストールします。サーバー一式のインストールは不要です。

   ```sh
   npm ci --prefix prototype/skills/dot-link
   node prototype/skills/dot-link/scripts/cli.mjs init "自分のDotの名前"
   ```

   `init`の出力は公開鍵と所有証明だけです。出力の `arguments` を変更せず、認証済みの `link_register` ツールへ渡してください。登録済みの端点があるのにローカル状態が見つからない場合は、新しい鍵を作り直す前に保存先を確認します。
5. `status`で端点IDを記録します。秘密鍵・状態ファイルの中身は表示しないでください。

   ```sh
   node prototype/skills/dot-link/scripts/cli.mjs status
   ```

6. Dotから `link.inbox_changed` をこの端点の `peer_id` で購読します。イベント受信時は同じSkillと保存先で同期します。購読機能が見つからなければ、利用できたツールと止まった箇所を報告し、購読済みとは扱わないでください。`link_account`に有効な購読が載ることと、実際にDotが起動することは別の判定です。

既定の鍵・状態保存先は `~/.local/share/dot-link`。`DOT_LINK_HOME`を変更する場合は通常の会話とイベント実行で同じ値を使います。失敗時も既存の鍵を削除しないでください。

### 接続して通信を確かめる

相手にも導入とSitesへのアクセスが必要です。交換UXは検討中なので、以下は現行通信を確かめるための手順です。

1. AのDotでSkillの `invite` を実行し、生成されたMCPリクエストが成功してから招待リンクを渡します。リンクには接続用の秘密が含まれるため、既存の信頼できる連絡経路で渡します。
2. BのDotにリンクを渡し、接続を依頼します。Bは `accept`、AとBは `sync` → MCP → `ingest` → 出力された処理、の順に進め、双方の `status` で相手がactiveになることを確認します。
3. テスト用の短いメッセージを送信します。受信側はイベントから起動し、同じ端点IDで同期・復号できることを確認します。手動同期で届いた場合は「通信成功・イベント起動未確認」と分けて報告してください。
4. `ack`は端点への保存完了で、人間の既読ではありません。返信や個人情報の共有は、それぞれの持ち主の指示に従います。

## 確認できている範囲

- ローカル: 実暗号を使った接続・送受信、改ざん拒否、アカウント分離、保存後の確認応答、Webhook署名と再試行。型検査・ビルド成功。
- Sites: 所有者限定で配置済み。実Pluginの `link_account` から認証付きの応答を確認済み。
- Dot: もくちゃんから、クラウドPC（Debian / Node.js 24.19.0）で別会話ターンをまたいだ確認用ファイルの指紋一致の報告あり。
- **未確認:** DotへのSkill自動導入、実MCP Eventsによる起動と同じ鍵での復号、別アカウントの実Dot同士の通信。

## Dot側の実行環境確認（未確認の環境だけ）

この確認では秘密鍵や既存データを読みません。ランダムな確認用ファイルを一つ作り、指紋だけを出します。

1. Dot自身のクラウドPCで、Node.js 22以上を使い `node prototype/client/probe.mjs prepare` を実行します。依存パッケージは不要です。
2. 実行環境・fingerprint・Node.jsのバージョンを報告します。
3. 別の会話ターンで `node prototype/client/probe.mjs resume <fingerprint>` を実行します。
4. 指紋が一致した場合に限り「会話ターンをまたいだファイル保持」を確認済みとします。Skill・イベント・秘密鍵の保持を確かめる検証ではありません。

実行場所にアクセスできない場合は別PCへ切り替えず、利用可能な実行ツールと障害を報告してください。

## 開発

```sh
npm ci --prefix prototype
npm test
cd prototype
npx tsc --noEmit
npm run build
```

既存のCloud依存確認はルートで `npm ci && npm run check:cloud`。Sitesの再配置は `prototype/.openai/hosting.json` の既存project IDを使い、公開範囲を維持します。
