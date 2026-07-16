![Shepherd cover](./assets/shepherd-cover.png)

# Shepherd

<!-- README-I18N:START -->
[English](./README.md) | **日本語**
<!-- README-I18N:END -->

Shepherd は、Herdr で動いている他の agent の状態と短い履歴を CLI から読めるようにするツールです。

Herdr の `herdr agent read` でも別 agent の出力を読むことはできます。ただしこれは terminal stream や scrollback を読む方式なので、agent の履歴を構造的に取得しづらく、余分な出力も含まれます。Shepherd は agent のセッションデータを読み取り、別 agent の作業状況、最新メッセージの抜粋、unread agent update を扱いやすい形にして提供します。

現在は Claude Code、Codex、Gemini CLI、OpenCode、Pi のセッション履歴の取得に対応しています。

## 要件

- Node.js >= 24.18.0
- Herdr >= 0.7.0
- `shepherd-pi` を使う場合は Pi >= 0.80.6

## インストール

```bash
npm install --global @ryonakae/shepherd
shepherd help
```

### ソースからインストールする

ソースからbuildする場合はpnpm >= 11.9.0も必要です。

```bash
git clone https://github.com/ryonakae/shepherd.git
cd shepherd
pnpm install
pnpm build
npm install --global . --ignore-scripts
shepherd help
```

## daemon を起動する

Shepherd の agent command は daemon を必要とします。daemon は `herdr session list --json` に出る実行中の Herdr session を監視し、60 秒ごとに再スキャンします。停止した Herdr session は index しません。runtime file は標準で `~/.shepherd` に置きます。別の directory を使う場合は `SHEPHERD_HOME` を設定します。

```bash
shepherd daemon start
```

## 主なコマンド

- `shepherd agent list`: 選択した workspace の最新キャッシュから status と最後の user / assistant message の抜粋を返します。鮮度が必要なときは各行の `updatedAt` を確認します。
- `shepherd agent get <target>`: 明示的に詳細を取得し、1 agent の metadata、compact history、最新の compact tool result を返します。
- `shepherd agent read <target> --limit N`: 明示的に履歴を読み、直近 N 件の user / assistant / compact `tool_result` message を返します。

Herdr workspace 内では、Shepherd が current workspace を自動で選びます。

```bash
shepherd agent list --json
shepherd agent get claude --json
shepherd agent read claude --limit 20 --json
```

Herdr の外から読む場合は scope を指定します。

```bash
shepherd agent list --all --json
shepherd agent list --workspace wB --json
shepherd agent get claude --workspace wB --json
shepherd agent read wB:p2 --workspace wB --limit 20 --json
```

`<target>` には、Herdr の慣例に合わせて pane id、terminal id、または scope 内で一意な agent name を指定できます。同じ workspace id や agent name が複数の running Herdr session にある場合は `--session <name>` を付けます。

## Agent Skill

Agent Skill を追加する前に、Shepherd CLI をインストールして daemon を起動します。次のコマンドで、対応する coding agent に Shepherd の手順を追加します。

```bash
npx skills add ryonakae/shepherd --skill shepherd -g
```

Shepherd skill は agent の status、compact history、直近の tool result を構造化データとして読み取ります。agent の確認だけなら、Shepherd skill を単独で使えます。

workspace、tab、pane、terminal input/output、wait も agent から操作する場合は、公式 Herdr skill を追加します。

```bash
npx skills add ogulcancelik/herdr --skill herdr -g
```

## Pi extension

Piからextensionをインストールします。

```bash
pi install npm:@ryonakae/shepherd-pi
```

extensionにはPi 0.80.6以降が必要です。PiがHerdr内で動くとShepherd daemonに接続します。接続中のPiはoffの状態でも正確なPi session pathをpresence identityとして登録します。extensionはturnごとのtool resultや最終messageのtelemetryを送信しません。

Piで`/shepherd on`を入力すると、そのterminalが現在のHerdr sessionとworkspaceにおける唯一のShepherd ownerになります。cached current-workspace agent context、pending件数、agent update、自動wakeを受け取るのはownerだけです。contextからowner自身のPi terminalを除き、ほかのPi terminalを含めます。通常のpromptではdaemon RPCや履歴読み込みを待たず、local cacheのsnapshotを挿入します。起動直後、reconnect直後、scope移動直後はsnapshotが届くまでcontextが一時的にない場合があります。

agentが完了またはblockedになると、visibleなShepherd turnを1回開始します。通常のuser runが実行中なら、Shepherdはsettleを待ちます。themed cardは最大3件を表示し、Piのexpand keyで全outcomeと長さを制限した最終responseを確認できます。agentの出力は信頼できない参考情報として扱い、Piは既存のuser requestに必要な作業だけを続けます。

現在のPiの状態は`/shepherd`または`/shepherd status`で確認し、`/shepherd off`でそのPiのowner動作を解除します。offにしても別のownerへは影響しません。offまたはnon-ownerのPiは後でclaimできるよう接続を保ちますが、hidden agent context、pending件数、update、wakeは受け取りません。onのPiだけがfooterに`◆ Shepherd`を表示し、未処理のoutcomeがある間は`· N agent updates`が付きます。updateを含むturnが最終assistant responseを生成してsettleし、元のeventをacknowledgeすると件数が消えます。直前までonだったPiが接続を失うと、復旧中は`◇ Shepherd · reconnecting`を表示します。ownerがいない間はoutcomeを配信せず、その間に発生したoutcomeは後からclaimしてもreplayしません。reload、reconnect、別Piによる直接のowner交代では、未acknowledgedのoutcomeを保持します。ownershipはPi sessionの切り替えやpaneの移動後も同じHerdr terminalに追従し、そのterminalがgrace periodを超えて切断された場合は解除されます。

## Herdr plugin

任意のpluginはGitHub Releaseのtagからインストールします。

```bash
herdr plugin install ryonakae/shepherd/packages/shepherd-herdr-plugin --ref v0.4.0 --yes
```

pluginはShepherd daemonに接続し、current Herdr workspaceのcompact agent rowをHerdr UIに表示します。Herdrはrepository subdirectoryからpluginをインストールします。npmには公開せず、CLIとPi extensionだけを使う場合は不要です。

## パッケージ

| Path | 配布方法 | Purpose |
| --- | --- | --- |
| repository root | npm: `@ryonakae/shepherd` | Shepherd CLIとdaemon。 |
| `packages/shepherd-pi` | npm: `@ryonakae/shepherd-pi` | agent historyとagent updateのPi extension。 |
| `packages/shepherd-herdr-plugin` | GitHub Releaseのsubdirectory | 任意のHerdr UI integration。npm packageではありません。 |

## 開発

```bash
pnpm install
pnpm check
pnpm build
```

package検証、npm公開、GitHub Releaseの手順は[Releasing Shepherd](./docs/releasing.md)に記載しています。

DB schema を変えたら次も実行します。

```bash
pnpm db:generate
pnpm db:check
```

## ライセンス

[MIT](./LICENSE)
