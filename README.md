# Hakushi（白紙）

**ローカルファースト & Git ネイティブなオープンソース Notion 代替。**
実体はディスク上の Markdown ファイル、ストレージと同期は Git。常設サーバーなしでコラボレーションまで成立する。

> **English**: Hakushi is a local-first, git-native, open-source Notion alternative built with Tauri 2 (macOS / Windows / Linux / iOS / Android from one codebase). Your pages are plain Markdown files on disk — the files *are* the database. Git is the storage, history, and sync layer; issues/PRs/reviews live in custom git refs, so full collaboration works against any git remote with **no dedicated server**. Docs below are in Japanese; see [docs/DESIGN.md](docs/DESIGN.md) and the [ADRs](docs/adr/) for the full design.

## 何であるか

- ページ = ただの `.md` ファイル。Hakushi がなくても読める・編集できる・grep できる。
- Git がストレージ兼同期基盤。履歴・ブランチ・マージ・Issue/PR をアプリ内で提供（`refs/hakushi/*` の追記専用イベントログ）。
- ブロック型 WYSIWYG（TipTap v3）と Markdown ソース（CodeMirror 6）を自由に切替。
- 完全オフラインで 100% 機能。共有は任意の git リモート（GitHub / GitLab / 自前 bare repo）か静的 HTML エクスポート。

## 中核原則

1. **正本は「ディスク上の Markdown」、内部表現は mdast。** 両エディタは mdast のビューに過ぎない。`.md` のバイト列を書けるのは `src/markdown/pipeline.ts` の単一 remark シリアライザだけ（[ADR-0001](docs/adr/0001-markdown-mdast-single-source-of-truth.md)）。
2. **1つの mdast から HTML / PDF / Docx を導出。** 変換の変換を作らない。
3. **モバイルの Git ビルドを最優先で潰す。** デスクトップは git2/libgit2、モバイルは純 Rust の gix（[ADR-0002](docs/adr/0002-dual-git-backend-git2-desktop-gix-mobile.md)）。iOS/Android の `cargo check` を CI ゲートに。

## 現在地（M0–M8 実装完了）

すべてのマイルストーン（M0〜M8）を実装済み。5 ターゲット（macOS / Windows / Linux /
iOS / Android）の CI ゲート（`tsc` / `vitest` / `cargo check` ×4 / `vite build`）が全緑。

| 機能 | 内容 | 状態 |
|---|---|---|
| ワークスペース | 起動時に自動作成・自動オープン。フォルダピッカーは補助メニューに降格 | ✅ |
| デュアルエディタ | TipTap v3 WYSIWYG ⇄ CodeMirror 6 ソース ⇄ リッチビュー、決定論的保存 | ✅ |
| Markdown 正本 | remark parse/stringify + frontmatter + directive + 埋め込み、**冪等性ハーネス** | ✅ |
| ネスト / 埋め込み | フォルダノート描画、`:::embed` 解決（深さ・循環ガード）、id⇄path リンク索引（移動追従） | ✅ |
| テンプレート | Todo / 高度 Todo / Kanban / Calendar のリッチビュー（1 操作 = 意味的最小差分） | ✅ |
| エクスポート | 1 mdast → HTML / Docx / PDF、フォルダノートはサブツリー連結 | ✅ |
| ローカル Git | commit / 履歴 / 意味的差分 / branch / revert（libgit2 デスクトップ・gix モバイル） | ✅ |
| コラボ | Issue / PR / レビュー / マージ（`refs/hakushi/*` 追記専用イベントログ、サーバー不要） | ✅ |
| リモート同期 | `git_sync` 1 操作で fetch→統合→collab 和集合マージ→push、PAT はキーチェーン | ✅ |
| 静的サイト公開 | 全ページを自己完結型 HTML に書き出し（相互リンク書換・共通ナビ付き） | ✅ |
| 自動同期 | アプリ内の起動時 / インターバル同期（dirty はスキップ、コンフリクトはバッジ表示） | ✅ |
| コンフリクト解決 | mdast ブロック単位の意味的 3-way マージ UI（専門用語を出さない 3 択） | ✅ |
| レスポンシブ | ≤768px でサイドバーがドロワー、右パネルが全画面シート、Kanban のタッチドラッグ | ✅ |

### 基盤

- Tauri 2 スケルトン（5 ターゲット構成）+ 5 ターゲット CI マトリクス
- `GitBackend` trait + libgit2（デスクトップ、https は vendored-openssl）/ gix（モバイル、純 Rust・fetch-only pull）

## 開発

```bash
npm install          # 依存をインストール
npm run tauri dev    # デスクトップアプリを起動
```

