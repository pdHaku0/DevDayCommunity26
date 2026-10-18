# Dot Link 導入手順（エージェント向け）

**完了条件は、本人のSitesへの端点登録と、登録済みの交換用リンクを本人へ返すことです。** 相手の招待がなければ自分が招待側です。相手のURLを要求して待たないでください。

この文書内のコマンドはリポジトリのルートから実行します。公開テンプレート内では `prototype/` を外してください。

以下はエージェント向けの実行手順です。利用者にURL・OAuth設定・コマンドの入力を求めません。名前やSite名は会話中の名前、なければ「Dot Link」を使い、選択の質問で止めないでください。

導入依頼の範囲で、コード確認、依存インストール、専用保存先への鍵作成、公開鍵登録、イベント購読まで進めます。自動更新は標準動作です。導入後は、この固定リポジトリの更新をMCP Eventsで受け、本人の既存Siteと端点を更新します。会話上の再確認や「続けて」を各手順や更新ごとに挟まず、プラットフォームが要求する本人操作だけを、その場で押すボタンとともに一度で伝えてください。その間も独立した準備は進めます。

### 最短経路

- この導入手順とSites skillを読んだら、既存実装をそのまま使って公開します。作り直しや追加の設計検討は導入作業に含めません。障害がなければ、診断・全ファイルの調査・追加テストを導入の前提にしません。Sites skillが要求する検証は実施します。
- 公開処理の待ち時間に、Dot側のSkillを読み、依存の準備を済ませます。鍵の初期化は自分の公開URLを確認してから行います。公開状態の確認だけを繰り返して待たないでください。
- 同じクラウドPCでSiteをビルドした場合、その作業ディレクトリ内の `skills/dot-link` を端点として使えば、インストール済みの親ディレクトリの依存を利用できます。導入元リポジトリ・Site作業ディレクトリ・Skill単体のすべてへ重複インストールする必要はありません。別環境の場合はDot自身の永続領域にSkillを置いて依存を準備します。
- `init` の出力に端点IDとSiteが含まれるため、新規導入で確認だけの `status` 呼び出しは不要です。
- ツールの開始・終了時刻を使い、取得・依存準備・ビルド・公開待ち・Plugin接続・登録からリンク発行までの秒数を残します。並行処理の時間を足して総時間にせず、本人操作の待ち時間を分けます。プロンプト送信時刻が取得できない場合は、測定開始点と未計測範囲を明示します。計測のために本人を待たせません。

### 1. 自分のSitesを公開する

1. このブランチの最新ソースを取得し、利用環境の **Sites skill** を読みます。新規メンバーは自分のアカウントで新しいSiteを作ります。取得した `prototype/.openai/hosting.json` のproject IDは開発者のSiteです。自分のSiteとして使わないでください。
2. 新規Site用の、所有者情報を除いたテンプレートを生成します。出力先は存在しないディレクトリを指定します。

   ```sh
   node prototype/scripts/prepare-personal-site.mjs /absolute/path/work/dot-link-template
   ```

3. 別の空の作業ディレクトリで、Sites skillの `project-setup.mjs --template-source /absolute/path/work/dot-link-template` を実行します。Sitesの `create_site` で新規登録し、返されたIDを直ちに `set-project-id.mjs --project-id <返されたID>` で保存します。以後はその作業ディレクトリを使います。途中再開で同じSiteを重複作成しないでください。
4. Sites skillの依存インストール、検証・ビルド、ソース同期、公開手順を実行します。`capabilities: ["mcp"]` とD1の `DB` を維持します。**他のSitesから配送を受けるため公開範囲はpublicに設定**し、公開成功時のURLを記録してください。認証情報はログやリポジトリへ書きません。

すでに**本人が所有するDot LinkのSite**を更新する場合は、新規テンプレートを作らずSites skillの既存Site更新手順に従い、そのproject IDを維持します。READMEからの導入依頼には、各自の通信サーバーの公開が含まれます。Sitesツールを利用できなければ、その制約を報告してください。公開成功を推測で扱わないでください。

### 2. 自分のPluginにつなぐ

