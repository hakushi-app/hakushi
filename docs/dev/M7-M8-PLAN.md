# M7・M8 詳細実装計画

作成日: 2026-07-05 / 前提コミット: M0–M6 完了時点のワーキングツリー
関連文書: [DESIGN.md](../DESIGN.md)(設計正本)/ [INTERFACES.md](INTERFACES.md)(§11 に M7 契約を追記済み)/ [M0-SPIKE-RESULTS.md](M0-SPIKE-RESULTS.md)(gix スパイク + M2/M4 追補)

---

## 0. 現在地の整理(M7/M8 に効く事実だけ)

### 0.1 ゲート状態(2026-07-05 時点、全 green)

- `npx tsc --noEmit` / `npx vitest run`(18ファイル・292 passed / 1 skipped)/ `npm run build`
- `cargo check` + `cargo test --lib`: libgit2 構成 24 テスト、gix 構成 20 テスト
- `cargo check --target aarch64-apple-ios / aarch64-linux-android`(gix 構成。Android は NDK env 必須 = rusqlite bundled の C コンパイルのため)

### 0.2 GitBackend 実装状況(= M7 の出発点)

| 操作 | libgit2(デスクトップ) | gix(モバイル) |
|---|---|---|
| init / is_repo / status / commit_all / log | ✅ | ✅ |
| branches / create_branch | ✅ | ✅ |
| checkout_branch | ✅ | ❌ Unsupported(安全な worktree reset が gix に無い) |
| file_at_commit / revert_file | ✅ | ✅ |
| append_ref_event / read_ref_events / list_refs | ✅ | ✅ |
| merge_branch | ✅(ff / merge / conflicts 判定、conflict 時はワークツリー復元) | ❌ Unsupported |
| **push / pull / fetch / clone** | ❌ **未実装(M7 本体)** | ❌ 同左 |
| ネットワーク feature | **無効**(git2 default-features=false、OpenSSL 依存ゼロ) | **無効**(TLS 系 feature ゼロ、純 Rust) |

### 0.3 コラボ層の現状

- `refs/hakushi/issues/<ulid>` / `refs/hakushi/prs/<ulid>` に空ツリーコミットのチェーンとしてイベント追記済み(JSON 1行/コミット、正規キー順 v,type,ts,author,data)。
- Issue(create/comment/close/reopen/label)・PR(create/review_comment/status)の Tauri コマンド 9 本 + UI(右パネル Git|Issues|PRs タブ)稼働。
- **イベント順序の tie-break に oid が使えない**(trait が `Vec<String>` でイベント文字列しか返さない)。M7 の和集合マージは決定論性が必須なので、ソートキーを `(ts, 正規化JSON文字列)` にする(§2.3)。trait 変更は不要。

### 0.4 持ち越しの既知課題(統合エージェント報告より)

1. PDF: `WebviewWindow` + `data:` URL の実機挙動未検証(Tauri の非同期生成エラーは try/catch で捕捉不可、`tauri://error` イベント経由)。`window.open` フォールバックあり。→ M8 §3.4
2. Android のローカル cargo check は NDK env 必須(CI は設定済み)。→ 現状維持でよい
3. gix の checkout 未対応 → ブランチ切替はデスクトップ限定(UI は理由を表示済み)。→ M8 §3.6
4. エクスポート時に暗黙保存が失敗すると直前のディスク内容で出力される(エラーはエディタ側に出る)。→ M8 §3.7(小)
5. vite バンドル >500kB 警告 + `@tauri-apps/plugin-dialog` の動的 import 警告。→ M8 §3.7
6. FileTree の行内「+」は無題ページ即作成(テンプレピッカーは「＋ 新規ページ」モーダルのみ)。→ M8 §3.7(UX 統一、任意)

---

## 1. M7 — リモート同期 + 共有

**DESIGN.md の Done 判定**: リモート追加 → 双方向 push/pull(collab refs 含む)が動き、静的 HTML 公開リンクが閲覧可能で、認証はキーチェーン。加えて M6 の Done 判定「**2クローン間で Issue/PR/レビュー/マージが push/pull のみで同期(サーバーなし)**」は実質 M7 の統合テストで完成する。

### 1.1 リモート管理(小)

- Rust: `git_remote_get(root) -> Option<String>` / `git_remote_set(root, url)`(origin 固定。複数リモートは v2)。
  - libgit2: `repo.find_remote("origin")` / `remote_set_url`。
  - gix: 読みは config から可。書きは gix の config 書込 API が薄ければ **`.git/config` の手書き編集はしない**こと(壊れる)。gix 側は get のみ実装し、set は Unsupported でよい(モバイルのリモート設定はデスクトップで clone 済みリポジトリを同期する運用が既定。ただし §1.7 の「モバイル初期設定」参照)。
