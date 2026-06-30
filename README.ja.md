# Shepherd

Shepherd は、Pi が調整役になり、Herdr 管理の coding agent を共有 TUI とメッセージイベントストリームから操作する gateway です。

<!-- README-I18N:START -->

[English](./README.md) | **日本語**

<!-- README-I18N:END -->

## 機能

- **役割を分けた runtime:** Pi は model/provider/session conversation state、Herdr は terminal execution surface、Shepherd Gateway は session、delivery、Pi turn queue、policy、binding、audit event を担当します。
- **共有 session stream:** TUI と Slack client は、platform adapter 経由で同じ Shepherd session event log を読み書きします。
- **Herdr worker orchestration:** Shepherd は `shepherd_*` logical tool で Herdr workspace、pane、worker-agent binding を管理します。
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

Shepherd は `$SHEPHERD_HOME/config.yaml` を読みます。`SHEPHERD_HOME` が未設定の場合は、全 platform で `~/.shepherd` を使います。`$SHEPHERD_HOME/.env` も読み、そこに書いた値は `SHEPHERD_*` 以外の shell env を上書きします。

`runtime:` section は任意です。相対 path は `$SHEPHERD_HOME` から解決します。開発中は migration 変更で SQLite schema を破壊的に作り直します。古い local DB が起動を妨げる場合は、古い `$SHEPHERD_HOME/state.db` を削除してください。

```yaml
runtime:
  db_path: state.db
  socket_path: gateway.sock
  pid_path: gateway.pid
  log_path: logs/gateway.log

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

Shepherd は provider/model config を持ちません。provider auth と model selection は Pi 側で設定してください。

Slack を使う設定では、Shepherd は `allowed_users` を必須にします。Gateway は `allowed_teams`、`allowed_channels`、`allowed_users` から外れた message を無視し、拒否した軸と Slack ID を debug level で記録します。`tui_default_channel` を設定する場合は、同じ channel ID を `allowed_channels` に含めてください。

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

token は `$SHEPHERD_HOME/.env` に置きます。YAML や shell history に token 値を残さずに済みます。

```bash
mkdir -p "${SHEPHERD_HOME:-$HOME/.shepherd}"
cat > "${SHEPHERD_HOME:-$HOME/.shepherd}/.env" <<'EOF'
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
EOF
```

### Pi パッケージの設定

Gateway を起動する前に、ローカルの Shepherd Pi package をインストールします:

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

設定済み database に committed SQLite migration を適用します:

```bash
pnpm db:migrate
```

TypeScript を `dist` に build します:

```bash
pnpm build
```

Gateway を起動します:

```bash
node dist/src/cli/shepherd.js gateway start
```

現在の directory から新しい local Shepherd session を作成し、Pi を開きます:

```bash
node dist/src/cli/shepherd.js
```

Gateway は事前に起動しておく必要があります。`shepherd` は Gateway を自動起動しません。現在の working directory が、実行したままの path で Shepherd working context になります。

既存の Shepherd session を開きます。例: Slack から作成された session:

```bash
node dist/src/cli/shepherd.js open "$SHEPHERD_SESSION_ID"
```

running Gateway session に message を送ります:

```bash
node dist/src/cli/shepherd.js send "$SHEPHERD_SESSION_ID" "continue from here"
```

session event を JSON Lines で監視します:

```bash
node dist/src/cli/shepherd.js watch "$SHEPHERD_SESSION_ID"
```

logical tool を stdio JSON Lines で bridge します:

```bash
node dist/src/cli/shepherd-tools.js
```

session 名を変更します:

```bash
node dist/src/cli/shepherd.js rename "$SHEPHERD_SESSION_ID" "Review Slack sync"
```

SQLite audit log から stored session audit event を出力します:

```bash
node dist/src/cli/shepherd.js audit "$SHEPHERD_SESSION_ID"
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
- `src/gateway`: local Gateway server、JSON Lines framing、Pi turn queueing、logical tool、recovery、context、working-context helper。
- `src/db`: SQLite connection、migration application、Drizzle schema、Pi turn、worker binding、session binding、summary store。
- `src/delivery`: platform delivery routing、fanout、receipt、duplicate-send prevention。
- `src/herdr`: Herdr socket client、orchestration、workspace binding、progress subscription。
- `src/platforms/slack`: Slack inbound normalization、Socket Mode wrapper、outbound delivery。
- `src/tui`: TUI-style local surface が使う Gateway socket client。
- `packages/shepherd-pi`: Pi turn mirroring と dynamic `shepherd_*` tool registration を行う Pi extension package。
- `test/unit`: pure logic と contract test。
- `test/integration`: SQLite と cross-module integration test。
- `docs/plans`: active product plan と implementation plan。完了済み plan は `docs/plans/archived` にあります。

## メモ

`src` 配下の TypeScript source は `@/*` import を使えます。build は `tsc-alias` を使い、emitted JavaScript が `dist` から実行できるようにします。

`pnpm-workspace.yaml` は pnpm 11 の build-script approval のためだけにあります。MVP の Shepherd は single-package project です。

## ライセンス

[MIT](LICENSE)
