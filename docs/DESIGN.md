# Hakushi（白紙） — ローカルファースト & Git ネイティブな Notion 代替

> このドキュメントは Plan モードで確定した設計の正本。実装は本書に従う。
> 確定日: 2026-07-04

## Context（背景と目的）

Notion は高価で操作性にも不満がある。そこで、**Markdown ファイル群を実体とし、Git を基盤に管理・同期する、オープンソースの Notion 代替アプリ「Hakushi」** を新規に作る。要件（md 実体・ページ埋め込み・フォルダ化・Git 管理・テンプレート・共有・モバイル/PC 同期）は、「ローカルファースト + Git がストレージ兼同期基盤」という設計に驚くほどきれいに噛み合う。

ユーザーの確定方針:

- **プラットフォーム**: Tauri 2（1つの Web フロントエンド + Rust で Mac/Win/Linux/iOS/Android を単一コードベースで）。
- **Git/同期**: Git を実体・同期基盤にしつつ、**Hakushi 内で GitHub 相当の体験**(履歴・PR 作成・Issue 提案・マージ)を提供。専用常設サーバーは必須にしない。
- **エディタ**: ブロック型 WYSIWYG（Notion 風）と Markdown ソースの**両方を切替可能**。
- **MVP**: テンプレート・共有まで含む**フル構成**（ただし実行は現実的にフェーズ分割する）。

## 設計の中核原則（最重要）

1. **正本は「ディスク上の Markdown」、内部表現は `mdast`（unified/remark AST）。両エディタは mdast の“ビュー”に過ぎず、どちらのエディタの内部モデルも真実ではない。**
   - 理由: BlockNote の Markdown 出力は公式に非可逆（lossy）で、同社ドキュメントも「忠実に保存するなら JSON で」と明記。md を正とする本アプリとは根本的に相性が悪い（→ 不採用、ADR-0001 参照）。
   - `.md` へ書き込むのは **remark の単一シリアライザだけ**。エディタにシリアライズを任せない（ビュー切替が無関係なバイトを書き換えて git 差分を汚す/YAML frontmatter を壊す事故を防ぐ）。
2. **1つの mdast から HTML/PDF/Docx の3形式を導出**（変換の変換を作らない）。
3. **モバイルの Git ビルドを最優先で潰す**（M0 スパイク）。ここが全体の最大リスク。

## 技術スタック（検証済み）

| 領域 | 採用 | 理由・備考 |
|---|---|---|
| フロントエンド | **React** | mdast 忠実な TipTap/CodeMirror が React エコシステム中心。Tauri のモバイル webview では React の実行コストは非問題。 |
| ブロック WYSIWYG | **TipTap v3 + 公式 `@tiptap/markdown`** | 2025-10 に双方向 Markdown 拡張が公式化。**カスタムノードが独自の md parse/serialize を定義可能**（埋め込み・テンプレートに必須）。BlockNote は lossy のため不採用。 |
| Markdown ソース編集 | **CodeMirror 6** | `lang-markdown`。フレームワーク非依存、モバイルのタッチも実用的。 |
| 正本パイプライン | **remark/rehype** (`remark-parse` + `remark-gfm` + `remark-frontmatter` + `remark-directive` + 自作 `remark-hakushi-embed`) | mdast ⇄ `.md` の唯一の入出力。決定論的シリアライズで差分をクリーンに保つ。 |
| Git（デスクトップ） | **git2-rs（libgit2）** | merge/push が最も枯れている。OpenSSL はデスクトップでは問題なくビルド可。 |
| Git（モバイル） | **gix（gitoxide）+ rustls（純 Rust）** | git2 の OpenSSL クロスコンパイルが iOS/Android で詰まる既知問題を回避。Cargo が対応する全ターゲットでビルド可。 |
| Git 抽象化 | **`trait GitBackend`** | clone/commit/branch/diff/merge/status/push/pull/fetch + custom-ref 読み書き。上位層は実装を意識しない。push/merge が gix で不足する場合は **isomorphic-git（JS）を push/fetch に、mdast 3-way merge を merge に**フォールバック。 |
| 認証 | HTTPS PAT を OS キーチェーン（`tauri-plugin-stronghold`/`keyring`）、SSH は gix/system ssh。`CredentialProvider` で抽象化。 |
| HTML 出力 | mdast → `rehype`（`mdast-util-to-hast`）→ `rehype-stringify` | 静的サイト公開の基盤にも流用。 |
| Docx 出力 | **`mdast2docx` / `@m2d/remark-docx`** | mdast → docx.js。ブラウザ/Node 両対応、ネイティブ依存なし＝モバイル可。pandoc は重い上に iOS 不可のため不採用。 |
| PDF 出力 | **webview の print-to-PDF**（`PdfBackend` trait） | デスクトップは各 webview の PDF 出力（追加依存ゼロ）。モバイルはプラットフォーム webview の PDF をベストエフォート。**Typst（純 Rust）は v2 の高品質バックエンド**として後回し（モバイルビルド未実証のため MVP のクリティカルパスに載せない）。pandoc+LaTeX・headless-chrome は不採用。 |
| 索引キャッシュ | **SQLite**（`.hakushi/index.db`、gitignore） | id⇄path リンク索引、Issue/PR のマテリアライズドビュー。再構築可能なので git には入れない。 |