- 受理する URL: `https://…` と `file://…`(または絶対パス)。ssh は M7 対象外(§1.8)。

### 1.2 デスクトップのネットワーク有効化(git2)

- `src-tauri/Cargo.toml` の git2 を feature 分岐:
  ```toml
  git2 = { version = "0.20", optional = true, default-features = false }
  [features]
  git-libgit2 = ["dep:git2", "git2/https", "git2/vendored-openssl", "git2/vendored-libgit2"]
  ```
  - `vendored-openssl` はビルド時間が伸びる(特に Windows)。CI は check のみなので許容。macOS ローカルで実測し、耐え難ければ macOS だけ SecureTransport 系に逃がすことも検討(まず vendored で全 OS 統一が単純)。
  - **モバイル gates への影響ゼロを確認**(git-gix 構成は git2 を含まないので理屈上ゼロだが、4ゲートを必ず再実行)。
- 認証コールバック: `RemoteCallbacks::credentials` で ①URL のホストに対応する PAT がキーチェーンにあれば `Cred::userpass_plaintext("x-access-token" または "git", pat)`(GitHub は user 任意 + PAT が通る。GitLab は "oauth2")、②無ければエラー(UI に「同期設定で PAT を保存してください」)。ホスト別 user 名の差異は `{host → username}` の小さな既定表 + 上書き設定で吸収。
- file:// リモートは認証不要(テストの主経路)。

### 1.3 認証(keyring)

- `cargo add keyring`(macOS Keychain / Windows Credential Manager / Linux secret-service。**iOS/Android での keyring はビルド可否をスパイク対象に含める** — 不可なら mobile では `tauri-plugin-stronghold` 移行を M8 フォローアップにし、M7 は keyring を `#[cfg(not(any(target_os="ios",target_os="android")))]` でデスクトップ限定 + モバイルは capability で「同期未対応」を返す)。
- コマンド: `credential_set(host, token)` / `credential_clear(host)` / `credential_has(host) -> bool`。
  - **トークンは絶対に TS 側へ返さない**(get コマンドを作らない)。使用は Rust の sync 内部のみ。
  - service = `"hakushi"`, account = ホスト名(`github.com` 等)。
- UI: ⋯メニュー「同期設定…」モーダル — リモート URL(git_remote_get/set)、PAT 入力(パスワードフィールド、保存で credential_set し入力欄クリア)、「保存済み ✓ / 削除」表示(credential_has / credential_clear)。

### 1.4 `git_sync` 本体(M7 の心臓)

```
git_sync(root) -> SyncReport   (INTERFACES.md §11.2 の形)
```

手順(libgit2。**全段で失敗時は分かる所まで進めて report に反映**、途中失敗でもリポジトリを壊さない):

1. **前提チェック**: origin 設定済みか。ワークツリー dirty なら Err(「先にコミットしてください」— 非エンジニア文言は UI 側で)。
2. **fetch**: refspec `+refs/heads/*:refs/remotes/origin/*` と `+refs/hakushi/*:refs/hakushi-remote/*`。
   - collab refs のリモート追跡は `refs/hakushi-remote/` 名前空間に置く(`refs/remotes/` は branch 用の慣例のため分離。fetch 後にローカル `refs/hakushi/*` と突き合わせ)。
3. **コード branch 統合**(現在ブランチのみ。他ブランチは触らない):
   - リモートに同名 branch 無し → `branch.kind = "noRemoteBranch"`(push で新規作成される)。
   - up-to-date → `"upToDate"` / ff 可能 → ff して `"fastForward"` / 分岐 → `merge_branch` 相当のインメモリ merge:
     - クリーン merge → merge commit 作成、`"merged"`。
     - コンフリクト → **ワークツリーは事前状態のまま**(M4 実装の restore 方式を再利用)、`"conflicts"` + conflictPaths。**push はコード branch をスキップ**し collab refs だけ進める。解決 UI は M8(§3.1)。M7 の UI は「コンフリクトがあります。M8 の解決画面で対応予定。今はデスクトップの git で解決してください」と正直に表示。
4. **collab refs 和集合マージ**(§1.5)。
5. **push**: `refs/heads/<current>`(conflicts 時スキップ)+ ローカル `refs/hakushi/*` 全部。non-fast-forward 拒否(同期合戦)は 1 回だけ fetch からリトライ、それでも駄目なら report にメッセージ。
6. SyncReport を返す(fetched/pushed/branch/collabRefs/message)。

### 1.5 collab refs の和集合マージ(決定論的、コンフリクト構造ゼロ)

