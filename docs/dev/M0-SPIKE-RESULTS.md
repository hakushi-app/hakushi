# M0 スパイク結果: gix (gitoxide) モバイル git バックエンド

**結論: M0 ゲート通過。** 純 Rust の gix バックエンドは iOS / Android の両ターゲットで
`cargo check` が通り、ローカル操作（init / is_repo / status / commit_all / log）は
すべて実装済み・テスト済み。Unsupported に残した M0-M1 対象操作は**なし**。

実施日: 2026-07-04 / 対象コード: `src-tauri/src/git/gix_backend.rs`, `src-tauri/Cargo.toml`

## 1. ピン留めバージョン

- **gix 0.85.0**（Cargo.lock でロック済み。モバイル依存グラフに gix-* クレートは 48 個）
- MSRV 1.85 / edition 2024（Rust stable で問題なし）
- DESIGN.md「Rust 側 git crate の最終ピン留めバージョン（M0 スパイク結果で確定）」
  → **0.85.0 で確定**。M4/M6 で更新・再検証（DESIGN.md リスク #5）。

## 2. 選定 feature セット

```toml
gix = { version = "0.85.0", optional = true, default-features = false, features = [
    "sha1",        # オブジェクトハッシュ（これが無いと object を一切書けない）
    "status",      # Repository::status（tree↔index + index↔worktree + dirwalk で untracked 検出）
    "tree-editor", # Repository::edit_tree（commit_all のツリー構築に使用）
] }
```

- `default-features = false` から compile-error-driven で積み上げた**最小セット**。
- `status` は推移的に `dirwalk` / `index` / `blob-diff` / `attributes`（gix-dir,
  gix-index, gix-diff, gix-filter など）を有効化する。すべて純 Rust。
- `revision` は不要（`Repository::rev_walk` は core。`revision` feature は
  describe / merge_base 用で log には要らない）。
- `parallel` は不使用（status イテレータが直列バッファリングになるが正しく動く。
  性能が問題になったら desktop 向けに検討）。
- **ネットワーク/TLS 系 feature は一切なし**（M7 まで封印）。注意点として
  gix-protocol / gix-transport は gix の必須依存（型の提供のみ）としてグラフに
  現れるが、client 系 feature を付けない限りトランスポート実装を含まない。
  `cargo tree`（android ターゲット）で **curl / openssl / rustls / ring /
  native-tls / libz-sys が皆無**であることを確認済み。zlib は純 Rust の
  `zlib-rs`。ターゲット向け C コンパイルはゼロ。

## 3. 実装した trait 操作

| 操作 | 状態 | 実装メモ |
|---|---|---|
| `init` | 実装 | `gix::init`。既存リポジトリなら no-op 成功 |
| `is_repo` | 実装 | `gix::open_opts(root, isolated)`。上方探索なし（libgit2 側と同じ） |
| `status` | 実装 | `Repository::status`（tree↔index + index↔worktree、untracked は `UntrackedFiles::Files` で個別列挙）。同一パスに複数変化が出た場合は libgit2 側の if-chain と同じ優先順位（conflicted > renamed > new > deleted > modified）で 1 エントリに畳む |
| `commit_all` | 実装 | 下記参照。`git add -A && git commit` と同じ観測結果 |
| `log` | 実装 | `rev_walk` + `Sorting::ByCommitTime(NewestFirst)`（libgit2 の `Sort::TIME` 相当）。`rel_path` フィルタは各コミットと第1親のツリーエントリ `(mode, oid)` 比較（root コミットは存在チェック） |
| branch/merge/push/pull ほか | Unsupported | M0-M1 対象外。`capabilities()` は init/status/commit/log = true、他 false で正直に報告 |

### commit_all の方式（gix には "add -A" 相当の高レベル API がまだ無い）

1. `HEAD^{tree}`（unborn なら空ツリー）から**メモリ上に** index を生成
   （`index_from_tree`）し、それを基準に worktree との差分を列挙
   （`into_index_worktree_iter`）。→ .git/index の事前状態に関わらず
   「worktree vs HEAD」の全変化が取れる。
