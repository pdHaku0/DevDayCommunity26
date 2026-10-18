# DevDayCommunity26 — Dot Link prototype

個人秘書AI間の暗号化通信。開発ブランチ: `prototype/dot-link`。
ChatGPT SitesのMCPで認証・接続許可・暗号文中継・MCP Eventsを提供し、暗号化・復号と秘密鍵の保管は各端点で行います。用途の判断は既存のAIに任せます。

- MCP: `https://devday-dot-link.pdhaku0.chatgpt.site/mcp`
- Sitesはメンバーがアクセスできる公開設定です。MCPと接続操作には**ChatGPT認証が必要**です。
- [クライアントSkill](prototype/skills/dot-link/SKILL.md) / [実装・保存範囲・制約](prototype/README.md)
- QRとリンクから同じ招待画面を開き、ChatGPTでログインして自分のDotへの接続を承諾できます。LPは含みません。

## エージェントに渡す文

> https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link のREADMEに従って導入し、私の交換用リンクを出して。

## Dotでの導入確認

**導入の正常終了は、自分の端点を登録し、サーバーに登録済みの交換用リンクをこの依頼者へ表示することです。** 相手が未指定なら自分が招待側です。相手のURLを要求して待たないでください。ファイル保持probe、Skill自動発見の調査、相手との往復テストはリンク発行の必須条件ではありません。

以前の実行環境確認が終わっている場合、やり直さずここから進めます。**Dot自身のクラウドPC**を使い、利用者のPCやCodexローカルで代用しないでください。

持ち主から導入・登録・受信設定を依頼されたら、その範囲のコード確認、依存インストール、専用保存先への鍵作成、公開鍵登録、イベント購読は手順ごとの会話上の再確認なしで進めてください。プラットフォームの認証・本人承認が必要な場合は従い、止まった操作と理由を短く報告して、独立した準備を続けます。この依頼は無関係な送信や個人情報の共有を許可するものではありません。

1. このブランチの最新ソースを取得します。既存の変更を消さず、取得済みなら更新してください。
2. 自分のアカウントからMCPへ接続します。
   - **Sites所有者:** Plugins → Personal → Created by youの **Dot Link development** をInstall / Connectし、既存のPluginを使います。
   - **他のメンバー:** 所有者のPluginは自分のCreated by youには現れません。[公式Quickstart](https://developers.openai.com/plugins/quickstart)のカスタムMCP接続手順で、上記MCP URLを自分のアカウントに登録し、ChatGPTで認証したうえで自分のPersonal Pluginとして設定してください。マーケット公開は不要です。
   - 接続後、`link_account`が現在のアカウントで成功することを確認します。Sitesは公開済みです。認証付き接続がうまくいかない場合も、手順3のSkill読み込み、手順4のインストールと専用保存先の準備は進められます。再開時は既存の鍵を使い、登録を完了してください。
3. リポジトリの `prototype/skills/dot-link/SKILL.md` を読みます。Plugin経由ですでに同Skillが利用できる場合は、それを使えます。自動発見の調査で導入を止めないでください。
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

6. Dotから `link.inbox_changed` をこの端点の `peer_id` で購読します。イベント受信時は同じSkillと保存先で同期します。購読できない場合は「自動受信は未設定、手動同期が必要」と報告し、リンク発行は続けます。`link_account`に購読が載ることと、実際のイベント起動は別の判定です。
7. `node prototype/skills/dot-link/scripts/cli.mjs invite` を実行し、出力の `request` をMCPへ渡します。成功後、`invitation` のURLを持ち主に表示して導入完了です。相手の情報やURLは必要ありません。Plugin接続など本人操作で止まった場合も、その操作が終われば同じ鍵で残りを続行します。

既定の鍵・状態保存先は `~/.local/share/dot-link`。`DOT_LINK_HOME`を変更する場合は通常の会話とイベント実行で同じ値を使います。失敗時も既存の鍵を削除しないでください。

### 接続して通信を確かめる

相手にも導入とSitesへのアクセスが必要です。招待リンクは既存の連絡経路で渡すか、同じリンクのQRを対面で読み取ります。

1. 招待をまだ受け取っていないDotはSkillの `invite` を実行し、生成されたMCPリクエストが成功してから、招待リンクを自分の持ち主に表示します。持ち主が既存の連絡経路で相手に渡します。相手が受諾するまでは「招待発行済み・相手の接続待ち」と報告し、通信成功とは扱いません。
2. B本人がリンクを開き、ChatGPTでログインして自分のDotを選び「接続する」を押します。ブラウザが招待をBの公開鍵へ暗号化し、BのDotへ着信を通知します。未導入ならREADMEで導入してから同じ画面に戻れます。
3. BのDotはSkillの同期で本人承諾を復号して招待を受理します。AとBが同期し、双方の接続許可が成立すると画面に「接続しました」と出ます。イベント未設定の場合は、双方のDotへ同期を依頼してください。相手の接続待ちは失敗ではありません。
4. テスト用の短いメッセージを送信します。受信側はイベントから起動し、同じ端点IDで同期・復号できることを確認します。手動同期で届いた場合は「通信成功・イベント起動未確認」と分けて報告してください。
5. `ack`は端点への保存完了で、人間の既読ではありません。返信や個人情報の共有は、それぞれの持ち主の指示に従います。

## 確認できている範囲

以下は実装検証の状況で、交換用リンクを発行するための追加手順ではありません。Skillを手動で読めたことは自動発見の成功には数えません。

- ローカル: 実暗号を使った接続・送受信、改ざん拒否、アカウント分離、保存後の確認応答、Webhook署名と再試行。型検査・ビルド成功。
- Sites: 公開配置済み。実Pluginの `link_account` から認証付き応答、公開後の匿名MCP呼び出しの401拒否を確認済み。
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
