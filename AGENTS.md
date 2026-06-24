# AGENTS.md

Shepherd は Herdr 管理の coding agent を TUI / Slack から操作するための orchestration gateway です。まず `docs/plans/2026-06-24-shepherd-herdr-orchestration.md` と子プランを確認してください。

## よく使うコマンド

- `mise install`: `mise.toml` の Node.js / pnpm を入れる。
- `pnpm install`: 依存関係を入れる。
- `pnpm check`: typecheck、test、Biome、Drizzle check をまとめて実行する。
- `pnpm test`: Vitest を一回実行する。
- `pnpm test:watch`: Vitest の watch。
- `pnpm lint:fix`: Biome の lint/import/format fix を適用する。
- `pnpm db:generate`: `src/db/schema.ts` から SQL migration を生成する。
- `SHEPHERD_DB_PATH=/tmp/shepherd.sqlite pnpm db:migrate`: committed migration を SQLite に適用する。
- `shepherd send --session <id> --text <text>`: running daemon に user message を送る。
- `shepherd watch --session <id> --after 0`: session event stream を JSON Lines で見る。

## 検証手順

実装変更後は原則 `pnpm check` を通してください。DB schema を変えた場合は、先に `pnpm db:generate` で migration を更新し、生成 SQL も確認してください。

この repo は Node.js 24.18.0 と pnpm 11.9.0 を `mise` で固定しています。Codex 実行環境で古い Node が PATH の前に残る場合は、検証コマンドの前に `PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH"` を付けてください。

## 重要パス

- `docs/plans/`: Shepherd MVP の設計・実装計画。
- `src/config/`: TypeBox/Ajv の runtime schema。
- `src/daemon/`: daemon と local transport 周辺。
- `src/db/`: `node:sqlite`、Drizzle schema、migration runner。
- `src/delivery/`: platform delivery routing、fanout、receipt / duplicate-send prevention。
- `src/gateway/`: provider adapters、logical tools、turn queueing、context、summary updates。
- `src/platforms/slack/`: Slack inbound normalization、Socket Mode wrapper、outbound delivery。
- `src/tui/`: daemon JSON Lines RPC client。TUI/CLI など local surface から使う。
- `test/unit/`: pure logic / contract tests。
- `test/integration/`: SQLite など実体を使う integration tests。
- `.zed/settings.json`: Zed 側で Prettier を無効化し、Biome と衝突しないようにする設定。

## コーディング方針

- チャットでの応答は日本語。
- TypeScript は ESM + `NodeNext`。`src` 配下は `@/*` import alias を使える。
- build は `tsc` 後に `tsc-alias` で `dist` の import を実行可能な相対 path に変換する。
- Runtime input/tool schema は TypeBox/Ajv、DB schema は Drizzle に寄せる。
- Markdown docs は MVP の Biome gate には含めない。
- 外部 Herdr / Slack / gateway provider SDK は、該当フェーズで必要な tested scaffold と一緒に追加する。

## 注意

- `node_modules/`, `dist/`, `*.sqlite` は commit しない。
- `pnpm-workspace.yaml` は pnpm 11 の `allowBuilds` 用で、monorepo/workspace 化の意図ではない。
- ユーザーや別プロセスの未コミット変更を勝手に戻さない。
- 詳細な設計判断は README に重複させず、`docs/plans/` を参照する。
