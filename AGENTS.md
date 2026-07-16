# AGENTS.md

Shepherd は Herdr 管理の coding agent から agent snapshot、`agent.*` event、orchestrator notification を作る TypeScript daemon / CLI です。まず `README.md` で使い方を確認し、仕様判断が必要なときだけ `docs/plans/` を見てください。

## よく使うコマンド

- `mise install`: `mise.toml` の Node.js / pnpm を入れる。
- `pnpm install`: 依存関係を入れる。
- `pnpm check`: typecheck、test、Biome、Drizzle、Pi package、Herdr plugin の検証をまとめて実行する。
- `pnpm test`: Vitest を一回実行する。
- `pnpm test:watch`: Vitest の watch。
- `pnpm build`: 古い`dist`を削除してTypeScriptを出力し、`tsc-alias`でimport aliasを解決する。
- `pnpm package:check`: root npm packageをbuildし、tarballのfile allowlistを検証する。
- `pnpm lint:fix`: Biome の lint/import/format fix を適用する。
- `pnpm db:generate`: `src/db/schema.ts` から SQL migration を生成する。
- `SHEPHERD_HOME=/tmp/shepherd pnpm db:migrate`: 指定した Shepherd home の SQLite DB に migration を適用する。

## 検証手順

- 実装変更後は `pnpm check` を通す。
- CLI entrypoint、`dist`のimport解決、package内容に関わる変更では`pnpm build`と`pnpm package:check`も通す。
- DB schema を変えたら `pnpm db:generate` を先に実行し、生成 SQL を確認してから migrate を見る。
- Node / pnpm の PATH が古い環境では、検証コマンドの前に次を付ける。

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH"
```

## 重要パス

- `src/observability/`: agent contract、cached agent context、agent index、orchestrator service。
- `src/daemon/`: daemon JSON Lines RPC、process manager、service startup。
- `src/cli/`: `shepherd` CLI entrypoint。
- `src/config/`: runtime config schema と path/env 解決。
- `src/db/`: SQLite connection、Drizzle schema、migration runner、observability store。
- `src/herdr/`: Herdr socket client、managed session client、session snapshot、workspace resolver。
- `src/shared/`: JSON Lines framing などの共有 utility。
- `packages/shepherd-pi/`: npmで公開するPi extension package。
- `packages/shepherd-herdr-plugin/`: GitHub経由で配布するprivate Herdr integration。npmには公開しない。
- `test/unit/`: pure logic / contract tests。
- `test/integration/`: SQLite / JSON Lines RPC など実体を使う tests。
- `docs/plans/`: active plan。完了済み plan は `docs/plans/archived/` に置く。

## コーディング方針

- チャットでの応答は日本語。
- TypeScript は ESM + `NodeNext`。`src` 配下は `@/*` import alias を使う。
- Runtime schema は TypeBox/Ajv、DB schema は Drizzle に寄せる。
- 変更は既存の層に合わせる。transport、persistence、observability rules、runtime extension の責務を混ぜない。
- Markdown docs は Biome gate の対象外。変更した docs はリンクとコマンドを目視で確認する。
- README の利用例や詳細設計を AGENTS.md に重複させない。

## Plan / docs 運用

- npmとGitHubのrelease手順は`docs/releasing.md`を正とする。公開するnpm packageはrootと`packages/shepherd-pi`の2つだけ。
- Active plan は `docs/plans/` 配下に置く。完了済み plan は `docs/plans/archived/` 配下に移す。
- 大きな plan は親 plan と子 plan に分ける。親は目的、方針、進捗、子 plan link に絞る。
- 子 plan ディレクトリ名は親 plan ファイル名から `.md` を除いた名前と一致させる。
- plan には `Status`、`Progress`、`Next steps` を置く。
- plan 更新時は親子リンク、ディレクトリ名、README / AGENTS からの参照を確認する。
- 完了済み plan の archive は docs-only commit に分ける。

## 注意

- `node_modules/`, `dist/`, `*.sqlite` は commit しない。
- `pnpm-workspace.yaml` は pnpm 11 の `allowBuilds` 用。workspace 化の意図で編集しない。
- ユーザーや別プロセスの未コミット変更を戻さない。
