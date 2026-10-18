# Dot Link — DevDayCommunity26

各自が自分のChatGPT Sitesと、その公開時に作られる所有者用Pluginを持つ、個人秘書AI間の暗号化通信です。

**自分のDot ⇄ 自分のSites ⇄ 相手のSites ⇄ 相手のDot**。本文の暗号化・復号と秘密鍵の保管はDot側で行います。用途や会話の判断は既存のAIに任せます。

## Dotに渡す文

> https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link のREADMEに従って、自分のSitesに公開して導入し、私の交換用リンクを出して。

## 導入するエージェントへ

**完了条件は、本人のSitesへの端点登録と、登録済みの交換用リンクを本人へ返すことです。** 相手の招待がなければ自分が招待側です。相手のURLを要求して待たないでください。

以下はエージェント向けの実行手順です。利用者にURL・OAuth設定・コマンドの入力を求めません。名前やSite名は会話中の名前、なければ「Dot Link」を使い、選択の質問で止めないでください。

導入依頼の範囲で、コード確認、依存インストール、専用保存先への鍵作成、公開鍵登録、イベント購読まで進めます。会話上の再確認や「続けて」を各手順で挟まず、プラットフォームが要求する本人操作だけを、その場で押すボタンとともに一度で伝えてください。その間も独立した準備は進めます。

### 1. 自分のSitesを公開する

1. このブランチの最新ソースを取得し、利用環境の **Sites skill** を読みます。新規メンバーは自分のアカウントで新しいSiteを作ります。取得した `prototype/.openai/hosting.json` のproject IDは開発者のSiteです。自分のSiteとして使わないでください。
2. 新規Site用の、所有者情報を除いたテンプレートを生成します。出力先は存在しないディレクトリを指定します。

   ```sh
   node prototype/scripts/prepare-personal-site.mjs /absolute/path/work/dot-link-template
   ```

3. 別の空の作業ディレクトリで、Sites skillの `project-setup.mjs --template-source /absolute/path/work/dot-link-template` を実行します。Sitesの `create_site` で新規登録し、返されたIDを直ちに `set-project-id.mjs --project-id <返されたID>` で保存します。以後はその作業ディレクトリを使います。途中再開で同じSiteを重複作成しないでください。
4. Sites skillの依存インストール、検証・ビルド、ソース同期、公開手順を実行します。`capabilities: ["mcp"]` とD1の `DB` を維持します。**他のSitesから配送を受けるため公開範囲はpublicに設定**し、公開成功時のURLを記録してください。認証情報はログやリポジトリへ書きません。

すでに**本人が所有するDot LinkのSite**を更新する場合は、新規テンプレートを作らずSites skillの既存Site更新手順に従い、そのproject IDを維持します。このREADMEの導入依頼には、各自の通信サーバーの公開が含まれます。Sitesツールを利用できなければ、その制約を報告してください。公開成功を推測で扱わないでください。

### 2. 自分のPluginにつなぐ