## オンディスク・データモデル

### ネストページ と「フォルダ = 子の埋め込みのみのページ」

Obsidian 系で実証済みの **folder-note 方式**を採用:

```
MyProject/
  index.md          # ページ "MyProject" 自体
  Roadmap/
    index.md        # 子ページ（さらに子を持てる）
  Notes.md          # 子ページ（葉）
  assets/diagram.png
```

- **ページ** = `Foo.md`（葉）または `Foo/index.md`（子を持てるページ）。
- **フォルダ判定は保存せず計算する**: `index.md` の本文を mdast に parse した結果が**埋め込みノードのみ**（frontmatter/見出しを除く）なら、サイドバーでフォルダとして描画。特別なファイル種別は不要で、同期対象が増えない。「フォルダ化」操作 = 本文を子の埋め込みだけにする、という意味に過ぎない。

### 埋め込み（transclusion）構文: **`remark-directive` の `:::embed`**

`:::embed{page="Roadmap" mode="folder"}` / リーフ `::embed[Roadmap]{#id}`。

- 一級 mdast ノードとして parse され、HTML/PDF/Docx レンダラと TipTap カスタムノードに同一ノードが流れる。属性（`mode=folder|inline|preview`、Kanban のカラム等）も持てる。
- 互換のため**入力時は `![[wikilink]]` も寛容に受理**するが、**保存時は常に directive 形式で書き出す**（tolerant-input / canonical-output）。

### ID・リンク・移動

- 全ページに **frontmatter に安定 ULID/UUID**（`id: 01J...`）。埋め込み・PR/Issue 参照の永続的アイデンティティ。移動/改名でも参照が壊れない。
- **本文のリンクはパス相対**（人間可読、GitHub プレビューでも機能）。`.hakushi/index.db` が `id⇄path` を保持し、移動/改名時に相対リンクを書き換える。**id が真実、path は利便**。
- frontmatter（YAML）: `id`, `title`, `created`, `updated`, `template`, テンプレ設定。順序安定・最小限で差分をクリーンに。

### 構造化データの黄金則

**不透明な JSON ではなく Markdown ネイティブ表現を優先**し、git 差分を意味的に保つ（カード移動が1行差分になるように）。設定（カラム順・色）だけ frontmatter に置く。

## Git ネイティブ・コラボ層（サーバー不要で成立）

実証済みプリオールアート（git-bug / git-native-issue）に倣い、**追記専用イベントログを custom git refs に保存**する。