モバイル（要 Xcode / Android SDK+NDK）:

```bash
npm run tauri ios init && npm run tauri ios dev
npm run tauri android init && npm run tauri android dev
```

テスト・チェック:

```bash
npm run typecheck    # TypeScript
npm test             # vitest（roundtrip 冪等性 + エディタ忠実性コーパス）
cd src-tauri
cargo check                                                              # デスクトップ (git-libgit2)
cargo check --no-default-features --features git-gix                     # gix バックエンド
cargo check --target aarch64-apple-ios --no-default-features --features git-gix
cargo check --target aarch64-linux-android --no-default-features --features git-gix
```

## ロードマップ

| フェーズ | 内容 | 状態 |
|---|---|---|
| M0 | 骨格 + de-risking スパイク（モバイル git ビルド、冪等性ハーネス、5 ターゲット CI） | ✅ |
| M1 | エディタ + ファイル（デュアルエディタ、ビュー切替、決定論的保存） | ✅ |
| M2 | ネストページ / フォルダ / `:::embed` / id リンク索引 | ✅ |
| M3 | エクスポート（HTML / Docx / PDF） | ✅ |
| M4 | ローカル Git + 履歴 / 意味的差分 / branch / revert | ✅ |
| M5 | テンプレート（Todo / 高度 Todo / Kanban / Calendar） | ✅ |
| M6 | コラボ（Issue / PR / レビュー / マージ、`refs/hakushi/*`） | ✅ |
| M7 | リモート同期 + 共有（push/pull、静的 HTML 公開） | ✅ |
| M8 | モバイル堅牢化（タッチ UX、自動同期、コンフリクト解決 UX） | ✅ |

