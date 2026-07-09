# Hakushi 内部インターフェース契約 (M0–M1)

このファイルはモジュール間の**契約**。各モジュールの実装者はこの契約に従うこと。
契約を変えたい場合は、このファイルを先に更新し、両側の実装を揃える。

## 1. Tauri コマンド (Rust → TS)

すべて `Result<T, String>`（エラーは人間可読メッセージ）。`root` は絶対パス、
`rel_path` はワークスペース相対の `/` 区切りパス。**`rel_path` が root の外へ
出るリクエストは必ず拒否する**（`..` 展開・シンボリックリンク攻撃を防ぐ）。

### ファイル系 (`src-tauri/src/fs_commands.rs`)

```rust
#[tauri::command]
fn list_tree(root: String) -> Result<Vec<TreeEntry>, String>;
// TreeEntry { name: String, rel_path: String, is_dir: bool, children: Option<Vec<TreeEntry>> }
// - .md ファイルとディレクトリのみを含む（それ以外のファイルは M1 では出さない）
// - ドット始まり・`.git`・`.hakushi`・`node_modules`・`target` はスキップ
// - ソート: ディレクトリ先、その後ファイル、それぞれ大文字小文字無視の辞書順
// - is_dir=true の children は Some(vec)（空でも Some）。ファイルは None。

#[tauri::command]
fn read_text_file(root: String, rel_path: String) -> Result<String, String>;

#[tauri::command]
fn write_text_file(root: String, rel_path: String, content: String) -> Result<(), String>;
// 親ディレクトリが無ければ作る。

#[tauri::command]
fn create_page(root: String, rel_path: String, content: String) -> Result<(), String>;
// write_text_file と同じだが、既存ファイルがあればエラー（上書き防止）。
```

### Git 系 (`src-tauri/src/git/commands.rs`)

```rust
#[tauri::command]
fn git_backend_info() -> Result<BackendInfo, String>;
// BackendInfo { name: String /* "libgit2" | "gix" */, capabilities: Capabilities }
// Capabilities { init: bool, status: bool, commit: bool, log: bool,
//                branch: bool, merge: bool, push: bool, pull: bool }

#[tauri::command]
fn git_init(root: String) -> Result<(), String>;      // 既にリポジトリなら no-op 成功

#[tauri::command]
fn git_status(root: String) -> Result<Vec<StatusEntry>, String>;
// StatusEntry { rel_path: String, status: String }
// status ∈ "new" | "modified" | "deleted" | "renamed" | "conflicted"

#[tauri::command]
fn git_commit(root: String, message: String) -> Result<String, String>;
// 全変更をステージ（add -A 相当）してコミット。返り値はコミット OID の hex。
// 変更が無ければ Err("nothing to commit")。

#[tauri::command]
fn git_log(root: String, rel_path: Option<String>, limit: Option<u32>)
    -> Result<Vec<CommitInfo>, String>;
// CommitInfo { oid: String, summary: String, author_name: String, timestamp: i64 /* epoch sec */ }
// rel_path 指定時はそのファイルに触れたコミットのみ。limit デフォルト 100。
```

### `GitBackend` trait (`src-tauri/src/git/backend.rs`)

設計書どおりのフルサーフェスを**今**宣言する（clone/commit/branch/diff/merge/
status/push/pull/fetch + custom-ref 読み書き）。M0-M1 で実装するのは
`init / is_repo / status / commit_all / log`。残りはデフォルト実装
`Err(GitError::Unsupported(op))` を与え、`capabilities()` に正直に反映する。

- デスクトップ（feature `git-libgit2`, default）: `Libgit2Backend`
- モバイル（feature `git-gix`）: `GixBackend`（純 Rust。**iOS/Android で cargo
  check が通ることが M0 ゲート**。ローカル操作は実装できる範囲で）
- 選択は `git/mod.rs` の `pub fn backend() -> &'static dyn GitBackend`
  （feature フラグで静的に決定）。

## 2. TS 側ラッパー (`src/app/workspace.ts`)

```ts
export interface TreeEntry {
  name: string;
  relPath: string;      // Rust 側 rel_path。invoke 引数/返り値は snake_case なので変換する
  isDir: boolean;
  children: TreeEntry[] | null;
}

export async function openWorkspace(): Promise<string | null>;
// @tauri-apps/plugin-dialog の open({ directory: true })

export async function listTree(root: string): Promise<TreeEntry[]>;
export async function readFile(root: string, relPath: string): Promise<string>;
export async function writeFile(root: string, relPath: string, content: string): Promise<void>;
export async function createPage(root: string, relPath: string, content: string): Promise<void>;
```

注: Tauri v2 の invoke 引数はデフォルトで camelCase→snake_case 変換される
（`invoke("read_text_file", { root, relPath })` が Rust の `rel_path` に対応）。
返り値の JSON は Rust の serde 側で `#[serde(rename_all = "camelCase")]` を
付け、TS 型と一致させる。

## 3. Markdown 正本パイプライン (`src/markdown/pipeline.ts`)