- **Issue/コメント**: `refs/hakushi/issues/<id>` 配下のコミット列（作成・コメント・ラベル・クローズ＝各1コミット）。マージ = イベントログの和集合（論理クロック＋timestamp 順）→ **コンフリクトなし**。`.hakushi/index.db` に一覧用マテリアライズ。
- **Pull Request**: PR は「`main` へマージ提案するブランチ」＋ `refs/hakushi/prs/<id>` のメタ（タイトル・説明・レビュアー・状態）。**レビュー**は `(blob oid, line)` または `(page id, block)` に紐づくイベントログ。
- **アプリ内マージ** = `GitBackend::merge(base, head)`。デスクトップは libgit2、モバイルは gix または **mdast レベルの 3-way merge**。マージイベントを PR ログに記録し `main` を更新。
- **1回の push/pull で全部同期**: refspec に `refs/heads/*` と `refs/hakushi/*` を含める。**常設サーバー不要**（共有リモートが bare repo でも GitHub でもフルコラボ可能）。

### 共有オプション（この設計から自然に出る）

1. **任意の git リモート**（GitHub/GitLab/Gitea/自前 bare）= 同期＋非公開コラボ。完全オフライン可。
2. **静的 HTML エクスポート**（mdast→rehype）→ GitHub Pages/Netlify 等で**公開読み取りリンク**。サーバー不要。
3. **（v2 任意）軽量セルフホスト「Hub」サーバー**: collab refs を HTTP 配信し PR/Issue をブラウザ表示（Hakushi 未導入者向け）。アプリは決してこれに依存しない。

アプリは**ネットワークなしで 100% 機能**（編集・履歴・分岐・ローカル PR・エクスポート）。

## テンプレート

各テンプレート = **TipTap カスタムノード**（WYSIWYG 編集可）＋ **Markdown ネイティブ表現**（ソース編集可・差分フレンドリー）。設定は frontmatter。本文に不透明 JSON を置かない。

- **Todo**: GFM タスクリスト `- [ ] item`（`remark-gfm` で往復済み、追加実装ゼロ）。
- **高度な Todo**: インライン directive で属性付与 — `- [ ] Ship M1 :due[2026-08-01] :prio[high] #editor`（1タスク1行 = 1行差分）。
- **Kanban**: frontmatter にカラム順/色、本文は `## カラム名` + タスクリスト。カード移動 = リスト項目の移動 = クリーン差分。

  ```markdown
  ---
  id: 01J8KANBAN
  template: kanban
  kanban: { columns: [Backlog, In Progress, Done] }
  ---
  ## Backlog
  - [ ] Design AST adapter :prio[high]
  ## In Progress
  - [ ] Editor sync spike :assignee[keita]
  ## Done
  - [x] Repo skeleton
  ```

- **Calendar**: frontmatter にビュー設定、本文は Markdown テーブル（行=イベント、`page` 列でページ id に deep-link）。行追加/移動 = 1行差分。

  ```markdown
  ---
  id: 01J8CAL
  template: calendar
  calendar: { default_view: month }
  ---
  | date       | title      | page        | tag    |
  |------------|------------|-------------|--------|
  | 2026-07-10 | M1 review  | 01J8...page | review |
  ```

- **再利用**: テンプレは `templates/` 配下の `.md`。「テンプレートから新規」= ファイル複製 + 新 id 発行。任意ページを保存してユーザー独自テンプレも作れる。

## フェーズ別ロードマップ