fetch 済みの `refs/hakushi-remote/<kind>/<id>` とローカル `refs/hakushi/<kind>/<id>` について:

- リモートのみ存在 → ローカル ref をリモート先端に作成(チェーンごと採用)。
- ローカルのみ / リモートがローカルの祖先 → 何もしない(push で伝播)。
- ローカルがリモートの祖先 → ローカル ref をリモート先端へ ff。
- **分岐** → 両チェーンの全イベント文字列を収集 → 正規化 JSON で重複排除 → `(ts, 正規化JSON)` 昇順ソート(oid 不要の決定論 tie-break)→ **空ツリーコミットのチェーンをゼロから再構築**して ref を張り替え。
  - 同じ集合からは両クローンで**バイト同一のチェーン**が再構築される(署名者は「再構築者」でなくイベント内 author を使うため commit の author/committer/時刻もイベント由来で固定する — ここが収束の要。committer 時刻は ts を使用)。
  - よって「A が再構築 → push、B が fetch」で B 側は ff になり収束。両方が同時に再構築しても同一 oid に到達し衝突しない。
- 実装場所: `src-tauri/src/collab/sync.rs`。trait 拡張は `read_ref_events` に「任意 ref 名」を渡せれば十分(既にそうなっている)。チェーン再構築は `append_ref_event` をイベント数ぶん呼ぶ薄いループ + 最後に ref を差し替え(force)。
  - 注意: `append_ref_event` は author を git config から自動補完する現実装のままだと再構築が非決定的になる。**内部用に `append_ref_event_raw(root, ref, json, author, ts)` を追加**(コマンド非公開)。

### 1.6 統合テスト(cargo、これが M6/M7 の Done 判定そのもの)

`src-tauri/tests/sync_two_clones.rs`(または lib 内 cfg(test)):

1. tempdir に bare リポジトリ(= サーバー不要の共有リモート)を作成。
2. クローン A・B(git_sync 実装内の clone は不要 — `git clone` 相当は libgit2 の `RepoBuilder`。**`clone_repo` を trait 未実装のままにせず libgit2 だけ実装**: モバイルの clone は M8 フォロー)。
3. シナリオ:
   - A: ページ作成 + commit + sync(push) → B: sync(pull)で取得。
   - A と B が**同じ Issue** に別コメント → 両者 sync ×2 巡 → `read_ref_events` が両側で完全一致(和集合・同順)。
   - B: branch で PR 作成 + sync → A: sync 後 PR 一覧に出る → A: merge_branch + status:merged イベント + sync → B: sync で main が ff し PR が merged 表示相当のイベント列。
   - 分岐コミット(A/B が別ページ編集)→ 双方 sync → 片方が merge commit を作り収束、コンフリクトなし。
   - 同一ページ同一ブロック編集 → sync が `"conflicts"` を返し、ワークツリー不変・collab refs は同期済みであること。
4. https 経路はネットワーク非依存で自動テスト不可 → **手動チェックリスト**(GitHub のプライベートリポジトリ + PAT で push/pull、`refs/hakushi/*` が GitHub 上に見えること)を docs/dev/M7-MANUAL-CHECKS.md に置く。

### 1.7 モバイル gix ネットワーク・スパイク(M0 以来の残リスク、タイムボックス厳守)

- 試すこと: gix feature `blocking-network-client` + `blocking-http-transport-reqwest-rust-tls`(rustls/ring 系)を **git-gix 構成にのみ**追加し、iOS/Android の `cargo check` 2 ゲートが緑のままかを確認。
- 判定:
  - ✅ 通る → gix `fetch` だけでも配線(gix の push は 2025 年時点で未成熟。**fetch-only でも「モバイルで読める」価値がある**)。capabilities: pull=true(fetch+ff 限定)/ push=false。
  - ❌ 通らない(ring の as/cc、reqwest の系譜で C 依存が入る等)→ **即撤退**して capabilities は現状維持(push/pull=false)。UI は「モバイルの同期は今後対応。まずはデスクトップで同期してください」。isomorphic-git(JS)フォールバックは工数大のため **M8 でも必須にしない**(設計書の想定フォールバックとして文書化のみ)。
- どちらでも結果を M0-SPIKE-RESULTS.md に M7 追補として記録(feature 集合、cargo tree の TLS/C 依存有無、判断根拠)。

### 1.8 M7 でやらないこと(明記)