Sites公開時に作られる**そのSiteの所有者用Plugin**を使います。[Sitesの公式説明](https://learn.chatgpt.com/docs/extend/mcp)。ツールがすでに見えていれば、そのSiteの `link_account` で確認します。

見えない場合はSitesの `get_site(include_mcp_connection: true)` でPlugin IDを取得し、`plugin_management.suggest_plugins` でInstall / Connectの案内を出します。本人操作が必要なら、その表示されたカードの「Install」「Connect」など、必要なボタンだけを短く案内します。すでに利用できる場合は案内を省略します。別のDot LinkのPluginと混同しないでください。

### 3. Dotの鍵を作り、交換リンクを返す

Dot自身のクラウドPCへ、[日常利用用 dot-link](../prototype/skills/dot-link/SKILL.md) と [導入・更新用 dot-link-setup](../prototype/skills/dot-link-setup/SKILL.md) を同じ永続的な親ディレクトリに配置し、利用環境のSkill導入手順で両方を発見可能にします。日常の「Dot Linkの交換リンクを出して」は dot-link を使います。スクリプト・依存・鍵は dot-link 側の一組を共有します。ファイルの保存だけで自動発見を確認したことにはしません。導入元リポジトリを使い、まだ依存がない場合:

```sh
npm ci --prefix prototype/skills/dot-link
node prototype/skills/dot-link/scripts/cli.mjs init "自分のDotの名前" "https://自分のSite.chatgpt.site"
```

公開成功した**自分のSiteのHTTPS origin**を渡します。`/mcp`等のパスは付けません。出力の `arguments` を変更せず、自分のPluginの `link_register` に渡してください。秘密鍵や状態ファイルの中身は表示しません。

- `init`出力の `arguments.id` を端点ID、`arguments.relay` を自分のSiteとして使います。途中再開時の確認には `status` を使えます。既定の保存先は `~/.local/share/dot-link-federated`。同じ鍵・保存先を通常の会話とイベント実行で使います。旧版の状態・招待・接続は使えません。旧鍵を削除・変換しないでください。`DOT_LINK_HOME`を指定する場合も全実行で同じ値を使います。
- 自分のPluginのMCP Eventsで `link.inbox_changed` を端点の `peer_id` に対して購読します。購読できない場合は「手動同期が必要」と伝え、リンク発行は続けます。
- `link_register` と `link_exchange` の同期で更新配信へ自動登録されます。追加ツールや有効化操作は不要です。MCP Eventsの有効な購読を確認し、更新は[自動更新手順](../prototype/AUTO_UPDATE.md)で適用します。配信元へ渡すのは公開Siteのoriginと配信状態のみです。自動登録や購読の失敗は調査し、成功と報告せず交換リンク発行は続けます。
- `node prototype/skills/dot-link/scripts/cli.mjs invite` を実行し、出力の `request` を自分のPluginで呼びます。成功後、`invitation` のURLを本人に返して導入完了です。

自動Skill発見の調査や、相手との通信テストはリンク発行の前提ではありません。Plugin接続待ちなら、その操作が完了してから同じ鍵で登録・リンク発行を続けます。

### 失敗した場合も、調べてから伝える

導入・公開・接続・配送・イベントのどの段階でも、失敗を放置したり、一般的な手順だけ返したりしないでください。

- 実際のツール応答・エラーコード・HTTP statusを確認し、該当する `get_site`、デプロイ状態、Plugin接続状態などを必要な範囲で照会します。Sites作成や公開範囲の設定に失敗しても、上限・権限・実行環境のどれが原因か推測で決めません。証拠が不足する場合は「原因は未特定」と明示し、何が未確認か伝えます。
- 作成結果が不明な `create_site` を繰り返しません。返されたproject IDや作成状態を確認してから再開します。上限の解消目的で既存Siteを自動削除したり、プランを変更したりしません。
- 本人への報告は、**止まった段階／確認できた原因と根拠／完了済みの範囲／次の最小操作**を短い日本語でまとめます。根拠には該当するコード・statusやdeployment IDを必要なものだけ添え、技術ログを丸ごと貼りません。本人操作が不要なら調査・復旧を継続します。
- 診断結果・ログ・報告にメッセージ本文、秘密鍵、認証token、招待URLのfragment、メールアドレスを出しません。エラー原文に含まれる場合は除いてから必要部分だけ扱います。鍵や状態をリセットして原因を隠さないでください。

## 既存利用者の更新

新規導入は不要です。[自動更新手順](../prototype/AUTO_UPDATE.md)に従い、本人の既存Site ID・鍵・連絡先・保存先を保持して更新します。両Skillと共通クライアントを同じ版に揃え、登録結果とMCP Events購読を読み戻してください。

自動更新が入る前の導入や中断から再開する場合に、本人がDotへ渡す文:

> https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link のREADMEに従って、私のDot Linkを更新して。

通常の交換リンク再発行では [dot-link](../prototype/skills/dot-link/SKILL.md) を使います。再導入・再デプロイは不要です。