- **M0 — 骨格 + de-risking スパイク（最重要）**: Tauri 2 が全5ターゲットで起動する空シェル。ゲート2つ = (1) 採用 git crate が `aarch64-apple-ios` / `aarch64-linux-android` で `cargo build` 通る、(2) mdast の parse→stringify 冪等性ハーネス。CI に5ターゲットのマトリクス。**モバイル git ビルドをここで殺すのが目的。**
- **M1 — エディタ + ファイル**: フォルダを開き `.md` をブラウズ、TipTap/CM6 で同一ファイルを編集・ビュー切替・決定論的保存。round-trip テストコーパスを CI ゲート化。
- **M2 — ネストページ/フォルダ/埋め込み**: folder-note ツリー、`:::embed`、フォルダ計算描画、安定 id + リンク索引、移動/改名でリンク書換。循環埋め込みは深さ制限＋循環検出でガード。
- **M3 — エクスポート**: ページ/サブツリーを HTML(rehype)/Docx(mdast2docx)/PDF(webview print)。埋め込みを解決してから出力。デスクトップ PDF 先行、モバイル PDF はベストエフォート。
- **M4 — ローカル Git + 履歴/差分**: init/commit、ページ単位履歴、**mdast の意味的差分**（生ハンクでなく「カード移動」「タスク完了」）、branch 作成/切替、revert。
- **M5 — テンプレート**: Todo/高度 Todo/Kanban/Calendar を TipTap ノード + 上記オンディスク形で。「テンプレから新規」、ユーザーテンプレ。ノードのバイト安定性を M1 ハーネスで担保。
- **M6 — コラボ（Issue/PR/レビュー/マージ）**: `refs/hakushi/*` イベントログ、SQLite マテリアライズ、PR/Issue/レビュー UI、`GitBackend::merge`。マージはデスクトップ先行、モバイルは capability flag。
- **M7 — リモート同期 + 共有**: remote 追加、push/pull（code+collab refs を1操作）、HTTPS-token/SSH をキーチェーンで、静的 HTML 公開。gix push 不足時は isomorphic-git フォールバック。
- **M8 — モバイル堅牢化**: タッチ UX（エディタ/Kanban ドラッグ）、モバイル PDF、バックグラウンド同期、**非エンジニア向けコンフリクト解決 UX**。

## 主要リスクと対策

1. **モバイル Git（最大リスク）**: git2-rs の OpenSSL クロスコンパイルが iOS/Android で詰まる。→ モバイルは純 Rust `gix`+`rustls`、`GitBackend` trait で抽象化、isomorphic-git を push/fetch フォールバック。**M0 でビルド実証**してから機能着手。
2. **WYSIWYG↔Markdown 忠実性**: BlockNote は設計上 lossy、TipTap も素朴実装だと frontmatter を壊す。→ 正本 remark シリアライザがディスク書込を独占、冪等性ハーネスを M1 から CI ゲート、埋め込みは tolerant-input/canonical-output。
3. **モバイル PDF**: Tauri 統一 print API なし、LaTeX は iOS 不可。→ `PdfBackend` trait、デスクトップは webview print(現状可)、モバイルはプラットフォーム webview PDF。Typst は後日・専用スパイクの後。
4. **非技術者のマージコンフリクト UX**: `<<<<<<<` マーカーは使い物にならない。→ 安定 id つき Markdown を活かし **mdast/ブロック単位の意味的 3-way merge**（「2人がこのブロックを編集：どちらか選択/両方残す」）。非重複ブロックは自動マージ。コラボメタは追記専用ログで**構造的に無衝突**。
5. **gix の push/merge 完全性**: libgit2 より歴史的に弱い。→ 実行時に capability 検出しフォールバック。M4/M6 で gix バージョンを固定・再検証。
6. **Typst のモバイル未実証**: 出荷事例なし。→ MVP のクリティカルパスから完全に外す。

## 作成する主要ファイル（アーキテクチャの集中点）

- `src-tauri/src/git/backend.rs` — `GitBackend` trait と libgit2/gix/isomorphic-git 実装。**最も load-bearing な抽象**（モバイル git リスクの本丸）。
- `src/markdown/pipeline.ts` — 正本 remark/rehype パイプライン（parse/stringify/`remark-hakushi-embed`/frontmatter）。`.md` を書く唯一の場所。
- `src/editor/mdast-tiptap-adapter.ts` — mdast⇄ProseMirror 双方向変換 + 埋め込み/テンプレのカスタムノード。忠実性の勝負所。
- `src-tauri/src/collab/refs.rs` — `refs/hakushi/*` の Issue/PR/レビュー イベントログストア。サーバーレス・コラボ基盤。
- `src/export/index.ts` — mdast→{HTML, Docx(`mdast2docx`), PDF} を format trait 越しに。1-AST-3-出力の契約。

