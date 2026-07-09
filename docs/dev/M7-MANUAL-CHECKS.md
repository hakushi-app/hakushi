# M7 手動チェックリスト — GitHub over HTTPS 同期 + keyring 挙動

作成日: 2026-07-05 / 対象: M7（リモート同期 + 共有、docs/dev/M7-M8-PLAN.md §1）

自動テスト（`cargo test --lib` の `git::sync::tests` / `git::gix_sync::tests`）は
**file:// リモート**で 2 クローン間の push/pull・collab 和集合・コンフリクト・
noRemoteBranch を完全網羅する。**https 経路はネットワーク依存で自動化不可**なので、
以下を手動で 1 回確認する（GitHub 実試験は任意だが、リリース前に強く推奨）。

---

## 前提

- デスクトップビルド（`git-libgit2`、default feature）。https は
  `git2/https + vendored-openssl + vendored-libgit2` で有効。vendored openssl +
  libgit2 の初回コンパイルは macOS で約 32 秒（クリーン状態から）。以後はキャッシュ。
- GitHub の**プライベートリポジトリ**を 1 つ用意（空でよい）。
- GitHub Personal Access Token (classic または fine-grained) を発行。
  - classic: スコープ `repo`。
  - fine-grained: 対象リポジトリに Contents: Read and write。

---

## 手順 A: リモート設定 + PAT 保存 + push

1. Hakushi でワークスペースを開き、ページを 1 枚作成して commit する。
2. ⋯メニュー →「同期設定…」:
   - リモート URL に `https://github.com/<owner>/<repo>.git` を入力して保存。
     （内部: `git_remote_set`。`git_remote_get` で保存後の URL が表示されること）
   - PAT 欄にトークンを貼り付けて保存。**入力欄が即クリアされ**、
     「保存済み ✓」表示になること（内部: `credential_set` → `credential_has`）。
3. ⋯メニュー →「今すぐ同期」:
   - 成功トースト/ステータス行に SyncReport.message が出ること
     （例: `branch will be created on the remote; collab: 0 updated, 0 unchanged; pushed`）。
   - **確認ポイント（キーチェーン未保存で失敗経路）**: 手順を PAT 未保存でやると
     「同期設定で PAT を保存してください」相当のエラーになること。

### 検証: `refs/hakushi/*` が GitHub 上に見えること

ターミナルで:

```sh
git ls-remote https://<owner>:<PAT>@github.com/<owner>/<repo>.git
```

- `refs/heads/<branch>`（コード）が見えること。
- Issue / PR を 1 つ作ってから再同期すると `refs/hakushi/issues/<ulid>` /
  `refs/hakushi/prs/<ulid>` が **リモートに現れる**こと（collab refs の push 検証）。

---

## 手順 B: 別クローンで pull → 双方向同期

1. 別ディレクトリ（または別マシン）で同じリポジトリを Hakushi の
   「別のフォルダを開く…」で clone 済みワークスペースとして開く
   （clone は現状デスクトップの `git clone` か、将来の app 内 clone）。
2. クローン A で Issue にコメント、クローン B で同じ Issue に別コメント。
3. A→B→A→B の順に「今すぐ同期」を各 2 巡:
   - 両クローンで Issue のコメントが**両方**見え、順序が一致すること
     （collab 和集合マージの決定論的収束。自動テストと同じ挙動を実機 https で確認）。
4. A と B が別ページを編集して双方 sync → 片方が merge され、コンフリクトなしで
   両ページが揃うこと。
5. A と B が**同一ページの同一行**を編集して sync:
   - `conflicts` になり、ワークツリーが自分の版のまま保たれること。
   - それでも Issue/PR（collab refs）は同期されること。
   - M7 の UI は「コンフリクトは M8 の解決画面で対応予定。今はデスクトップの git で
     解決してください」と表示（M8 で ConflictResolver 化）。

---

## 手順 C: 静的サイト公開（S3 トラック、参考）

1. ⋯メニュー →「静的サイトを書き出す…」→ 出力フォルダを選択。
2. 出力フォルダに各ページの `.html` と `index.html`（ナビ付き）が生成され、
   ページ間リンクが `.html` に書き換わっていること。
3. 公開は既存手段で: 出力を gh-pages ブランチに push、または Netlify に
   ドラッグ&ドロップ（README の該当節参照。アプリからの自動デプロイはしない）。

---

## keyring（OS キーチェーン）挙動ノート

トークンの保存先と挙動は OS ごとに異なる（`src-tauri/src/credentials.rs`、
service = `"hakushi"`, account = ホスト名）:

| OS | backend | 保存先 | 備考 |
|---|---|---|---|
| macOS | apple-native | ログインキーチェーン | 初回アクセスで許可ダイアログが出ることがある |
| iOS | apple-native | iOS キーチェーン | 同一 framework。M7 は pull-only |
| Windows | windows-native | Credential Manager | `hakushi/<host>` エントリ |
| Linux | linux-native | kernel keyutils | **セッション永続のみ**（再起動で消える）。恒久保存が要る場合は v2 で secret-service へ |
| Android | （マッチなし） | in-memory mock | 再起動で消える。android 同期は pull-only、実試験は手動なので実害なし。恒久化は stronghold 移行（M8 フォローアップ） |

### 手動確認項目

- **トークンは TS 側へ絶対に返らない**: `credential_set/clear/has` のみ存在し、
  get コマンドは無い（`src-tauri/src/credentials.rs` に `credential_get` が
  存在しないことをコードで確認）。DevTools のネットワーク/IPC ログにトークンが
  出ないこと。
- 「同期設定…」で PAT を保存 → `credential_has` が true → 「削除」で
  `credential_clear` → `credential_has` が false になること。
- ホスト抽出: `github.com` / `gitlab.com`（→ username `oauth2`）/
  self-hosted GitLab（`gitlab.*` / `*.gitlab.*` → `oauth2`）/ その他
  （→ `x-access-token`）で正しいユーザ名が使われること（`credentials.rs` の
  `username_for_host` 単体テスト済み。実 https は GitHub で PAT が通ることを確認）。

---

## 既知の制約（M7 スコープ、docs/dev/M7-M8-PLAN.md §1.8）

- **SSH 認証は非対応**（`ssh://` / `git@…` は「https を使ってください」とエラー）。
  → M8 以降のフォローアップ。
- **モバイルは fetch-only（pull）**: gix は collab refs + branch を fetch して
  Issue/PR を端末で読めるが、worktree 更新（checkout）と push はデスクトップ限定。
  UI は理由を表示。
- 複数リモート / リモート branch 一覧 UI / shallow clone / LFS は M7 非対象。
- 同時 push の non-fast-forward 競合は 1 回 fetch+リトライ。追記専用ログなので
  次回同期で必ず収束する。
