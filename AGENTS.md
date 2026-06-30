# AGENTS.md

Shepherd は、Herdr 管理の coding agent を TUI / Slack などのイベントストリームから操作する orchestration gateway です。通常の作業は README と関連する `src` / `test` から始め、進行中の設計判断や延期事項は `docs/plans/`、完了済み plan の経緯は `docs/plans/archived/` を参照してください。

## よく使うコマンド

- `mise install`: `mise.toml` の Node.js / pnpm を入れる。
- `pnpm install`: 依存関係を入れる。
- `pnpm check`: typecheck、test、Biome、Drizzle check をまとめて実行する。
- `pnpm test`: Vitest を一回実行する。
- `pnpm test:watch`: Vitest の watch。
- `pnpm build`: TypeScript を `dist` に build し、`tsc-alias` で実行可能な import に直す。
- `pnpm lint:fix`: Biome の lint/import/format fix を適用する。
- `pnpm db:generate`: `src/db/schema.ts` から SQL migration を生成する。
- `SHEPHERD_HOME=/tmp/shepherd pnpm db:migrate`: `$SHEPHERD_HOME` の設定に従って committed migration を SQLite に適用する。

## 検証手順

実装変更後は原則 `pnpm check` を通してください。CLI の配布物や `dist` の import 解決に関わる変更では `pnpm build` も実行してください。

DB schema を変えた場合は、先に `pnpm db:generate` で migration を更新し、生成された SQL を確認してから migrate の動作を見てください。

この repo は Node.js 24.18.0 と pnpm 11.9.0 を `mise` で固定しています。古い Node が PATH の前に残る環境では、検証コマンドの前に `PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH"` を付けてください。

## 重要パス

- `src/cli/`: `shepherd` / `shepherd-tools` の CLI entrypoints。
- `src/config/`: TypeBox/Ajv の runtime schema。
- `src/daemon/`: daemon と Unix socket / JSON Lines RPC。
- `src/db/`: `node:sqlite`、Drizzle schema、migration runner。
- `src/delivery/`: platform delivery routing、fanout、receipt / duplicate-send prevention。
- `src/gateway/`: Gateway JSON Lines RPC、Pi turn queueing、logical tools、context、recovery、working context helpers。
- `src/herdr/`: Herdr named session / workspace / pane / agent orchestration。
- `src/platforms/slack/`: Slack inbound normalization、Socket Mode wrapper、outbound delivery。
- `src/tui/`: daemon JSON Lines RPC client。
- `test/unit/`: pure logic / contract tests。
- `test/integration/`: SQLite など実体を使う integration tests。
- `docs/plans/`: 進行中の設計判断、MVP 状態、延期事項。作業前の必読ではなく、仕様判断が必要なときの参照先。
- `docs/plans/archived/`: 完了済み plan の履歴。active plan として扱わない。

## コーディング方針

- チャットでの応答は日本語。
- TypeScript は ESM + `NodeNext`。`src` 配下は `@/*` import alias を使える。
- Runtime input/tool schema は TypeBox/Ajv、DB schema は Drizzle に寄せる。
- Markdown docs は Biome gate に含まれない。変更した docs は目視でリンクと内容を確認する。
- README にある利用例や詳細設計を `AGENTS.md` に重複させない。

## Plan / docs 運用

- Active plan は `docs/plans/` 配下に置く。完了済み plan は `docs/plans/archived/` 配下に置く。
- 大きな plan は親 plan と子 plan に分ける。親 plan は目的、全体方針、進捗サマリ、子 plan へのリンクに絞り、実装詳細はスライス・機能・タスク単位の子 plan に置く。
- 子 plan 用ディレクトリ名は親 plan ファイル名から `.md` を除いたものと完全に一致させる。例: `docs/plans/2026-06-25-pi-runtime-gateway.md` の子 plan は `docs/plans/2026-06-25-pi-runtime-gateway/` に置く。
- plan には進捗を追える欄を置く。最低限 `Status`、`Progress`、`Next steps` を書き、`Progress` は `Not started` / `In progress` / `Blocked` / `Done` などの状態と短い根拠を箇条書きで更新する。
- 子 plan には親 plan への `Parent:` リンクを置く。親 plan には子 plan 一覧と各子 plan の現在状態を置く。
- plan を更新するときは、関連する親子リンク、ディレクトリ名、README / AGENTS からの参照も確認する。
- 完了済み plan を `docs/plans/archived/` に移す場合は、実装変更とは分けた docs-only commit にする。
- 並行セッションで plan 更新が入っている、または追加判断が残っている場合は archive しない。

## 注意

- `node_modules/`, `dist/`, `*.sqlite` は commit しない。
- `pnpm-workspace.yaml` は pnpm 11 の `allowBuilds` 用で、monorepo/workspace 化の意図ではない。
- ユーザーや別プロセスの未コミット変更を勝手に戻さない。