2. `edit_tree(HEAD^{tree})` に差分を適用（新規/変更 → blob 書き込み + upsert、
   削除 → remove）。symlink / 実行ビットも反映。
3. 新ツリー == HEAD ツリーなら `NothingToCommit`。
4. `commit_as` でコミット（author/committer は git config、未設定なら libgit2
   バックエンドと同じ `Hakushi <hakushi@local>` フォールバック）。
5. `.git/index` をコミット済みツリーから再生成して書き戻し → 直後の `status` は
   クリーン。stat キャッシュはゼロなので次回 status は全ファイル再ハッシュに
   なる（正しいが stat-fast ではない。M1 の規模では問題なし）。

### 動作検証

libgit2 バックエンドのラウンドトリップテストを gix 側に移植
（`git::gix_backend::tests`）: init 冪等性 / 空リポジトリで NothingToCommit /
new・modified・deleted の status / コミット後 status クリーン / log 3 件 +
パスフィルタ + limit — **全部パス**（`cargo test --no-default-features
--features git-gix --lib`）。

## 4. ゲート結果（2026-07-04, ローカル macOS / Rust stable）

| # | コマンド (`src-tauri/` にて) | 結果 |
|---|---|---|
| a | `cargo check --no-default-features --features git-gix` | **PASS** |
| b | `cargo check --target aarch64-apple-ios --no-default-features --features git-gix` | **PASS** |
| c | `cargo check --target aarch64-linux-android --no-default-features --features git-gix` | **PASS** |
| 回帰 | `cargo check`（default = git-libgit2） | **PASS** |
| 追加 | `cargo test --lib`（両バックエンド、計 5+5 テスト） | **PASS** |

警告は 2 件のみ（`backend.rs` の未使用 trait デフォルトメソッド由来の
dead_code。libgit2 構成でも同じで、本スパイク以前から存在）。

## 5. Android NDK 環境について（CI 再現用）

**`cargo check` に NDK は不要だった。** ターゲット向けに C をコンパイルする
クレートがグラフに存在しない（gix は純 Rust、zlib は zlib-rs、`cc` は
tauri-build の Windows リソース用でホスト側のみ）ため、(c) は
`CC_aarch64_linux_android` 等を**未設定でもクリーン状態から通る**ことを確認した。

ただし `cargo build`（リンクが走る）には NDK clang が必要になるため、
`.github/workflows/ci.yml` の `android-check` ジョブの env
（`CC_/CXX_/AR_/RANLIB_aarch64_linux_android` +
`CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` を
`$ANDROID_NDK_LATEST_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin` の
`aarch64-linux-android24-clang` 系に向ける設定）は**正しく、そのまま維持**する
（M0 後半の実ビルド化でそのまま効く）。ローカル macOS での相当設定:

```sh
NDK_BIN="$HOME/Library/Android/sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/darwin-x86_64/bin"
export CC_aarch64_linux_android="$NDK_BIN/aarch64-linux-android24-clang"
export CXX_aarch64_linux_android="$NDK_BIN/aarch64-linux-android24-clang++"
export AR_aarch64_linux_android="$NDK_BIN/llvm-ar"
export RANLIB_aarch64_linux_android="$NDK_BIN/llvm-ranlib"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$NDK_BIN/aarch64-linux-android24-clang"
```

補足: `cargo check` は tauri-build が `frontendDist`（`../dist`）の存在を
要求するため、CI 同様ローカルでも空の `dist/` があれば十分。

## M2 追補: rusqlite (bundled) のモバイルコンパイル結果

実施日: 2026-07-04。M2 のリンク索引（`.hakushi/index.db`、`src/index_store.rs`）で
`rusqlite 0.40`（feature `bundled` = SQLite C amalgamation を同梱コンパイル）を追加した。
これにより**ターゲット向け C コンパイルがゼロではなくなった**ため、§5 の前提が一部更新される:

| ターゲット | 結果 | 備考 |
|---|---|---|
| aarch64-apple-ios | **PASS** | 追加 SDK フラグ不要。標準の cc + xcrun で iphoneos SDK を自動検出し、`libsqlite3.a`（aarch64-apple-ios）が生成されることを確認 |
| aarch64-linux-android | **PASS（要 NDK env）** | §5 の `CC_/CXX_/AR_/RANLIB_aarch64_linux_android` + linker 設定が**`cargo check` にも必須になった**（未設定だと cc-rs が `aarch64-linux-android-clang` を見つけられず build script が失敗することを確認）。`libsqlite3.a`（aarch64）生成を確認 |

- **CI への影響なし**: `.github/workflows/ci.yml` の `android-check` ジョブは既に
  §5 の env 一式を設定済みで、そのまま通る（変更不要であることを上記ローカル再現で確認）。
  ios-check / desktop-check も追加設定不要。
- `rusqlite` は `bundled` なのでシステム sqlite への依存はどのターゲットにもない。
- gix/git2 の構成（feature 切替・ネットワーク封印）は無変更。

## M4 追補: branch / file_at_commit / revert_file の gix 実装状況

実施日: 2026-07-04。M4 の git UI コマンド（INTERFACES.md §7.1）追加に伴う
gix バックエンド（`src-tauri/src/git/gix_backend.rs`）の状況:

- **実装済み**: `branches`（refs/heads/* 列挙 + HEAD、unborn は current=None）/
  `create_branch`（HEAD コミットへの ref 作成。gix の `PreviousValue::MustNotExist`
  は同一ターゲットへの再作成を冪等成功とするため、重複エラーは明示的な存在チェックで
  担保）/ `file_at_commit` / `revert_file`（いずれも読み取り中心 or ref 書き込みのみ）。
- **`checkout_branch` は Unsupported のまま**（`capabilities().branch = false` を維持。
  このフラグは「create と checkout の両方が使える」の意）: gix には安全な
  ワークツリーリセット（checkout）の高レベル API がまだ無く、HEAD 付け替え +
  worktree 書き換えの自前実装は M4 モバイル範囲外とした。M6（アプリ内マージ）で再検討。
- **feature 追加なし**: 既存の `sha1` / `status` / `tree-editor` で全操作を賄えた
  （ref 列挙・作成、tree lookup、blob 読みはすべて gix コア）。
- ゲート 4 構成（desktop libgit2 / gix / aarch64-apple-ios / aarch64-linux-android
  ※Android は §5 の NDK env）で `cargo check` + `cargo test --lib`（ホスト 2 構成）
  re-run: **全 PASS**。

## 6. フォローアップ

1. **フィルタ非対応**: worktree の blob を生バイトで書く（gitattributes /
   core.autocrlf の smudge/clean 変換なし）。Hakushi ワークスペースは属性を
   設定しないので実害なしだが、外部リポジトリを開く日が来たら `gix-filter`
   のパイプラインを commit_all に通すこと。
2. **stat キャッシュ**: commit_all 後の index は stat ゼロ。大規模
   ワークスペースで status が遅くなったら、コミット時に fs の stat を
   index エントリへ埋める最適化を入れる。
3. **conflicted status**: gix 側は `Summary::Conflict` をマップ済みだが、
   マージ未実装の現状では発生経路がない。M6（アプリ内マージ）で実データ検証。
4. **M7 ネットワーク**: `blocking-http-transport-reqwest-rust-tls`（rustls）
   を第一候補に再スパイク。不足なら DESIGN.md どおり isomorphic-git
   フォールバック。TLS 系はこのスパイクでは意図的に完全未検証。
5. **バージョン更新**: gix は 0.x で API が動く（実際 status/commit 周りは
   若い API）。更新は M4/M6 の節目でまとめて行い、本ゲート 3 本を再実行する。
6. `parallel` feature の性能検証（デスクトップで gix を使う日が来た場合のみ）。

## M7 追補: gix TLS ネットワーク・スパイク（採用）

実施日: 2026-07-05。M7-M8-PLAN.md §1.7 の gix ネットワーク・スパイクを実施し、
**採用（fetch-only pull を配線）**した。

### 試した feature 集合

`src-tauri/Cargo.toml` の `git-gix` 構成の gix に以下を追加:

```toml
gix = { version = "0.85.0", optional = true, default-features = false, features = [
    "sha1", "status", "tree-editor",
    "blocking-network-client",                       # ← 追加
    "blocking-http-transport-reqwest-rust-tls",      # ← 追加(rustls/ring 純Rust)
] }
```

### ゲート結果（2026-07-05, ローカル macOS / Rust 1.96）

| # | コマンド | 結果 |
|---|---|---|
| a | `cargo check --no-default-features --features git-gix` | **PASS** |
| b | `cargo check --target aarch64-apple-ios --no-default-features --features git-gix` | **PASS**（約 28s、初回のみ） |
| c | `cargo check --target aarch64-linux-android --no-default-features --features git-gix`（NDK env） | **PASS**（約 14s、初回のみ） |
| d | `cargo test --no-default-features --features git-gix --lib` | **PASS**（26 テスト、fetch-only pull の file:// 統合テスト含む） |

### cargo tree の証拠（android ターゲット）

```
cargo tree --target aarch64-linux-android --no-default-features --features git-gix
```

- **openssl / openssl-sys / curl / curl-sys / native-tls / schannel / libz-sys: 皆無**
  （C リンクする TLS 依存はゼロ。ターゲット向け C コンパイルは rusqlite の
  bundled SQLite のみで、M2 追補から不変）。
- `ring v2.0.2` / `ring v3.6.3` / `rustls v0.23/0.26/0.27` / `reqwest v0.13.4` は
  出現するが、**すべて純 Rust**。しかも `reqwest` は **tauri 2.11.5 が既に
  依存グラフに引き込んでいた**（updater/http スタック）ため、gix の
  `gix-transport → reqwest` は**同じ rustls スタックを共有するだけで、新規の
  TLS/C 依存はゼロ**。M0 時点の「reqwest/ring 皆無」という記述は tauri の
  バージョン更新で既に古くなっていたが、判定基準（openssl/curl の不在 +
  モバイル 2 ゲートの緑）は本スパイクでも完全に維持されている。
- `ring` は android/ios ともにクロスコンパイル成功（ゲート b/c が緑）。

### 判断と配線

**採用**。ゲートが全緑・C-TLS 依存ゼロのため、gix に **fetch-only pull** を配線した
(`src-tauri/src/git/gix_sync.rs`):

- `GixBackend::sync` = origin URL 取得 → dirty チェック → gix の
  `remote.connect(Fetch).prepare_fetch().receive()` で
  `+refs/heads/*:refs/remotes/origin/*` と `+refs/hakushi/*:refs/hakushi-remote/*`
  を fetch → **collab refs の和集合マージ（libgit2 と完全に同じ
  `collab::sync::union_merge_all`）** を実行 → SyncReport 返却。
- **worktree は一切触らない・push しない**: gix には安全な checkout が無い
  （§checkout_branch / merge_branch が Unsupported なのと同根）ため、コード
  branch の worktree 反映は「デスクトップで実施」と正直に報告。push も未配線
  （gix push は 2025 時点で未成熟、§1.8 どおり M7 非対象）。
- capabilities: **`pull = true` / `push = false`**（`branch`/`merge` は従来どおり false）。
- HTTPS PAT 認証: URL ホストのトークンを keyring から注入（file:// は不要）。
  ネットワーク非依存の自動テストは file:// 経由の 2 クローン相当（remote=通常
  gix リポジトリ、local=origin を file:// で設定）で fetch→和集合→issue が
  端末側で読めることを検証済み（`git::gix_sync::tests`）。
- 認証つき https の実試験は手動（docs/dev/M7-MANUAL-CHECKS.md）。

### keyring のモバイル・ビルド

`keyring` は `apple-native`（macOS/iOS Keychain）/ `windows-native` /
`linux-native`（kernel keyutils, 純 Rust）のみ有効。**android はどの backend にも
マッチせず keyring の in-memory mock にフォールバック**するが、android の同期は
本 M7 では pull-only かつ private リポジトリの実試験は手動なので実害なし
（stronghold 移行は M8 フォローアップ、DESIGN.md §リスク）。iOS の apple-native は
`cargo check --target aarch64-apple-ios` が緑（上記ゲート b）で、C リンクは無し。
