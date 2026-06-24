# Slack Access Scope Plan

Date: 2026-06-24

Parent: [Shepherd Herdr Orchestration Plan](../2026-06-24-shepherd-herdr-orchestration.md)

## Goal

Slack から Shepherd を操作できる範囲を、チーム、チャンネル、ユーザー ID で明示的に制御できるようにする。

Shepherd は Herdr 上の agent や terminal を動かす control-plane なので、Slack workspace 全体に開いた bot として扱ってはいけない。MVP では Slack だけを対象にし、Discord / Telegram などは後で同じ考え方を adapter ごとに拡張できる余地を残す。

## 現状

すでに `platforms.slack` には以下の設定がある。

```yaml
platforms:
  slack:
    app_token_env: SLACK_APP_TOKEN
    bot_token_env: SLACK_BOT_TOKEN
    allowed_teams:
      - T123
    allowed_channels:
      - C123
    allowed_users:
      - U123
```

実装上も Slack inbound で `teamId`、`channelId`、`sourceUserId` を AND 条件で確認している。未設定の allowlist は制限なしとして扱われる。

現状の不足:

- Slack access policy の期待動作が plan と config example として明文化されていない。
- `allowed_users` 未設定時に Slack platform が広く開く可能性がある。
- 将来 Discord / Telegram を追加するときに、platform ごとの ID 概念をどう core に落とすかがまだ明文化されていない。
- 拒否時の observability が弱く、設定ミスと通常無視を区別しづらい。

## 方針

MVP では Slack だけを実装対象にする。

ただし命名と責務分離は platform-neutral に寄せる。

- core DB は Slack 専用カラムを増やさない。
- platform adapter が外部イベントを正規化し、core には `platform`、`spaceId`、`threadId`、`actor.sourceUserId` として渡す。
- Slack の `team_id` は binding metadata または policy 判定用の platform metadata として扱う。
- `allowed_channels` は channel / thread の入口制限に使う。
- `allowed_users` は DM / channel / thread すべてで sender 制限に使う。
- `allowed_teams` は Slack workspace 境界の制限に使う。

Hermes Agent の複雑な admin tier や pairing flow はコピーしない。Shepherd MVP は静的 YAML と `/reload-config` に絞る。

## Access Policy Semantics

Slack inbound message は次の順で判定する。

1. Slack message として正規化できないイベント、bot 自身の message、編集 / 削除などは無視する。
2. `allowed_teams` が設定されている場合、`teamId` が含まれない message は拒否する。
3. `allowed_channels` が設定されている場合、対象 channel が含まれない channel/thread message は拒否する。
4. `allowed_users` が設定されている場合、sender user ID が含まれない message は拒否する。
5. すべて通過した message だけを Shepherd session に保存し、gateway turn を起こす。

未設定 allowlist は「その軸では制限しない」を意味する。ただし安全な運用のため、Slack platform を有効にする設定例では `allowed_users` を必須扱いにする。

将来的に fail-closed を強める場合は、互換性を壊さないために以下のどちらかで段階導入する。

- `allow_all_users: true` を明示したときだけ user allowlist なしを許可する。
- daemon 起動時に `allowed_users` なしを警告し、次の破壊的変更タイミングで必須化する。

## Config Shape

当面は既存 shape を維持する。

```yaml
platforms:
  slack:
    app_token_env: SLACK_APP_TOKEN
    bot_token_env: SLACK_BOT_TOKEN
    allow_customize: true
    allowed_teams:
      - T1234567890
    allowed_channels:
      - C1234567890
    allowed_users:
      - U1234567890
```

将来の拡張候補:

```yaml
platforms:
  slack:
    allow_all_users: false
    denied_channels:
      - C9999999999
```

`denied_channels` は MVP では入れない。allowlist と denylist の優先順位が必要になった時点で、Hermes の `allowed_channels` / `ignored_channels` 相当として検討する。

## Delivery Scope

Outbound delivery は既存の session binding に従う。Slack inbound で許可済みの thread から作られた binding だけが delivery target になるため、通常の gateway / TUI message はその thread に戻る。

追加で確認すること:

- TUI から Slack-bound session に送った user message は、許可済み binding の thread にだけ delivery される。
- `allowed_channels` を狭めたあと、既存 binding への outbound delivery を止めるかどうかは別判断にする。

MVP では inbound policy を最優先にし、既存 binding の outbound 無効化までは行わない。`/reload-config` 後に既存 binding の delivery も止めたい場合は、別途 delivery policy を追加する。

## Observability

Slack event を拒否したとき、ユーザーには返答しない。不要な情報漏えいとチャンネルノイズを避ける。

daemon log には debug level で理由を残す。

- `slack policy denied: team`
- `slack policy denied: channel`
- `slack policy denied: user`

event stream には拒否イベントを保存しない。未許可ユーザーの message 内容を DB に入れないため。

## Future Adapter Compatibility

Discord / Telegram を追加するときは、Slack の設定名を無理に抽象化しない。platform ごとに自然な ID を持つ。

想定:

```yaml
platforms:
  discord:
    bot_token_env: DISCORD_BOT_TOKEN
    allowed_guilds:
      - "123"
    allowed_channels:
      - "456"
    allowed_users:
      - "789"
    allowed_roles:
      - "999"

  telegram:
    bot_token_env: TELEGRAM_BOT_TOKEN
    allowed_chats:
      - "-100123"
    allowed_users:
      - "123456"
```

core 側の共通契約は次に留める。

- adapter は platform event を正規化する。
- adapter は platform-specific policy を inbound 保存前に判定する。
- core は許可済み message だけを session event として扱う。
- DB binding は `platform`, `spaceId`, `threadId`, `metadata` で platform-neutral に保存する。

Discord の role 認可や Telegram の group / forum topic は、Slack MVP に持ち込まない。

## Implementation Steps

1. Slack access policy の契約をテストで固定する。
   - team / channel / user が一致すると保存される。
   - どれか 1 つでも allowlist から外れると保存されない。
   - 未設定 allowlist はその軸を制限しない。
   - bot message / edit / delete は保存されない。

2. 起動時 validation / warning を追加する。
   - `platforms.slack` が有効で `allowed_users` なしの場合、警告する。
   - 将来 `allow_all_users` を導入する場合は、この step で schema と warning を調整する。

3. 拒否理由の debug log を追加する。
   - message text は log しない。
   - team/channel/user ID と拒否理由だけを出す。

4. docs / example config を更新する。
   - Slack setup 例には `allowed_users` と `allowed_channels` を含める。
   - token は env var name だけを YAML に書く方針を明記する。

5. `pnpm check` を通す。

## Non-goals

- Discord / Telegram adapter 実装。
- Hermes Agent の pairing flow。
- role-based authorization。
- Slack workspace 管理 UI。
- 未許可 inbound message の DB 保存。
- outbound delivery に対する config reload 後の retroactive blocking。

## Open Questions

- `allowed_users` なしの Slack config を将来的に hard error にするか、警告に留めるか。
- `allowed_channels` を DM に適用しない仕様を Shepherd でも明示するか。現状 Slack channel ID ベースのため、DM channel を allowlist に入れれば制限できるが、Hermes は DM を channel allowlist の対象外としている。
- `/reload-config` 後、既存 Slack binding への outbound delivery も新 policy で止めるべきか。