すべてのマイルストーンが完了。今後は下記の [v2 バックログ](#v2-バックログ今後) を参照。

## リモートと同期する

Hakushi の同期は **1 操作**（`git_sync`）に集約される。fetch → 現在ブランチの統合
（up-to-date / fast-forward / merge / conflicts の判定）→ コラボ ref（Issue/PR）の
**決定論的な和集合マージ** → push までを一度に行う。常設サーバーは不要で、任意の
git リモート（GitHub / GitLab / 自前 bare repo / `file://`）が使える。

### セットアップ

1. サイドバーの **⋯ メニュー →「同期設定…」** を開く。
2. **リモート URL** を入力（`https://…` または `file://` / 絶対パス。SSH は今後対応）。
3. https リモートなら **アクセストークン（PAT）** を保存する。トークンは OS の
   キーチェーン（サービス `hakushi`、アカウント = ホスト名）に格納され、**アプリの外へ
   出ない**（TS 側へ返す API は存在しない）。GitHub は Personal Access Token を使う。

### 同期する

- **⋯ メニュー →「今すぐ同期」**、またはサイドバー下部の **「同期」ボタン**。
- 結果はサイドバーのステータス行に表示（最終同期時刻・成功/警告メッセージ）。
- 未コミットの変更（dirty）があるときは「先にコミットしてください」と表示され、
  勝手にコミットや同期はしない。

### 自動同期（アプリ内）

「同期設定…」の **自動同期** セクションで設定する（`.hakushi/config.json` に保存。
gitignore 済み）。

- **起動時に同期**（既定オン）: リモート設定済み・クリーンなワークツリーのときだけ実行。
- **定期的に同期**（既定オフ）: 5〜60 分ごとの単一タイマー（ビジーポーリングなし）。
- **コミット後に同期**（既定オフ）。
- dirty のときは自動同期をスキップ。コンフリクトが出た場合はサイドバーにバッジを出し、
  モーダルは勝手に開かない（ユーザー操作で解決画面へ）。

> OS レベルのバックグラウンド同期（アプリ終了中の同期）は現状スコープ外
> （[v2 バックログ](#v2-バックログ今後)）。M8 の自動同期は「アプリ起動中」に限る。

### モバイルの同期

モバイル（gix バックエンド）は **fetch-only の pull** に対応（純 Rust・C 依存ゼロ）。
push・ブランチ切替・マージはデスクトップ限定なので、モバイルは「デスクトップで clone
済みのリポジトリを pull して読む」運用が基本。UI は未対応機能を非エンジニア向け文言で
案内する。

## コンフリクトを解決する

同期やマージで**同じページの同じ箇所**が両側で別々に編集されると、コンフリクトになる。
Hakushi は `<<<<<<<` マーカーを使わず、**mdast のブロック単位で意味的な 3-way マージ**を
行う解決画面を出す。

- 自動でマージできたブロック（片側だけ変更・両側同一変更・別項目の編集など）は畳んで表示。
- 本当に衝突したブロックだけを **「あなたの変更」/「相手の変更」** として並べ、
  **「どちらを残す」「両方残す」** の 3 択で解決する（ours/theirs/HEAD などの専門用語は出さない）。
- 全ブロックを解決 →「マージを完了」で正規化（`normalizeMarkdown`）した Markdown を書き戻し、
  同期を自動再開（push まで）。**「中断」はいつでも可能**（ワークツリーは無傷のまま）。
- タスクリストや Kanban は項目単位で整列するため、「別カードの移動」と「別カードの追加」は
  自動マージされ、衝突にならない。

コンフリクト解決（in-memory 3-way マージ）は libgit2 バックエンド限定。モバイル（gix）は
fetch-only 運用のため通常コンフリクトは発生しない。

## 静的サイトとして公開する

ワークスペース全体を、サーバー不要でどこにでも置ける静的 HTML サイトに書き出せる。
各ページは自己完結型 HTML（CSS インライン・外部アセットなし）で、埋め込み（`::embed`）は
解決済み、ページ間リンクは `.md` → `.html` に自動書換され、全ページ共通のナビ
サイドバー（ワークスペースツリー）が付く。トップには `index.html`（`Welcome.md`
または最初のページ、ルートに `index.md` があればそれ）が生成される。

### 書き出し手順

1. サイドバーの **⋯ メニュー →「静的サイトを書き出す…」** を選ぶ。
2. 出力先フォルダを選択すると、ワークスペースのフォルダ構造を保ったまま全 HTML が
   書き出される（`Projects/Roadmap.md` → `Projects/Roadmap.html`)。
3. そのフォルダをそのまま任意のホスティングに載せれば公開できる。アプリ自身は
   デプロイを代行しない（サーバーレス原則。ホスティングは既存の手段を使う）。

### GitHub Pages にホスティングする

```bash
# 書き出したフォルダの中で（例: ./site）
cd site
git init
git add -A
git commit -m "Publish site"
git branch -M gh-pages
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin gh-pages
```

GitHub のリポジトリ設定 → **Settings → Pages** で **Branch: `gh-pages` / `(root)`**
を選ぶと `https://<user>.github.io/<repo>/` で公開される。ナビと相互リンクはすべて
相対パスなので、リポジトリ名のサブパス配下でもそのまま動作する。

> ワークスペース自体を Git 管理している場合は、ワークスペース直下にサイトを書き出さない
> こと（`.md` と `.html` が混ざる）。`site/` など別フォルダへ書き出す運用を推奨。

### Netlify にホスティングする

- **ドラッグ&ドロップ**: [app.netlify.com/drop](https://app.netlify.com/drop) に
  書き出したフォルダをドラッグするだけで即公開される。
- **CLI**: `npx netlify deploy --dir=site --prod`(公開ディレクトリを `--dir` で指定)。

Netlify・GitHub Pages 以外（Cloudflare Pages / Vercel / S3 静的ホスティング / 自前の
Web サーバー等）でも、書き出したフォルダを「静的ファイルの公開ルート」に置くだけで動く。
ビルド工程は不要（すでに完成した HTML）。

## v2 バックログ（今後）

M0–M8 で「ローカルファースト & Git ネイティブな Notion 代替」として一通り成立している。
以下は意図的に v2 送りにした正直なリスト。

- **SSH 認証** / 複数リモート / shallow clone / LFS。
- **gix の push**（2025 時点で未成熟）、または isomorphic-git（JS）フォールバック。
  現状モバイルは fetch-only pull。
- **OS レベルのバックグラウンド同期**（BGTaskScheduler / WorkManager。Tauri プラグイン待ち）。
- **モバイル向け stronghold 認証**（Android は現状 keyring の in-memory フォールバック）。
- **Typst PDF バックエンド**（高品質印刷）、**ダークモード**。
- **全文検索**（SQLite FTS）・ページ内検索・リンク自動補完。
- **実機での通し検証**（iOS/Android の[手動チェックリスト](docs/dev/M8-MANUAL-CHECKS.md)消化。
  https の実 push/pull は [M7 手動チェックリスト](docs/dev/M7-MANUAL-CHECKS.md) 参照）。

## ドキュメント

- [docs/DESIGN.md](docs/DESIGN.md) — 設計の正本
- [docs/dev/INTERFACES.md](docs/dev/INTERFACES.md) — モジュール間契約
- [docs/adr/](docs/adr/) — アーキテクチャ決定記録（ADR-0001〜0004）
- [templates/](templates/) — バンドルテンプレート

## ライセンス

[MIT](LICENSE)
