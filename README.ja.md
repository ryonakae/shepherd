# Shepherd

Shepherd は、Herdr 管理の coding agent を共有 TUI とメッセージイベントストリームから操作します。

<!-- README-I18N:START -->

[English](./README.md) | **日本語**

<!-- README-I18N:END -->

## 機能

- **Herdr を起点にした orchestration:** Shepherd は session state を保存し、Herdr の session、workspace、tab、pane、agent を制御します。
- **共有 session stream:** TUI と Slack client は、platform adapter 経由で同じ Shepherd session event log を読み書きします。
- **型付きの土台:** MVP は TypeScript、Vitest、Biome、SQLite migration、Drizzle schema generation、TypeBox/Ajv schema を使います。

## 目次

- [はじめに](#はじめに)
- [要件](#要件)
- [設定](#設定)
- [使い方](#使い方)
- [よく使うコマンド](#よく使うコマンド)
- [プロジェクト構成](#プロジェクト構成)

## はじめに

```bash
mise trust
mise install
pnpm install
pnpm check
pnpm build
```

## 要件

- Node.js 24.18.0 以上
- pnpm 11.9.0 以上
- ローカルの tool version を管理する `mise`

## 設定

リポジトリ外にローカル設定ファイルを作ります。例: `/tmp/shepherd.local.yaml`。Slack token の項目には環境変数名を書きます。token 値を YAML に貼り付けないでください。

```yaml
gateway:
  pi:
    idle_timeout_ms: 600000
    readiness_timeout_ms: 10000

default_agent: implementer
agents:
  implementer:
    command: codex
    args: []
    when: "Use for implementation, test fixes, and CLI-heavy coding work."

context:
  allowed_roots:
    - /Users/ryo.nakae/Dev/private/shepherd

platforms:
  slack:
    app_token_env: SLACK_APP_TOKEN
    bot_token_env: SLACK_BOT_TOKEN
    allow_customize: false
    allowed_teams:
      - T0123456789
    allowed_channels:
      - C0123456789
    allowed_users:
      - U0123456789
    tui_default_channel: C0123456789
    streaming:
      enabled: true
      edit_interval_ms: 750
      buffer_threshold_chars: 40
      cursor: " ▉"
      tool_progress: off
```

Slack を使う設定では、Shepherd は `allowed_users` を必須にします。Gateway は `allowed_teams`、`allowed_channels`、`allowed_users` から外れた message を無視し、拒否した軸と Slack ID を debug level で記録します。`tui_default_channel` を設定する場合は、同じ channel ID を `allowed_channels` に含めてください。

Pi-backed gateway run では、`providers`、`gateway.default_provider`、`gateway.model` を省きます。これらの field を追加すると、Pi runtime ではなく legacy provider runner を使います。

### Slack アプリの設定

workspace 用の Slack app を作成または更新し、workspace にインストールします。

1. Socket Mode を有効にします。
2. `connections:write` 付きの app-level token を作成します。Slack の app-level token は `xapp-` で始まります。
3. Shepherd が使う scope を bot token に追加します:
   - `chat:write`
   - public channel 用の `channels:history`
   - private channel 用の `groups:history`
   - direct message 用の `im:history`
   - group direct message 用の `mpim:history`
   - `allow_customize: true` を使う場合だけ `chat:write.customize`
4. 使う Slack surface に合わせて bot event を購読します:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
5. `allowed_channels` に書いた各 channel に bot を invite します。
6. YAML には display name ではなく Slack ID を書きます。team ID は `T0123456789`、channel ID は `C0123456789`、user ID は `U0123456789` の形です。

Gateway を起動する shell で token を入力します。この方法なら token 値が shell history に残りません。

```bash
read -rsp 'SLACK_APP_TOKEN: ' SLACK_APP_TOKEN
export SLACK_APP_TOKEN
echo
read -rsp 'SLACK_BOT_TOKEN: ' SLACK_BOT_TOKEN
export SLACK_BOT_TOKEN
echo
```

### Pi パッケージの設定

Pi runtime を有効にして Gateway を起動する前に、ローカルの Shepherd Pi package をインストールします:

```bash
pi install ./packages/shepherd-pi
pi list
```

Pi に利用できる model がない場合は、Pi を一度開いて `/login` を実行します。`shepherd gateway start` は `pi --mode rpc --no-session` を起動し、`shepherd-pi` extension の handshake を待ち、Pi に authenticated model が 1 つ以上あることを確認します。

## 使い方

test suite を実行します:

```bash
pnpm test
```

コミット済み SQLite migration をローカル database に適用します:

```bash
SHEPHERD_DB_PATH=/tmp/shepherd.sqlite pnpm db:migrate
```

TypeScript を `dist` に build します:

```bash
pnpm build
```

ローカル設定で Gateway を起動します:

```bash
export SHEPHERD_DB_PATH=/tmp/shepherd.sqlite
export SHEPHERD_GATEWAY_SOCKET_PATH=/tmp/shepherd.sock

node dist/src/cli/shepherd.js gateway start \
  --db "$SHEPHERD_DB_PATH" \
  --socket "$SHEPHERD_GATEWAY_SOCKET_PATH" \
  --config /tmp/shepherd.local.yaml
```

現在の directory から新しい local Shepherd session を作成し、Pi を開きます:

```bash
node dist/src/cli/shepherd.js
```

Gateway は事前に起動しておく必要があります。`shepherd` は Gateway を自動起動しません。現在の working directory が、実行したままの path で Shepherd working context になります。

既存の Shepherd session を開きます。例: Slack から作成された session:

```bash
node dist/src/cli/shepherd.js open \
  --session "$SHEPHERD_SESSION_ID" \
  --db "$SHEPHERD_DB_PATH" \
  --socket "$SHEPHERD_GATEWAY_SOCKET_PATH"
```

running Gateway session に message を送ります:

```bash
node dist/src/cli/shepherd.js send \
  --session "$SHEPHERD_SESSION_ID" \
  --socket "$SHEPHERD_GATEWAY_SOCKET_PATH" \
  --text "continue from here"
```

legacy provider を設定している場合は、one-turn gateway provider override 付きで message を送れます:

```bash
node dist/src/cli/shepherd.js send \
  --session "$SHEPHERD_SESSION_ID" \
  --socket "$SHEPHERD_GATEWAY_SOCKET_PATH" \
  --text "try this with OpenAI" \
  --provider openai \
  --model gpt-4.1
```

session event を JSON Lines で監視します:

```bash
node dist/src/cli/shepherd.js watch \
  --session "$SHEPHERD_SESSION_ID" \
  --socket "$SHEPHERD_GATEWAY_SOCKET_PATH" \
  --after 0
```

logical tool を stdio JSON Lines で bridge します:

```bash
node dist/src/cli/shepherd-tools.js --socket /tmp/shepherd.sock
```

session 名を変更します:

```bash
node dist/src/cli/shepherd.js rename \
  --session "$SHEPHERD_SESSION_ID" \
  --socket "$SHEPHERD_GATEWAY_SOCKET_PATH" \
  --title "Review Slack sync"
```

SQLite audit log から stored session audit event を出力します:

```bash
node dist/src/cli/shepherd.js audit \
  --session "$SHEPHERD_SESSION_ID" \
  --db /tmp/shepherd.sqlite \
  --after 0
```

## よく使うコマンド

- `pnpm typecheck`: emit せずに strict TypeScript check を実行します。
- `pnpm test`: Vitest unit test と integration test を実行します。
- `pnpm lint`: Biome lint と import organization check を実行します。
- `pnpm format:check`: Biome formatting を確認します。
- `pnpm db:generate`: `src/db/schema.ts` から Drizzle SQL migration を生成します。
- `pnpm db:check`: 生成済み Drizzle migration と schema の整合性を確認します。
- `pnpm check`: local quality gate をまとめて実行します。

## プロジェクト構成

- `src/config`: TypeBox/Ajv runtime configuration contract。
- `src/cli`: `shepherd` と `shepherd-tools` の command-line entrypoint。
- `src/gateway`: local Gateway server、JSON Lines framing、recovery、provider adapter、logical tool、turn queueing、context、summary update。
- `src/db`: SQLite connection、migration application、Drizzle schema。
- `src/delivery`: platform delivery routing、fanout、receipt、duplicate-send prevention。
- `src/gateway/working-contexts.ts`: allowed-root working context discovery and resolution。
- `src/platforms/slack`: Slack inbound normalization、Socket Mode wrapper、outbound delivery。
- `src/tui`: TUI-style local surface が使う Gateway socket client。
- `test/unit`: pure logic と contract test。
- `test/integration`: SQLite と cross-module integration test。
- `docs/plans`: active product plan と implementation plan。完了済み plan は `docs/plans/archived` にあります。

## メモ

`src` 配下の TypeScript source は `@/*` import を使えます。build は `tsc-alias` を使い、emitted JavaScript が `dist` から実行できるようにします。

`pnpm-workspace.yaml` は pnpm 11 の build-script approval のためだけにあります。MVP の Shepherd は single-package project です。

## ライセンス

[MIT](LICENSE)