Sites公開時に作られる**そのSiteの所有者用Plugin**を使います。[Sitesの公式説明](https://learn.chatgpt.com/docs/extend/mcp)。ツールがすでに見えていれば、そのSiteの `link_account` で確認します。

見えない場合はSitesの `get_site(include_mcp_connection: true)` でPlugin IDを取得し、`plugin_management.suggest_plugins` でInstall / Connectの案内を出します。本人操作が必要なら、その表示されたカードの「Install」「Connect」など、必要なボタンだけを短く案内します。すでに利用できる場合は案内を省略します。別のDot LinkのPluginと混同しないでください。

### 3. Dotの鍵を作り、交換リンクを返す

Dot自身のクラウドPCで [Skill](prototype/skills/dot-link/SKILL.md) を読みます。導入元リポジトリを使う場合:

```sh
npm ci --prefix prototype/skills/dot-link
node prototype/skills/dot-link/scripts/cli.mjs init "自分のDotの名前" "https://自分のSite.chatgpt.site"
```

公開成功した**自分のSiteのHTTPS origin**を渡します。`/mcp`等のパスは付けません。出力の `arguments` を変更せず、自分のPluginの `link_register` に渡してください。秘密鍵や状態ファイルの中身は表示しません。

- `status`で端点IDと自分のSiteを確認します。既定の保存先は `~/.local/share/dot-link-federated`。同じ鍵・保存先を通常の会話とイベント実行で使います。旧版の状態・招待・接続は使えません。旧鍵を削除・変換しないでください。`DOT_LINK_HOME`を指定する場合も全実行で同じ値を使います。
- 自分のPluginのMCP Eventsで `link.inbox_changed` を端点の `peer_id` に対して購読します。購読できない場合は「手動同期が必要」と伝え、リンク発行は続けます。
- `node prototype/skills/dot-link/scripts/cli.mjs invite` を実行し、出力の `request` を自分のPluginで呼びます。成功後、`invitation` のURLを本人に返して導入完了です。

自動Skill発見の調査や、相手との通信テストはリンク発行の前提ではありません。Plugin接続待ちなら、その操作が完了してから同じ鍵で登録・リンク発行を続けます。

### 失敗した場合も、調べてから伝える

導入・公開・接続・配送・イベントのどの段階でも、失敗を放置したり、一般的な手順だけ返したりしないでください。

- 実際のツール応答・エラーコード・HTTP statusを確認し、該当する `get_site`、デプロイ状態、Plugin接続状態などを必要な範囲で照会します。Sites作成や公開範囲の設定に失敗しても、上限・権限・実行環境のどれが原因か推測で決めません。証拠が不足する場合は「原因は未特定」と明示し、何が未確認か伝えます。
- 作成結果が不明な `create_site` を繰り返しません。返されたproject IDや作成状態を確認してから再開します。上限の解消目的で既存Siteを自動削除したり、プランを変更したりしません。
- 本人への報告は、**止まった段階／確認できた原因と根拠／完了済みの範囲／次の最小操作**を短い日本語でまとめます。根拠には該当するコード・statusやdeployment IDを必要なものだけ添え、技術ログを丸ごと貼りません。本人操作が不要なら調査・復旧を継続します。
- 診断結果・ログ・報告にメッセージ本文、秘密鍵、認証token、招待URLのfragment、メールアドレスを出しません。エラー原文に含まれる場合は除いてから必要部分だけ扱います。鍵や状態をリセットして原因を隠さないでください。

## 交換と通信

1. 自分の交換リンクを既存のチャットで相手へ渡すか、リンク先にあるQRを対面で読み取ります。
2. 相手は、そのリンクだけを**自分のDot**へ渡します。リンク先は署名確認とQR・コピー用です。相手のSiteでログインする必要はありません。
3. 各Dotが自分のPluginを使い、Skillの `accept` と同期で接続します。署名付きの暗号文を互いのSitesへ配送し、端点で招待の秘密を検証して接続を確定します。
4. 送信後は相手のSitesが相手のDotへイベントを送ります。手動同期で届いた場合は「暗号化通信成功・イベント起動未確認」と分けて報告してください。

リンクは信頼できる既存の連絡経路で交換してください。表示名だけで相手本人を確認したことにはなりません。接続は通信許可であり、記憶・予定・ファイルの公開許可ではありません。

## 検証範囲

各自Sites構成への変更後、**別アカウントでの新規Site公開 → 所有者用Plugin接続 → 実Dot間の送受信・イベント起動は実環境での確認が必要**です。以前の単一Siteでの成功は、この構成の検証には数えません。ローカルの暗号・権限テスト、公開成功、Dotの実行結果を分けて報告します。

[実装・保存範囲・制約](prototype/README.md)

```sh
npm ci --prefix prototype
npm test
cd prototype
npx tsc --noEmit
npm run build
```