補助: `src-tauri/tauri.conf.json`（5ターゲット構成）、CI マトリクス、`src/markdown/roundtrip.test.ts`（冪等性ハーネス）、`templates/`（バンドルテンプレ）、`.hakushi/`（index.db は gitignore）。

## 検証方法（各フェーズの Done 判定）

- **M0**: `cargo build --target aarch64-apple-ios` と `--target aarch64-linux-android` が採用 git crate 込みで成功。`npm test` で `parse→stringify` 冪等 & `parse→toTiptap→toMdast→stringify == parse→stringify` が実ドキュメントコーパスで一致。5ターゲットでアプリ起動。
- **M1**: 同一 `.md` を WYSIWYG/ソースで往復編集→保存後の git diff がユーザー編集分のみ（無関係バイト書換ゼロ）。
- **M2**: 埋め込み/フォルダ計算描画が期待通り、ページ移動でリンクが自動追従、循環埋め込みで無限ループしない。
- **M3**: 1ページ+サブツリーを HTML/Docx/PDF 出力し、埋め込みが解決済み・ダウンロード可能。Docx を Word で、PDF/HTML をブラウザで目視。
- **M4**: commit→履歴表示→意味的差分表示→branch/revert が動作。
- **M5**: 4テンプレを新規作成→編集→保存し、オンディスク形が仕様どおり & round-trip 安定。
- **M6**: 2クローン間で Issue 作成/PR/レビュー/マージが push/pull のみで同期（サーバーなし）。
- **M7**: リモート追加→双方向 push/pull（collab refs 含む）、静的 HTML 公開リンクが閲覧可能、キーチェーン認証。
- **M8**: 実機（iOS/Android）でタッチ編集・Kanban ドラッグ・同期・コンフリクト解決 UX を通し確認。

## 未決事項（実装前に確定推奨・ブロッカーではない）

- **ライセンス**: OSS Notion 代替として MIT（許容的）か AGPL（コピーレフト/セルフホスト保護）か。デフォルトは MIT を想定。
- **Rust 側 git crate の最終ピン留めバージョン**（M0 スパイク結果で確定）。

---

## 実装ステータス（2026-07 時点）

> このセクションは実装の到達点を記録する追記であり、上記の設計本文は正本として不変。

**M0–M8 すべて実装完了。** 5 ターゲット CI ゲート（`tsc` / `vitest` / `cargo check`
×4：libgit2・gix・aarch64-apple-ios・aarch64-linux-android / `vite build`）が全緑。

確定事項:

- **ライセンス**: MIT（[LICENSE](../LICENSE)）。
- **Rust git crate ピン留め**: デスクトップ `git2 0.20`（https は vendored-openssl +
  vendored-libgit2）、モバイル `gix 0.85.0`（純 Rust）。gix はネットワークを
  `blocking-http-transport-reqwest-rust-tls`（rustls/ring）で **fetch-only pull** に
  配線（push/checkout/merge はデスクトップ限定、capabilities に正直に反映）。詳細は
  [M0-SPIKE-RESULTS.md](dev/M0-SPIKE-RESULTS.md)。

設計本文に対する主な実装上の割り切り（すべて DESIGN 本文のリスク項に対応）:

- コンフリクトは `<<<<<<<` マーカーを使わず、**mdast ブロック単位の意味的 3-way マージ**
  UI で解決（in-memory merge は libgit2 限定）。
- モバイル PDF は「不統一な印刷 API」問題に対し `window.print()` ベストエフォート +
  「HTML を書き出して共有」フォールバック。デスクトップ PDF は一時ファイル + `file://`
  を WebviewWindow で開く方式（`tauri://error` → `window.open` フォールバック）。
- 自動同期はアプリ内のみ（起動時 / インターバル / コミット後）。OS バックグラウンド同期は
  v2 送り。

残タスク（v2 バックログ）は [README.md](../README.md) の「v2 バックログ」を参照。