**`.md` のバイト列を生成してよいのはこのモジュールだけ。**

```ts
import type { Root } from "mdast";

export function parseMarkdown(md: string): Root;
// remark-parse + remark-frontmatter(yaml) + remark-gfm + remark-directive
//   + remarkHakushiEmbed(tolerant-input: ![[wikilink]] → embed directive)

export function stringifyMarkdown(tree: Root): string;
// 決定論的シリアライズ。設定（canonical style）:
//   bullet "-", emphasis "*", strong "*", fence "`", fences true,
//   listItemIndent "one", rule "-", ruleSpaces false, setext false,
//   incrementListMarker true, tightDefinitions true
// 末尾は必ず単一の "\n"。

export function normalizeMarkdown(md: string): string;
// = stringifyMarkdown(parseMarkdown(md))。冪等であること:
//   normalizeMarkdown(normalizeMarkdown(x)) === normalizeMarkdown(x)

export interface PageMeta {
  id?: string;
  title?: string;
  template?: string;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export function readFrontmatter(md: string): PageMeta | null;
export function splitFrontmatter(md: string): { frontmatter: string | null; body: string };
// frontmatter は "---\n...\n---\n" を含む生テキスト（バイト保存用）。
export function joinFrontmatter(frontmatter: string | null, body: string): string;
export function newPageMarkdown(title: string): string;
// 新規ページ: id は ulid()、title、created(ISO 日付)。キー順: id, title, template, created, updated, その他。
```

### 埋め込み directive (`src/markdown/remark-hakushi-embed.ts`)

- mdast 上の表現は remark-directive の `leafDirective` / `containerDirective`
  で `name === "embed"`。独自ノード型は増やさない。
- 属性: `page`（ページ id またはワークスペース相対パス、必須）、
  `mode` ∈ `inline | folder | preview`（省略時 inline）。
- tolerant-input: テキスト中の `![[Target]]` / `![[Target|Label]]` を parse 後に
  `leafDirective{name:"embed", attributes:{page:"Target"}, children:[Label]}` へ変換。
- canonical-output: ディスクには常に directive 形式（remark-directive の
  シリアライズ）で書かれる。

## 4. エディタ層 (`src/editor/`)

```
EditorPane.tsx   — props { workspaceRoot: string; filePath: string }
                   モード state ("wysiwyg" | "source")、読込・保存・切替の司令塔
BlockEditor.tsx  — TipTap v3。props { body: string; onDirty(): void } + ref で getBody(): string
SourceEditor.tsx — CodeMirror 6。props { content: string; onDirty(): void } + ref で getContent(): string
```

規約（M1 忠実性の核心）:

1. 保存経路は常に: エディタ内容 → md 文字列 → `normalizeMarkdown` → `writeFile`。
   **エディタのネイティブ直列化を直接ディスクへ書かない。**
2. WYSIWYG は frontmatter を**見せない・触らせない**: `splitFrontmatter` で分離し、
   body だけ TipTap へ。保存時に `joinFrontmatter` で原文の frontmatter を再結合。
3. ソースエディタはファイル全文（frontmatter 込み）を編集する。
4. ビュー切替時は現エディタ内容を md 化 → normalize → 相手エディタへ渡す。
5. 埋め込み directive（`::embed{...}` / `:::embed`）は TipTap カスタムノード
   `HakushiEmbed` として表示し、md との往復でバイト安定であること。
   （@tiptap/markdown のカスタムトークナイザが困難な場合の M1 限定フォールバック:
   TipTap へ渡す前に embed ブロックをプレースホルダへ退避し、取り出し時に復元。
   その場合は TODO コメントを残す。）

## 5. M2 追加契約: 既定ワークスペース / インデックス / 移動追従 / 埋め込み解決

### 5.1 既定ワークスペース（フォルダピッカー廃止）

Hakushi は Notion 同様「開けば使える」: 起動時に**アプリ管理ワークスペース**を
自動作成・自動オープンする。フォルダ選択は補助メニュー（「別のフォルダを開く…」）
に降格。

```rust
#[tauri::command]
fn ensure_default_workspace(app: tauri::AppHandle) -> Result<String, String>;
// {app_data_dir}/workspace を作成（無ければ）→ git init（未リポジトリなら）→
// 空なら Welcome ページ（Welcome.md、newPageMarkdown 相当の frontmatter 付き埋込
// テキストは Rust 側に静的文字列で持つ。ただし正規形で書くこと）→ 絶対パスを返す。
```

TS: `App.tsx` は起動時に `ensureDefaultWorkspace()` を呼び即オープン。

### 5.2 ファイル操作の追加

```rust
#[tauri::command]
fn rename_path(root: String, from_rel: String, to_rel: String) -> Result<(), String>;
// ファイル/ディレクトリ両対応。to の親を作成。to が既存ならエラー。パス検証は既存規約。

#[tauri::command]
fn delete_path(root: String, rel_path: String) -> Result<(), String>;
// ファイル/ディレクトリ再帰削除（git に履歴が残るので trash 不要）。
```

### 5.3 id⇄path リンク索引（SQLite, `.hakushi/index.db`）

**md の解析は TS（remark）だけ**が行う。Rust 索引は「構造化データの保存と検索」のみ。
TS がワークスペーススキャン時に `extractRefs` の結果を Rust へ push する。

```rust
// PageRecord { id: Option<String>, relPath, title: Option<String>, template: Option<String> }
// RefRecord  { kind: "link" | "embed", target: String /* 生ターゲット: 相対パス or id */ }

#[tauri::command]
fn index_put_pages(root: String, pages: Vec<PagePut>) -> Result<(), String>;
// PagePut { page: PageRecord, refs: Vec<RefRecord> } — upsert（relPath キー）。

#[tauri::command]
fn index_remove_pages(root: String, rel_paths: Vec<String>) -> Result<(), String>;

#[tauri::command]
fn index_clear(root: String) -> Result<(), String>;

#[tauri::command]
fn index_lookup(root: String, id_or_path: String) -> Result<Option<PageRecord>, String>;
// id 完全一致 → relPath 完全一致 → 拡張子/index.md 補完（"Foo" → "Foo.md" | "Foo/index.md"）の順。

#[tauri::command]
fn index_backlinks(root: String, rel_path: String) -> Result<Vec<BacklinkRecord>, String>;
// BacklinkRecord { srcRelPath: String, kind: String, target: String }
// 「target がこのページ（の id か 相対パス）を指す」参照元一覧。
// target のパス解決は保存時の生文字列に対し、src からの相対を正規化して照合。
```

SQLite は rusqlite（bundled）。スキーマは `pages(rel_path PK, id, title, template)` /
`refs(src_rel_path, kind, target, resolved_rel_path NULL)`。`.hakushi/` は gitignore 済み。

### 5.4 pipeline.ts 追加 API（src/markdown/）

```ts
export interface PageRefs {
  links: { target: string; position?: unknown }[];   // 相対 .md リンク（外部 URL は除外）
  embeds: { target: string; mode: string }[];        // ::embed / :::embed の page 属性
}
export function extractRefs(tree: Root): PageRefs;
export function isFolderPage(tree: Root): boolean;    // 本文（yaml 除く）が embed のみ（空も false）
export function rewriteRefs(tree: Root, rewrite: (target: string, kind: "link" | "embed") => string | null): { tree: Root; changed: boolean };
export function renderPreviewHtml(md: string): string; // 埋め込みカード用の読み取り専用 HTML（mdast→hast→html、埋め込み directive は placeholder <div class="embed-ref" data-page data-mode> に）
```

### 5.5 移動/改名のリンク追従（TS オーケストレーション）

`src/app/page-ops.ts`:

```ts
export async function movePage(root: string, fromRel: string, toRel: string): Promise<void>;
// 1) index_backlinks で参照元を収集（ディレクトリ移動時は配下全ページぶん）
// 2) rename_path 実行
// 3) 参照元 + 移動されたページ自身の相対リンクを rewriteRefs で書換 →
//    normalize → writeFile（.md を書くのは常に pipeline 経由）
// 4) index を更新（変更ファイルを再スキャン）
// id は frontmatter に残るので id 参照は書換不要（それが id の存在理由）。
```

純ロジック（対象計算・書換マッピング）は fs 非依存の関数に分離し vitest でテストする。

### 5.6 埋め込み解決・循環ガード（src/editor/）

- 埋め込みカード（TipTap NodeView）は `page` 属性を index_lookup で解決し、
  タイトル + `renderPreviewHtml` による読み取り専用プレビューを描画。
  `mode="folder"` は子ページ（そのページのディレクトリ配下）をリンク一覧表示。
- クリックでそのページへ移動（EditorPane へ onNavigate(relPath) を prop 追加。
  App.tsx が currentFile を切替）。
- **循環ガード**: 解決チェーン（訪問済み relPath 集合）を NodeView へ伝搬し、
  再訪 or 深さ>3 で「循環embed」プレースホルダ表示。純関数として実装し単体テスト。

### 5.7 ブラウザ開発モック（dev 専用）

`src/app/tauri-mock.ts` — `window.__TAURI_INTERNALS__` が無い環境（vite 単体プレビュー）
では workspace.ts / page-ops が in-memory モック実装（サンプルページ数枚 + fake index +
no-op git）へフォールバックする。**UI フローをブラウザで E2E 検証するための開発装置**。
プロダクション（Tauri 内）挙動には一切影響しないこと。

## 6. M3 契約: エクスポート（1 mdast → HTML / Docx / PDF）

### 6.1 TS 側 (`src/export/`)

```ts
export type ExportFormat = "html" | "docx" | "pdf";
export interface ExportResult { fileName: string; mime: string; bytes: Uint8Array }

// resolve-embeds.ts — 出力前に埋め込みを解決した mdast を得る（純関数 + 注入 resolver）
export interface ResolvedRef { relPath: string; title: string | null }
export interface EmbedSource {
  resolve(target: string): Promise<ResolvedRef | null>;
  readBody(relPath: string): Promise<string>;          // frontmatter 抜き本文
  listChildren(relPath: string): Promise<ResolvedRef[]>; // folder モード用（非 folder は []）
}
export async function resolveEmbedsInTree(tree: Root, src: EmbedSource,
  opts?: { maxDepth?: number /*=3*/; chain?: readonly string[] /* 自己埋め込み検出用に出力対象ページ自身を渡す */ }): Promise<Root>;
// inline/preview → 対象ページ本文の mdast を差し込む（見出しレベルはそのまま、循環は「(循環参照: X)」段落に）
// folder → 子ページへのリンクのリスト（子なしは「(子ページなし)」段落）

// index.ts
export async function exportPage(root: string, relPath: string, format: ExportFormat,
  opts?: { includeSubtree?: boolean; pdfBackend?: PdfBackend /* テスト用差し替え */ }): Promise<ExportResult | null>;
// includeSubtree: folder-note のとき配下ページを見出し区切りで連結。
// html: 単一 self-contained HTML（インライン CSS、タイトルは frontmatter title→ファイル名）
// docx: mdast2docx（動的 import）
// pdf: ExportResult を返さず PdfBackend へ委譲して null を返す（下記）

// pdf.ts — PdfBackend trait（DESIGN.md）: デスクトップ = 生成した HTML を新規
// WebviewWindow（または window.open フォールバック）で開き window.print()。
// モバイルは M8 でベストエフォート。ブラウザモックでは window.open + print。
```

保存フロー: html/docx は `@tauri-apps/plugin-dialog` の save() でパスを取得し
`write_export_file` へ。ブラウザモックでは Blob ダウンロードにフォールバック。
必要 capability（`src-tauri/capabilities/default.json`）: `dialog:default`（save/open）
+ `core:webview:allow-create-webview-window`（PDF 印刷用 WebviewWindow 生成）。

### 6.2 Rust 追加コマンド

```rust
#[tauri::command]
fn write_export_file(path: String, bytes: Vec<u8>) -> Result<(), String>;
// save ダイアログ由来の絶対パス。親ディレクトリ必須（作成しない）。上書き可。
```

UI: EditorPane ツールバーに「エクスポート ▾」（HTML / Docx / PDF、folder-note では
「配下ページも含める」チェック）。

## 7. M4 契約: ローカル Git UI（履歴・意味的差分・branch・revert）

### 7.1 Rust コマンド追加（両バックエンド。gix 側で困難な操作は Unsupported + capabilities 正直申告）

```rust
#[tauri::command] fn git_branches(root: String) -> Result<BranchInfo, String>;
// BranchInfo { current: Option<String>, branches: Vec<String> }（unborn HEAD は current=None）
#[tauri::command] fn git_create_branch(root: String, name: String) -> Result<(), String>;
#[tauri::command] fn git_checkout_branch(root: String, name: String) -> Result<(), String>;
// ダーティなワークツリーではエラー（"commit or discard changes first" 相当メッセージ）
#[tauri::command] fn git_file_at_commit(root: String, rel_path: String, oid: String) -> Result<Option<String>, String>;
// そのコミット時点の blob 内容（存在しなければ None）
#[tauri::command] fn git_revert_file(root: String, rel_path: String, oid: String) -> Result<(), String>;
// blob バイトをワークツリーへ復元。**例外規定**: これは「git が自ら生成したバイトの復元」で
// あり、pipeline.ts 独占ルール（.md 生成）の対象外。新規バイト列を作らない。
```

### 7.2 意味的差分（TS 純関数, `src/git-ui/semantic-diff.ts`）

```ts
export type BlockChange =
  | { kind: "added"; block: string }          // block = 正規化済み md 断片
  | { kind: "removed"; block: string }
  | { kind: "modified"; before: string; after: string }
  | { kind: "task-toggled"; text: string; done: boolean }   // 同一テキストのチェック状態変化
  | { kind: "moved"; text: string; fromSection: string | null; toSection: string | null }; // 同一リスト項目の見出し間移動（Kanban のカード移動）
export function semanticDiff(beforeMd: string, afterMd: string): BlockChange[];
```

mdast のトップレベルブロック単位で LCS。リスト項目レベルの task-toggle / moved を
ブロック diff より優先して抽出する。frontmatter の変化は無視（設定変更は M5 以降で表示）。

### 7.3 UI (`src/git-ui/GitPanel.tsx` ほか)

右サイドパネル（App.tsx にトグル）: ①変更ファイル一覧 + コミットメッセージ入力 +
コミット、②現在ページの履歴（クリックで親コミットとの意味的差分 + 「この版に戻す」）、
③ブランチ選択/作成/切替。workspace.ts に invoke ラッパー、tauri-mock.ts に
in-memory 疑似 git（コミット列 + blob 保存）を追加してブラウザで動作すること。

## 8. CI ゲート

- `npm run typecheck` && `npm test`（roundtrip 冪等性 + エディタ忠実性コーパス）
- `cargo check`（default = git-libgit2）
- `cargo check --no-default-features --features git-gix`
- `cargo check --target aarch64-apple-ios --no-default-features --features git-gix`
- `cargo check --target aarch64-linux-android --no-default-features --features git-gix`

## 9. M5 契約: テンプレート（Todo/高度Todo/Kanban/Calendar）

### 9.1 バンドル/ユーザーテンプレート

- バンドルテンプレは vite の raw import（`import kanban from "../../templates/kanban.md?raw"`）
  で静的同梱（`src/templates-ui/bundled.ts` に一覧 {key, label, raw}）。
- ユーザーテンプレ = ワークスペース内 `templates/` ディレクトリの `.md`。
- 「テンプレートから新規」= raw を parse → frontmatter の `id` を新 ULID に差替、
  `title` を入力値に、`created` を今日に → stringify（pipeline 経由）→ createPage。
  `src/app/page-ops.ts` に `createPageFromTemplate(root, dirRel, title, templateRaw)` を追加。
- 「このページをテンプレとして保存」= EditorPane メニュー: 現ページを
  `templates/<name>.md` へ複製（id は残す。複製時に差し替えるため）。

### 9.2 リッチビュー（EditorPane 第3モード "view"）

frontmatter `template` が kanban / calendar / todo / todo-advanced のページでは
モード切替に「ビュー」タブが加わり、それぞれ専用ビューを表示する。

**共通規約: ビューの編集操作はすべて mdast 変換 → stringifyMarkdown → 保存**
（1操作 = 意味的最小差分。Kanban のカード移動は1行差分になること）。
変換は `src/templates-ui/<t>-model.ts` の**純関数**（parse 済み Root → Root）で実装し
vitest でバイトレベル検証。

- KanbanBoard: カラム = `## 見出し`（frontmatter kanban.columns の順序を優先、
  余剰見出しは後置）。カード = タスクリスト項目。操作: カード追加/完了トグル/
  カラム間移動（HTML5 DnD + ボタン両方）/カード削除。
- CalendarView: 本文最初の GFM テーブル（date,title,page,tag 列）を月グリッド表示。
  操作: 月移動、イベント追加（行 append）、イベントクリックで page 列があれば
  onNavigate。date は YYYY-MM-DD。
- TodoView (todo / todo-advanced): タスクを :due/:prio で並べ替え・グループ表示、
  チェックトグルのみ書き戻し。

### 9.3 UI 導線

- 「＋ 新規ページ」モーダルに「テンプレート」選択（なし/バンドル4種/ユーザーテンプレ列挙）。
- templates/ ディレクトリはツリーで通常表示（隠さない）。

## 10. M6 契約: コラボ層（Issue / PR / レビュー / マージ）

### 10.1 イベントログ（refs/hakushi/*、追記専用）

- Issue: `refs/hakushi/issues/<ulid>` → コミットチェーン。各イベント =
  空ツリーコミット、メッセージ = JSON 1行:
  `{"v":1,"type":"create|comment|close|reopen|label","ts":<epoch_sec>,"author":"<git user.name>","data":{...}}`
  - create: {title, body} / comment: {body} / label: {add:[], remove:[]}
- PR: `refs/hakushi/prs/<ulid>` 同形式:
  - create: {title, body, source, target}
  - review_comment: {anchor: {page: <page-id または relPath>, block: <number|null>}, body}
  - status: {state: "open"|"merged"|"closed"}
- 読出しはチェーンを親方向に走査し ts 昇順で返す。マージ（クローン間和集合）は M7。

### 10.2 GitBackend 拡張 + コマンド

```rust
// trait 追加実装: append_ref_event(root, ref_name, json) -> oid（親 = 現 ref 先端、空ツリー）
//                 read_ref_events(root, ref_name) -> Vec<String>（ts 昇順 JSON）
//                 list_refs(root, prefix) -> Vec<String>
//                 merge_branch(root, source) -> MergeOutcome
// MergeOutcome { kind: "fastForward"|"merged"|"conflicts", conflictPaths: Vec<String> }
// merge_branch: libgit2 実装（コンフリクト時は中断しワークツリーを汚さない）。gix は Unsupported。
#[tauri::command] fn collab_create_issue(root, title: String, body: String) -> Result<String, String>; // ulid
#[tauri::command] fn collab_issue_event(root, id: String, event_json: String) -> Result<(), String>;
#[tauri::command] fn collab_list_issues(root) -> Result<Vec<IssueSummary>, String>;
// IssueSummary { id, title, state, commentCount, updatedTs } — refs から都度マテリアライズ
#[tauri::command] fn collab_get_issue(root, id: String) -> Result<Vec<String>, String>; // event json列
#[tauri::command] fn collab_create_pr(root, title, body, source, target) -> Result<String, String>;
#[tauri::command] fn collab_pr_event(root, id, event_json) -> Result<(), String>;
#[tauri::command] fn collab_list_prs(root) -> Result<Vec<PrSummary>, String>;
// PrSummary { id, title, state, source, target, updatedTs }
#[tauri::command] fn collab_get_pr(root, id) -> Result<Vec<String>, String>;
#[tauri::command] fn git_merge_branch(root, source: String) -> Result<MergeOutcome, String>;
```

SQLite キャッシュは任意（都度走査で十分なら省略可、パフォーマンス課題が出たら導入）。

### 10.3 UI

右パネルをタブ化: Git | Issues | PRs。
- Issues: 一覧(state フィルタ)/新規(title+body)/詳細(コメント追記・close/reopen)。
- PRs: 新規(現ブランチ→main、title+body)/一覧/詳細: メタ +
  レビューコメント（ページ+ブロック anchor 選択は簡易: ページピッカー+任意ブロック番号）
  + マージボタン（capabilities.merge=false のバックエンドでは無効+理由表示。
  libgit2/mock は有効、gix は無効）。
  - **差分ページ一覧は未実装（M6 スコープ外に繰延）**: source↔target の
    ブランチ間 diff を返すコマンドが §10.2 に存在しないため。ブランチ間 diff
    コマンド（例: `git_diff_branches(root, source, target) -> Vec<String>`）を
    追加した時点で、意味的差分表示（§7）を再利用して PR 詳細に載せる。
- tauri-mock: in-memory issues/prs で全 UI フローがブラウザで動くこと。

## 11. M7 契約: リモート同期 + 共有

### 11.1 方針

- **1操作で全同期**: `git_sync` が fetch → コード branch 統合 → collab refs 和集合
  マージ → push（`+refs/heads/*` と `+refs/hakushi/*` の双方向 refspec）まで行う。
- **デスクトップ(libgit2)**: `https`(+vendored-openssl) を feature 有効化。file:// と
  https(PAT) をサポート。SSH は M7 では対象外（フォローアップ明記）。
- **モバイル(gix)**: `blocking-http-transport-reqwest-rust-tls`(rustls) の追加スパイク。
  **判定: 採用**（実装済み）。iOS/Android の cargo check 2 ゲートは緑を維持し、
  `cargo tree --target aarch64-linux-android`（git-gix 構成）に openssl/curl/git2/libgit2
  は入らない（純 Rust、ring/rustls のみ）。gix は **fetch-only** で配線: capabilities
  `pull=true`（fetch+ff 限定）/ `push=false`。push・checkout・merge は引き続き
  Unsupported（モバイルはデスクトップで clone 済みリポジトリを pull する運用）。
  詳細は M0-SPIKE-RESULTS.md §「M7 gix TLS spike」。
- **認証**: HTTPS PAT を `keyring` crate で OS キーチェーンへ（service "hakushi",
  account = ホスト名）。**トークンは TS 側へ絶対に返さない**（set/clear/has のみ）。

### 11.2 Rust コマンド

```rust
#[tauri::command] fn git_remote_get(root) -> Result<Option<String>, String>;    // origin URL
#[tauri::command] fn git_remote_set(root, url: String) -> Result<(), String>;   // origin を作成/更新
#[tauri::command] fn credential_set(host: String, token: String) -> Result<(), String>;
#[tauri::command] fn credential_clear(host: String) -> Result<(), String>;
#[tauri::command] fn credential_has(host: String) -> Result<bool, String>;
#[tauri::command] fn git_sync(root) -> Result<SyncReport, String>;
// SyncReport {
//   fetched: bool, pushed: bool,
//   branch: { kind: "upToDate"|"fastForward"|"merged"|"conflicts"|"noRemoteBranch", conflictPaths: Vec<String> },
//   collabRefs: { merged: u32, unchanged: u32 },   // 和集合マージした ref 数
//   message: String,                               // 人間可読サマリ
// }
// conflicts の場合: ワークツリーは事前状態のまま維持し、push はコード branch を
// スキップ（collab refs だけ push）。解決 UI は M8。
// dirty ワークツリーでは Err("commit or discard changes first ...")。
```

### 11.3 collab refs の和集合マージ（決定論的）

fetch した `refs/hakushi/<kind>/<id>` とローカルの同名 ref が分岐していた場合:
両チェーンの全イベントを収集 → `(type, ts, author, data)` の正規化 JSON で重複排除 →
`(ts, 正規化JSON)` 順にソート → **新しいチェーンをゼロから再構築**して ref を更新。
両側で同じ結果になる（順序・親も決定論的）ため、次回 push で収束する。
イベントは追記専用なので情報は失われない。cargo テスト必須:
bare リポジトリ + 2 クローンで Issue イベントを両側に追加 → 双方 sync → 同一チェーン。

### 11.4 静的 HTML 公開 (`src/export/site.ts`)

```ts
export async function exportSite(root: string): Promise<{ files: { relPath: string; content: string }[] }>;
// 全 .md ページ → M3 html エクスポータで各 HTML（埋め込み解決済み・相互リンクは
// .md → .html に書換）+ index.html（ツリーナビ付きトップ）。純関数部はテスト。
export async function publishSiteToFolder(root: string): Promise<string | null>;
// フォルダ選択ダイアログ → write_site_files で全ファイルを 1 IPC で書出し → 出力先パス返却
```

Rust コマンド（`src-tauri/src/fs_commands.rs`、lib.rs 登録済み）:

```rust
#[tauri::command] fn write_site_files(base_dir: String, files: Vec<SiteFile>) -> Result<u32, String>;
// SiteFile { rel_path: String, content: String }（#[serde(rename_all="camelCase")]、
//   TS からは { relPath, content }）。返り値は書き出したファイル数。
// base_dir は絶対 + 実在ディレクトリ。各 rel_path は fs_commands の既存規約で検証
//   （空/NUL/絶対/".."/"\"/":" を拒否）→ base_dir 外へは出ない。親ディレクトリは
//   作成し、上書きは許可。
```

### 11.5 UI

サイドバー ⋯ メニューに「同期設定…」（リモート URL + PAT 保存/削除、credential_has
表示）と「今すぐ同期」(SyncReport をトースト/パネルで表示)、「静的サイトを書き出す…」。
tauri-mock: リモートなし想定の疑似 sync（"リモート未設定" エラー経路と成功経路）。

## 12. M8 契約: コンフリクト解決 UX / レスポンシブ / PDF / 自動同期

### 12.1 Rust: コンフリクト素材の提供と解決（`src-tauri/src/git/`）

```rust
#[tauri::command]
fn git_conflict_versions(root: String, source: String) -> Result<Vec<ConflictFile>, String>;
// ConflictFile { relPath: String, base: Option<String>, ours: String, theirs: String }
// current branch(ours) と source(theirs) を in-memory merge（libgit2 merge_commits/
// merge_trees）で再実行し、コンフリクトした各パスの 3 バージョン(base = merge-base、
// 存在しなければ None)を返す。ワークツリーには一切触れない。コンフリクトが無ければ空 Vec。

#[tauri::command]
fn git_merge_resolve(root: String, source: String, resolved: Vec<ResolvedFile>)
    -> Result<String, String>;   // merge commit の oid
// ResolvedFile { relPath: String, content: String }
// in-memory merge の index に resolved の blob を差し込み、残コンフリクトゼロを確認して
// 2 親 merge commit を作成、HEAD を進め、ワークツリーへ checkout。resolved に無い
// コンフリクトが残れば Err(部分解決不可・全ファイル必須)。ダーティ拒否は既存 merge と同じ。
```

- gix は両方 Unsupported(merge が libgit2 限定のため一貫)。capabilities に反映済み。
- `source` は次を受理する(libgit2 `merge_endpoints`): ① sentinel `"__sync__"`
  (= `SYNC_CONFLICT_SOURCE`。`origin/<現ブランチ>` に解決。sync 由来のコンフリクトは
  リモート追跡ブランチとの merge なので、名前付き local branch を持たない)/ ② local
  branch 名(PR マージ経路)/ ③ 解決可能な revspec / リモート追跡 ref(`origin/main` 等)。
  TS 側は `workspace.ts` の `SYNC_CONFLICT_SOURCE`、mock は同値リテラルで一致。

### 12.2 TS: 意味的 3-way マージエンジン（`src/git-ui/semantic-merge.ts`、純関数）

```ts
export type MergeBlock =
  | { kind: "auto"; md: string }
  | { kind: "conflict"; base: string | null; ours: string; theirs: string };
export interface MergeResult { blocks: MergeBlock[]; autoMerged: boolean }
export function semanticMerge3(baseMd: string, oursMd: string, theirsMd: string): MergeResult;
```

- base を軸に ours/theirs をブロック整列（M4 の semantic-diff の LCS を再利用）。
  - 片側だけ変更 → その側採用(auto) / 両側同一変更 → 採用(auto)
  - 両側で異なる変更・片方削除+片方変更 → conflict ブロック
  - リストは**トップレベル項目単位**で整列（別項目編集はブロック全体を conflict にしない）
  - frontmatter はキー単位でマージ（id 不変、title/updated 等の非衝突は新 ts 側 auto、
    template/kanban 設定の衝突のみ conflict）
- 迷ったら conflict に倒す（自動マージの誤りはデータ破壊、conflict 過多は UX 低下で済む）。
- 出力（連結後）は常に canonical: `resolve` 時に normalizeMarkdown を通す。純関数のみで
  fs 非依存、vitest 網羅（非重複自動 / 同一ブロック衝突 / タスク別項目 auto / kanban
  カード移動+別カード追加 auto / canonical 冪等）。

### 12.3 UI: `src/git-ui/ConflictResolver.tsx`

- sync / merge が `conflicts` を返したら全画面モーダルで起動。ファイルごとに
  semanticMerge3 の結果を上から表示。auto は畳んだプレビュー、conflict はカードで
  「**あなたの変更** / **相手の変更**」を並べ「どちらを残す」「両方残す（自分→相手）」
  の3択。**ours/theirs/HEAD 等の専門用語を出さない。**
- 全ファイル解決 → 各 blocks 連結 → normalizeMarkdown → joinFrontmatter →
  `git_merge_resolve` → 成功後 sync を自動再開（push まで）。中断はいつでも可
  （ワークツリー無傷）。tauri-mock に疑似 conflicts シナリオを用意しブラウザで全 UI 検証。

### 12.4 レスポンシブ / タッチ（`max-width: 768px`）

- サイドバー → ドロワー（ハンバーガー開閉 + オーバーレイ）。右パネル → 全画面シート。
- タップ領域 ≥44px、モーダル幅 90vw。
- Kanban: Pointer Events による自前タッチドラッグ（長押し 200ms → ghost 追従）。
  **既存の ←/→ ボタンを常にフォールバックとして残す**（progressive enhancement）。
- 検証: preview のモバイルビューポート(375×812)で主要フロー破綻なし。

### 12.5 capability 文言の統一

- `git_backend_info` を起動時に 1 回取得し Context で配布。gix(モバイル)で false に
  なる機能(checkout / merge / push)の UI 文言を非エンジニア向けに統一
  （例: 「この端末ではブランチ切替は未対応です。PC 版をご利用ください」）。

### 12.6 PDF 改修 + 自動同期 + 仕上げ（実装済み）

**PDF**（`src/export/pdf.ts`、`WebviewPrintBackend`）:
- `data:` URL をやめ、**一時ファイル(file://)を WebviewWindow で開く**方式に変更。
  そのための Rust コマンドを追加（`src-tauri/src/fs_commands.rs`、lib.rs 登録済み）:
  ```rust
  #[tauri::command] fn write_temp_file(app: AppHandle, name: String, content: String)
      -> Result<String, String>;
  // app_cache_dir()/pdf-preview/<sanitized name> に content を書き、絶対パスを返す。
  // name は file_name() で 1 コンポーネントに正規化（トラバーサル不可）。
  ```
  TS は絶対パスを `file://` URL 化して `new WebviewWindow(...)` で開き、
  `win.once("tauri://error", …)`（WebviewWindow 生成は非同期＝try/catch 不可）で
  失敗を捕捉し `window.open` フォールバック。ブラウザモックは `window.open`。
- モバイル（`isMobilePlatform()`、UA 判定）: `window.print()` ベストエフォート +
  エディタツールバーの「HTMLを書き出して共有」（`saveExport` 経由）フォールバック。

**エクスポート暗黙保存失敗**（`src/editor/EditorPane.tsx`）: `EditorPane.save()` は
`Promise<boolean>` を返すよう変更（true=書込成功）。export / save-as-template は
`save()` が false なら**中止してメニュー側にエラー表示**（stale なディスク内容を出さない）。

**自動同期**（`src/app/autosync.ts` + `AutoSyncSettings.tsx`）:
- 設定は `.hakushi/config.json`（gitignore 済み領域）に保存。専用 Rust コマンドは追加せず、
  既存の `read_text_file` / `write_text_file` を `.hakushi/config.json` rel_path で利用
  （ドット始まりは fs_commands のパス検証を通過し、list_tree では非表示）。
- 形: `autoSync {onLaunch: bool, intervalMin: number|null, afterCommit: bool}`。
  既定 onLaunch=true / intervalMin=null / afterCommit=**true**。
  afterCommit の既定が true なのは、「コミット = 記録」「同期 = 共有」の分離が
  利用者に伝わらず「コミットしたのに GitHub に反映されない」と読まれるため。
  afterCommit の同期は**手動同期と同じ UI 経路**で実行し、結果（成功／トークン
  未入力エラー）を必ずステータス行に表示する（無言スキップにしない）。
  オフにしたい場合は同期設定で明示的に無効化する。
- `startAutoSync(root, config, onResult)`: 起動時同期（remote 設定済み + クリーン時のみ）
  + intervalMin 設定時のみ**単一** `setInterval`（ビジーポーリングなし）。dirty は
  スキップ（自動コミットしない）。純関数（parseConfig / mergeConfig /
  shouldAutoSyncOnLaunch）は vitest 済み。
- App.tsx はコントローラを 1 個保持し、conflicts はサイドバーのバッジ（state のみ、
  モーダルは自動で開かない）。

**仕上げ**: vite `build.rollupOptions.output.manualChunks` で tiptap / prosemirror /
codemirror(core) / markdown / react の各ベンダーを分離（500kB 警告解消）。
plugin-dialog は全箇所を静的 import に統一（動的/静的混在の警告解消）。
GitBackend の未使用 trait 既定メソッド（current_branch / diff / push / pull / fetch /
clone_repo）は `#[allow(dead_code)]` + 理由コメントで沈黙化。
README・CLAUDE.md・DESIGN.md（末尾ステータス）を最終更新。