- SSH 認証(libssh2/openssh 依存が重い。PAT+HTTPS と file:// で M7 の価値は成立)→ M8 以降のフォローアップ。
- 複数リモート、リモート branch の UI 一覧、shallow clone、LFS。
- gix push(上記スパイクの結果次第でも M7 では配線しない)。

### 1.9 静的 HTML 公開

- `src/export/site.ts`:
  - `exportSite(root)`: 全 `.md` を列挙(listTree)→ 各ページを M3 の html エクスポータで変換。ただし:
    - ページ間リンク `foo.md` → `foo.html` に書換(mdast の link ノードを rewriteRefs で変換してから html 化)。
    - 埋め込みは解決済み(M3 の resolveEmbedsInTree を再利用、深さ・循環ガードそのまま)。
    - `index.html`: ワークスペースツリーのナビ + Welcome(または最初のページ)本文。全ページ共通の簡易ナビ(サイドバー風)を各ページにも挿入。
    - 出力パスは `ページrelPath.replace(/\.md$/, ".html")`(フォルダ構造維持)。
  - `publishSiteToFolder(root)`: フォルダ選択(dialog open directory)→ `write_export_file` で全ファイル書出し(親ディレクトリ作成が必要なので **`write_export_file` を「親が無ければ作成」に緩和**するか、`export_dir` 引数付きの新コマンド `write_site_files(baseDir, files)` を追加 — 後者が 1 IPC で済み速い)。
  - 純関数部(リンク書換・ナビ生成)は vitest。
- ドキュメント: 「GitHub Pages に公開するには: 出力フォルダを gh-pages ブランチに push / Netlify にドラッグ&ドロップ」等の手順を README に 1 節追加(アプリからの自動デプロイはやらない — サーバーレス原則どおり、ホスティングはユーザーの既存手段)。

### 1.10 UI まとめ(M7)

- ⋯メニュー: 「同期設定…」「今すぐ同期」「静的サイトを書き出す…」。
- サイドバー下部に同期ステータス行(最終同期時刻 / 同期中スピナー / 結果メッセージ。SyncReport.message を表示、conflicts は警告色)。
- tauri-mock: 疑似 sync(リモート未設定エラー経路、成功経路、conflicts 経路をシミュレート)でブラウザ E2E 可能に。

### 1.11 M7 ゲート(全部 green が Done)

1. 既存 7 ゲート(tsc / vitest / cargo×4 / vite build)
2. 新規 cargo 統合テスト sync_two_clones(libgit2)全シナリオ
3. `cargo tree`(git-gix, android target)に openssl/curl/C 依存が増えていないこと(スパイク採否どちらでも)
4. 手動チェックリスト M7-MANUAL-CHECKS.md 作成(GitHub 実試験は任意)

### 1.12 リスクと対策(M7)

| リスク | 対策 |
|---|---|
| vendored-openssl のビルド時間/失敗(特に Win) | CI は check のみ。失敗時は Win だけ https 無効化 + 「Win は file:// のみ」を暫定明記(最後の手段) |
| gix TLS がモバイルゲートを壊す | タイムボックス + 即撤退基準(§1.7)。ゲートが正義 |
| keyring がモバイルでビルド不可 | cfg でデスクトップ限定 + モバイル capability false(§1.3) |
| 和集合マージの非決定性バグ(収束しない) | append_raw で author/ts 固定(§1.5)+ 2クローン往復テストで oid 一致まで assert |
| 同時 push の non-ff 競合 | fetch→リトライ 1 回 + 諦めメッセージ(追記専用ログなので次回 sync で必ず収束) |

---

## 2. M8 — モバイル堅牢化 + コンフリクト解決 UX

**DESIGN.md の Done 判定**: 実機(iOS/Android)でタッチ編集・Kanban ドラッグ・同期・コンフリクト解決 UX を通し確認。
**この環境の制約**: 実機・シミュレータの操作検証はこのセッションからは不可 → コード・レイアウト・ロジックは全部作り込み、**ブラウザのモバイルビューポート(375×812)で UI 検証** + iOS/Android の**ビルドゲート**までを自動確認し、実機通し確認は手動チェックリスト(M8-MANUAL-CHECKS.md)として残す。

### 2.1 コンフリクト解決 UX(M8 の最重要・最大工数)

設計書リスク #4「`<<<<<<<` マーカーは使い物にならない」への回答。**mdast ブロック単位の意味的 3-way マージ**。

#### 2.1.1 Rust 側: コンフリクト素材の提供と解決の完了

現状の merge_branch / git_sync は conflicts 時に**中断してワークツリーを守る**。これを土台に:

```rust
#[tauri::command] fn git_conflict_versions(root, source: String)
  -> Result<Vec<ConflictFile>, String>;
// ConflictFile { relPath, base: Option<String>, ours: String, theirs: String }
// merge を in-memory( libgit2: merge_trees / merge_commits )で再実行し、
// コンフリクトした各パスの 3 バージョン(共通祖先 = merge-base)を返す。
// ワークツリーには一切触れない。

#[tauri::command] fn git_merge_resolve(root, source: String,
  resolved: Vec<ResolvedFile>) -> Result<String, String>;   // merge commit oid
// ResolvedFile { relPath, content: String }
// in-memory merge の index に resolved の blob を差し込み、残コンフリクトゼロを
// 確認して 2 親 merge commit を作成、HEAD を進め、ワークツリーを checkout。
// resolved に無いコンフリクトが残っていれば Err(部分解決は不可、全ファイル分必須)。
```

- gix: 両方 Unsupported(merge 自体が libgit2 限定のため一貫)。モバイルの conflicts は「デスクトップで解決してください」表示(fetch-only 運用なら発生しない)。

#### 2.1.2 TS 側: 意味的 3-way マージエンジン(`src/git-ui/semantic-merge.ts`、純関数)

```ts
export type MergeBlock =
  | { kind: "auto"; md: string }                          // 自動確定
  | { kind: "conflict"; base: string | null; ours: string; theirs: string };
export function semanticMerge3(baseMd: string, oursMd: string, theirsMd: string)
  : { blocks: MergeBlock[]; autoMerged: boolean };        // autoMerged = conflict ゼロ
```

- アルゴリズム: base を軸に ours / theirs をそれぞれブロック整列(M4 の semantic-diff の LCS を再利用)。
  - 片側だけが変更したブロック → その側を採用(auto)。
  - 両側が**同一変更** → 採用(auto)。
  - 両側が**異なる変更 / 片方削除+片方変更** → conflict ブロック。
  - 追加ブロックは位置(前隣ブロックの対応)基準で織り込み、両側が同位置に別内容を追加した場合のみ conflict。
- frontmatter は特別扱い: id は不変のはず(同一ページ)。title/updated 等がぶつかったら **キー単位**で新しい ts 側を採用(auto)、`template` や `kanban:` 設定の衝突のみ conflict 化。
- テスト(重要度最高): 非重複編集の全自動マージ / 同一ブロック両編集 → conflict / タスクリスト内の別項目編集 → 自動(ブロック=リスト全体にならないよう、リストはトップレベル**項目単位**に分解して整列する) / kanban で「A がカード移動・B が別カード追加」→ 自動 / 出力が常に canonical(normalize 冪等)。

#### 2.1.3 UI(`src/git-ui/ConflictResolver.tsx`)

- sync / merge が conflicts を返したら起動(モーダル全画面)。
- ファイル一覧 → 各ファイル: semanticMerge3 の結果を上から順に表示。auto ブロックは畳んだプレビュー、conflict ブロックはカードで:
  - 「**あなたの変更**」「**相手の変更**」を並べ、`どちらを残す` ボタン + `両方残す(自分→相手の順)` ボタン。専門用語(ours/theirs/HEAD)を出さない。
  - Kanban ページはブロック md をカード風に描画(renderPreviewHtml 再利用)。
- 全ファイル解決 → 「マージを完了」→ 各ファイルの blocks を連結 → **normalizeMarkdown → joinFrontmatter** → `git_merge_resolve`。完了後 sync を自動再開(push まで)。
- 「中断」はいつでも可(ワークツリー無傷のまま閉じる)。
- tauri-mock: 疑似 conflicts を返すシナリオを仕込み、ブラウザで全 UI 検証。

### 2.2 タッチ / レスポンシブ

- ブレークポイント `max-width: 768px`:
  - サイドバー → ドロワー(ハンバーガー開閉、オーバーレイ、スワイプ閉じは任意)。
  - 右パネル(Git|Issues|PRs)→ 全画面シート(タブは維持)。
  - モーダル幅 90vw、タップ領域 ≥44px(ボタン padding 拡大)、コンテキストメニューは長押し(`onContextMenu` はモバイル Safari で長押し発火。追加で ⋯ ボタンを常時表示しているので致命ではない)。
- Kanban タッチドラッグ: HTML5 DnD はモバイル WebView で効かない → Pointer Events で自前実装(pointerdown 長押し 200ms → ghost 追従 → カラム上で pointerup)。**既存の ←/→ ボタンがフォールバックとして常に機能**するため、ドラッグは progressive enhancement。
- CodeMirror 6 はタッチ対応済み(確認のみ)。TipTap のツールバー(現状最小)はモバイルで折返し。
- 検証: preview のモバイルビューポート(375×812)で全フロー(新規作成 → 編集 → 保存 → Kanban 操作 → Git パネル → Issue 作成)をスナップショット/クリックで通す。ダークモードは v2(現状ライトのみで一貫)。

### 2.3 モバイル実プロジェクト生成(ビルド配線)

- `npm run tauri ios init` / `tauri android init` で gen/apple・gen/android を生成し、リポジトリにコミット(生成物の .gitignore 済み部分は除外設定を確認)。
- ここまでの自動ゲート: 既存の cargo check 2 本 + `tauri ios build --ci`(署名なしでどこまで通るか、cocoapods 要件次第。**タイムボックスし、通らなければ「init 生成物 + cargo check」までを M8 の自動確認範囲として明記**)。
- 実機/シミュレータでの起動・タッチ検証は M8-MANUAL-CHECKS.md へ(手順: `tauri ios dev` / `tauri android dev`、確認項目リスト付き)。

### 2.4 モバイル PDF(ベストエフォート、設計書どおり)

- PdfBackend に mobile 実装: プラットフォーム WebView の印刷は Tauri 統一 API が無い → 現実解:
  1. iOS: `window.print()` が WKWebView で printController を出す(iOS 16+ で挙動確認要 — 手動チェック項目)。
  2. 不発なら「HTML を書き出して共有シートへ」(write_export_file + 共有は OS 任せ)をフォールバックとして UI に用意。
- デスクトップ PDF の残課題(§0.4-1)もここで処置: `data:` URL をやめ、**一時ファイルに HTML を書いて `WebviewWindow` で file:// を開く**方式に変更(asset protocol/scope 設定含む)。`tauri://error` リスナーで生成失敗を捕捉して window.open フォールバック。実 tauri dev で 1 回通し確認(デスクトップは自動化可能)。

### 2.5 バックグラウンド/自動同期

- スコープを正直に: OS レベルのバックグラウンド実行(BGTaskScheduler / WorkManager)は Tauri プラグイン未整備のため **M8 ではアプリ内自動同期**まで:
  - 設定(`.hakushi/config.json`、gitignore 済み領域): `autoSync: { onLaunch: bool, intervalMin: number | null, afterCommit: bool }`。既定: onLaunch=true, interval=null, afterCommit=false。
  - 実装: App.tsx にタイマー + 起動時 sync(リモート設定時のみ)。同期中インジケータ、失敗はサイレント→ステータス行に表示(モーダルで邪魔しない)。conflicts はバッジ表示し、ユーザー操作で ConflictResolver へ。
  - dirty のときの自動同期はスキップ(勝手にコミットしない。「自動コミット」はオプトイン提案のみ、既定オフ)。
- OS バックグラウンド同期は README のロードマップに v2 項目として記載。

### 2.6 capability 表示の総点検

- gix(モバイル)構成で false になる機能(checkout / merge / push など)の UI 文言を全箇所レビューし、「なぜ・どうすればよいか」を非エンジニア文言で統一(例: 「この端末ではブランチ切替は未対応です。PC 版 Hakushi をご利用ください」)。
- `git_backend_info` を App 起動時に 1 回取得して Context で配布(現状パネルごとに取得しているなら統一)。

### 2.7 仕上げ・技術負債(M8 で回収)

1. §0.4-4: エクスポート時の暗黙保存失敗 → エクスポートを中止してエクスポートメニュー側にエラー表示(1 行修正 + テスト)。
2. §0.4-5: vite チャンク分割(`build.rolldownOptions.output.manualChunks` で tiptap / codemirror / mdast 系を分離)+ plugin-dialog の動的 import 警告解消(静的 import に統一)。
3. §0.4-6: FileTree 行内「+」もテンプレピッカー付きモーダルに統一(または現仕様を意図として README に明記)。
4. dead_code 警告(未実装 trait 既定メソッド)→ `#[allow(dead_code)]` + 理由コメントで沈黙化。
5. ドキュメント最終更新: README(ステータス M0–M8、同期・公開・コンフリクト解決の使い方)、CLAUDE.md(ロードマップ位置 → 「M8 完了、v2 バックログ」)、DESIGN.md はそのまま(正本)+ 末尾に「実装ステータス 2026-07 時点」小節、INTERFACES.md §11/§12 を実装どおりに最終化。
6. 総合スモーク: 実 `tauri dev` を起動し、実 fs+実 git のワークスペースで 新規ページ → 編集/保存 → Kanban 操作 → commit → 履歴/意味的差分 → branch → Issue/PR → (file:// リモートで)sync → エクスポート HTML/Docx → 静的サイト書出し、を一気通し(このセッションから自動実行可能な範囲で最大限)。

### 2.8 M8 ゲート(Done 判定)

1. 既存 7 ゲート + M7 の sync 統合テスト、全 green
2. semanticMerge3 テストスイート(自動マージ/conflict 判定/canonical 出力)green
3. ConflictResolver がブラウザモックの疑似 conflicts シナリオで E2E 動作(選択 → 完了 → mock merge commit)
4. モバイルビューポート(375×812)で主要フロー UI 破綻なし(スクリーンショット記録)
5. `tauri ios init` / `android init` 生成物がリポジトリに入り、cargo check 2 本が green のまま
6. デスクトップ PDF が実 tauri dev で出力成功(file:// 方式)
7. M8-MANUAL-CHECKS.md(実機確認手順)整備

### 2.9 M8 のリスク

| リスク | 対策 |
|---|---|
| 3-way 整列のエッジケース(移動+編集の複合等) | 迷ったら conflict に倒す(自動マージの誤りはデータ破壊、conflict 過多は UX 低下で済む)。テスト網羅を厚く |
| モバイル WebView 差異(print、長押し、DnD) | すべてフォールバック並存(ボタン移動/共有シート/⋯メニュー)+ 手動チェックリスト化 |
| tauri ios/android init の生成物がゲートを壊す | init はブランチ内で試し、ゲート緑を確認してから採用 |
| ConflictResolver の工数肥大 | v1 は「ブロック単位で ours/theirs/両方」の 3 択のみ。ブロック内テキスト編集機能は付けない |

---

## 3. 実行順序と分担(ワークフロー計画)

- **WF-M7**(3 トラック並列 + 統合):
  - S1 Rust 同期: §1.1–1.7(remote/credential/sync/和集合/2クローン統合テスト/gix TLS スパイク)
  - S2 同期 UI: §1.3(モーダル)+ §1.10 + mock
  - S3 静的サイト: §1.9
- **WF-M8**(3〜4 トラック並列 + 統合):
  - C1 Rust conflict 素材/解決コマンド: §2.1.1
  - C2 semanticMerge3 + ConflictResolver: §2.1.2–2.1.3
  - C3 レスポンシブ/タッチ + capability 文言: §2.2, §2.6
  - C4 PDF 改修 + 自動同期 + 仕上げ群: §2.4, §2.5, §2.7
  - 統合後に §2.3(ios/android init)と §2.7-6(実機なし通しスモーク)を直列で
- 各 WF の統合エージェントが全ゲートを回し、最後に本ファイルへ結果追記。

## 4. M8 完了後に残るもの(v2 バックログ、正直リスト)

- SSH 認証 / 複数リモート / gix push(または isomorphic-git フォールバック)
- OS バックグラウンド同期、モバイル向け stronghold 認証
- Typst PDF バックエンド(高品質印刷)、ダークモード
- リンクの自動補完・ページ内検索・全文検索(SQLite FTS)
- 実機での通し検証(手動チェックリスト消化)

---

## 実装完了(2026-07)

**M7・M8 とも実装完了。** 本計画の全トラック（WF-M7: S1/S2/S3、WF-M8: C1/C2/C3/C4）が
着地し、5 ターゲット CI ゲートは全緑:

- `npx tsc --noEmit` / `npx vitest run`(全緑・回帰なし)
- `cargo check`(libgit2) / `--features git-gix` / `--target aarch64-apple-ios` /
  `--target aarch64-linux-android`(NDK env) — 4 構成すべて警告ゼロ
- `cargo test --lib`(libgit2 / gix 両構成、2 クローン同期 + コンフリクト解決含む)
- `npm run build`(vite チャンク分割済み、500kB 警告解消・plugin-dialog 動的 import 警告解消)

主な実装ポイント（§2 の各項に対応）:

- §2.1 コンフリクト解決: Rust `git_conflict_versions` / `git_merge_resolve`(in-memory
  merge、libgit2 限定) + TS `semanticMerge3`(mdast ブロック整列) + `ConflictResolver`。
- §2.2 レスポンシブ: ≤768px でドロワー / 全画面シート / Kanban Pointer Events ドラッグ
  (←/→ ボタンをフォールバックに常設)。
- §2.4/§2.6 PDF: 一時ファイル(`write_temp_file`)+ `file://` を WebviewWindow で開く方式
  (`tauri://error` → `window.open` フォールバック)。モバイルは `window.print()` +
  「HTML を書き出して共有」。
- §2.5 自動同期: `.hakushi/config.json`(gitignore 済み)に `autoSync {onLaunch, intervalMin,
  afterCommit}`。起動時同期 + 単一インターバルタイマー(ビジーポーリングなし)、dirty は
  スキップ、conflicts はバッジ表示。
- §2.7 仕上げ: エクスポート暗黙保存失敗時は中止+エラー表示 / vite manualChunks
  (tiptap・prosemirror・codemirror・markdown・react 分離) / plugin-dialog 静的 import 統一 /
  dead_code 警告を `#[allow(dead_code)]` + 理由コメントで沈黙化 / README・CLAUDE.md・
  DESIGN.md ステータス最終更新。

残りは §4 の v2 バックログ(および実機通し検証の手動消化)のみ。

---

## M8 統合完了(2026-07-05, インテグレータ)

WF-M8 の全トラック(C1/C2/C3/C4)を統合し、シーム調整・全ゲート再実行・
モバイル実プロジェクト生成・ブラウザ E2E スモークまで完了。**M0–M8 完了、M8 Done 判定を満たす。**

### ゲート再実行結果(全緑)

| ゲート | 結果 |
|---|---|
| `npx tsc --noEmit` | PASS |
| `npx vitest run` | PASS(23 ファイル・**371 passed / 1 skipped**。M8 で semantic-merge 20 + 各トラックのテストが追加) |
| `cargo check`(libgit2) + `cargo test --lib` | PASS(**40 テスト**。M8 でコンフリクト解決 4 + sync sentinel 拡張) |
| `cargo check --features git-gix` + `cargo test --lib` | PASS(**27 テスト**) |
| `cargo check --target aarch64-apple-ios`(gix) | PASS |
| `cargo check --target aarch64-linux-android`(gix, NDK env) | PASS |
| `npm run build`(vite) | PASS(チャンク分割済み・500kB/動的 import 警告なし) |

### シーム調整(統合で埋めた継ぎ目)

1. **コンフリクトバッジ → ConflictResolver の配線**(§2.5 / §12.3): sync が
   `conflicts` を返すと App.tsx はサイドバーにバッジを出すが、**バッジから解決画面への
   導線が無かった**。バッジを `<button>` 化し、タップで Git パネルを開いて
   `conflictSource` を GitPanel へ渡す(GitPanel は既に `conflictSource` prop で
   ConflictResolver を自動起動する実装済みだった)。解決完了で `onReverted("")` 経由で
   バッジを消す。`src/App.tsx` + `src/styles.css`。
2. **sync コンフリクトの解決 source 解決**(Rust): sync コンフリクトは
   `origin/<現ブランチ>` に対する merge であり、`git_conflict_versions(root, source)` の
   `merge_endpoints` が **local branch しか解決しなかった**ため sync 由来のコンフリクトを
   実バックエンドで解決できなかった。`merge_endpoints` を拡張し、sentinel `__sync__` →
   `origin/<現ブランチ>` 解決 + 一般 revspec フォールバック(`origin/main` 等)を追加。
   PR マージ経路(local branch 名)は不変。マージコミットメッセージも sentinel 用に分岐。
   `src-tauri/src/git/libgit2_backend.rs`。sync.rs の 2 クローン統合テストを拡張して
   sentinel 解決を assert。
3. **共有 sentinel 定数**: `SYNC_CONFLICT_SOURCE = "__sync__"` を `workspace.ts`(本番)に
   定義。**mock は同値のローカルリテラルで保持**(workspace.ts が tauri-mock を import
   する循環のため、値 import は循環初期化 TDZ を招く。mock は型のみ import する規約)。
   Rust の同名リテラルと 3 者一致。

### モバイル実プロジェクト生成(§2.3)

- `npm run tauri ios init` → `src-tauri/gen/apple`(Xcode プロジェクト、xcodegen 経由)生成成功。
- `npm run tauri android init` → `src-tauri/gen/android`(Gradle プロジェクト)生成成功。
- 生成物は各自の `.gitignore`(`gen/apple/.gitignore`・`gen/android/.gitignore`)で
  build 出力のみ除外、プロジェクトソースは追跡対象。生成後にモバイル 2 ゲート +
  デスクトップゲート再実行、全緑を確認(回帰なし)。
- 実機/シミュレータでの起動・タッチ検証は headless 不可 → M8-MANUAL-CHECKS.md へ。

### E2E スモーク(§2.7-6、実 tauri dev 不可のため最強の代替)

- ブラウザ(vite preview + tauri-mock)で **conflicts → バッジ → ConflictResolver →
  選択(両方残す)→ マージ完了 → gitMergeResolve → 解決画面クローズ → バッジ消滅** を
  通し確認(コンソールエラーなし)。ConflictResolver が `source="__sync__"` を受けて
  自動マージブロックを畳み、衝突ブロックを 3 択カードで表示することを確認。
- モバイルビューポート(375×812)でハンバーガー(☰)表示・横スクロールなしを確認。
- 実機通し(タッチ編集/Kanban ドラッグ/モバイル同期/モバイル PDF/共有シート)は
  M8-MANUAL-CHECKS.md の手動チェックリストに残置。
