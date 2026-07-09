# M8 手動チェックリスト — 実機（iOS/Android）タッチ UX + モバイル同期 + コンフリクト解決

作成日: 2026-07-05 / 対象: M8（モバイル堅牢化 + コンフリクト解決 UX、docs/dev/M7-M8-PLAN.md §2）

M8 の自動ゲートは **TypeScript の純関数**（`semanticMerge3` テストスイート）、
**ブラウザのモバイルビューポート（375×812）での UI 検証**、および
**iOS/Android の `cargo check` ビルドゲート**までを緑にしている。しかし
**実機・シミュレータでのタッチ操作・印刷ダイアログ・共有シート・OS キーチェーンは
このセッションからは headless で検証できない**（docs/dev/M7-M8-PLAN.md §2.8-7 が
M8 Done 判定にこの手動チェックリストを要求）。以下を実機か Xcode/Android の
シミュレータで 1 回ずつ確認する。

自動側で確認済み（＝ここで再確認しなくてよい）:

| 領域 | 自動確認の内容 | 手段 |
|---|---|---|
| 意味的 3-way マージ | 非重複編集の全自動 / 同一ブロック衝突 / リスト項目単位整列 / canonical 出力 | vitest（`src/git-ui/semantic-merge.ts`） |
| ConflictResolver | 疑似 conflicts シナリオの選択 → 完了 → mock merge commit | ブラウザ tauri-mock |
| レスポンシブ | 375×812 で主要フロー（作成→編集→保存→Kanban→Git パネル→Issue） | preview スナップショット |
| モバイルビルド | `cargo check --target aarch64-apple-ios / aarch64-linux-android`（gix 構成） | CI ゲート |

---

## 前提

- デスクトップの全機能は M4–M7 で検証済み（M7 の手動チェックは
  [M7-MANUAL-CHECKS.md](M7-MANUAL-CHECKS.md)）。ここは**モバイル固有**の通し確認。
- iOS: Xcode + CocoaPods。Android: Android SDK + NDK（`cargo check` の rusqlite
  bundled が C コンパイルに NDK env を要求）。
- モバイルプロジェクト生成物（`src-tauri/gen/apple`・`gen/android`）が
  `tauri ios init` / `tauri android init` 済みでリポジトリに入っていること。
- 同期試験用に **https リモート（GitHub のプライベートリポジトリ）+ PAT** を 1 つ。
  M7 で用意したものを再利用してよい（発行手順は M7-MANUAL-CHECKS.md §前提）。
- モバイルは fetch-only 運用が既定なので、**まずデスクトップで clone 済みの
  ワークスペースを端末側でも開く**（または同一リポジトリを端末で clone）。

---

## 手順 A: 実機起動 + タッチ編集

1. `npm run tauri ios dev`（実機/シミュレータ）または `npm run tauri android dev`
   でアプリが起動し、ワークスペースが自動オープンされること。
2. ページを 1 枚開き、**WYSIWYG（TipTap v3）でタッチ編集**できること
   （キャレット配置・IME 入力・見出し/リスト操作）。
3. **ソース（CodeMirror 6）へ切替**てタッチ編集できること（CM6 はタッチ対応済み、
   ここは確認のみ）。リッチビュー ⇄ WYSIWYG ⇄ ソースの切替が破綻しないこと。
4. ボタン等のタップ領域が **≥44px** で押しやすいこと（M8 で padding 拡大済み）。
5. 編集 → 保存 → 再オープンで内容が保たれること（保存経路はデスクトップと同一の
   `pipeline.ts` → `normalizeMarkdown` → `writeFile`）。

---

## 手順 B: Kanban タッチドラッグ（`src/templates-ui/KanbanBoard.tsx`）

HTML5 DnD はモバイル WebView で効かないため、Pointer Events で自前実装している。

1. Kanban テンプレートのページを開く。
2. カードを**長押し（200ms、`LONG_PRESS_MS`）**するとドラッグが始動し、指に追従する
   **ゴースト（`.kanban-drag-ghost`）**が出ること。元カードは `pointer-dragging` 状態。
3. 別カラムの上で指を離すと、そのカラムの**末尾**にカードが移動すること
   （←/→ ボタンと同じ意味論 = カラム末尾へ append）。
4. **誤発火の抑制**: 長押し前に **10px（`MOVE_CANCEL_PX`）以上**指を動かした場合は
   ドラッグにならずスクロールになること（ボード縦スクロールと共存）。
5. **フォールバックが常に生きていること**: 各カードの **← / →** ボタンで
   カラム間移動ができること（ドラッグは progressive enhancement。ドラッグが効かない
   端末でも操作可能）。
6. カード 1 枚移動 = **1 行の意味的差分**であること（履歴/差分で確認。ドラッグでも
   ボタンでも同じ最小差分）。

---

## 手順 C: モバイルレイアウト（≤768px、`src/app/useResponsive.ts` / `Drawer.tsx`）

1. サイドバーが**ドロワー**になり、**ハンバーガー**で開閉できること
   （`.drawer-shell` / `.drawer-shell.open`）。
2. ドロワー展開中は**バックドロップ（`.drawer-backdrop`）**が出て、
   **バックドロップのタップ**または **Escape** で閉じること。
3. 右パネル（Git | Issues | PRs）が**全画面シート**になり、タブが維持されること。
4. モーダル（同期設定・エクスポート・コンフリクト解決）が **90vw** 幅で開くこと。
5. コンテキストメニューは**長押し**で発火し（モバイル Safari の `onContextMenu`）、
   加えて **⋯ ボタン**が常時見えるので長押し不発でも操作できること。
6. `useIsMobile()` がブレークポイントを跨ぐ回転/リサイズで正しく再描画すること
   （タブレットの縦横回転で ≤768px 境界を跨ぐケース）。

---

## 手順 D: モバイル同期（gix fetch-only pull、https + PAT）

モバイル（gix）は **pull=true（fetch のみ）/ push=false / checkout=false / merge=false**。

1. **⋯メニュー →「同期設定…」**（`src/app/SyncSettings.tsx`）:
   - リモート URL が設定済みであること（デスクトップ clone 由来。gix は set が
     Unsupported なので、未設定ならデスクトップで設定してから clone/pull する運用）。
   - https リモートなら **PAT を保存**（`credential_set`、入力欄が即クリア →
     「保存済み ✓」= `credential_has` true）。トークンは iOS キーチェーンに格納。
2. **「今すぐ同期」→ pull（fetch-only）**が成功し、リモートの更新
   （branch の先端・collab refs）が端末に降りてくること。
3. デスクトップで作成した **Issue / PR が端末で読める**こと（`refs/hakushi/*` を
   fetch して閲覧。worktree の checkout は伴わない）。
4. **push が無効**で、非エンジニア文言が出ること（`capabilities.ts` の
   `capabilityNotice`）:
   > この端末では変更のアップロード（送信）は未対応です。PC 版 Hakushi をご利用ください。
   同様にブランチ切替・マージも「未対応 → PC 版を…」の統一文言であること。
5. **トークンが TS 側へ返らない**こと（`credential_get` は存在しない。DevTools/IPC
   ログにトークンが出ない — M7-MANUAL-CHECKS.md の keyring ノート参照）。

> Android の keyring は現状 in-memory フォールバック（再起動で消える）。
> pull-only なので実害は小さいが、再起動後は PAT 再入力が要ることを確認
> （恒久化は stronghold 移行 = v2 バックログ）。

---

## 手順 E: コンフリクト解決 UX ウォークスルー（`ConflictResolver.tsx` / `semantic-merge.ts`）

コンフリクト解決（in-memory 3-way マージ）は **libgit2 限定**。モバイルは fetch-only
運用で通常コンフリクトは起きないため、**この手順はデスクトップ（`tauri dev`）で実施**する
（M8 の Done 判定に含まれる UX 通し確認）。

1. 2 クローン（または 2 ワークスペース）で**同一ページの同一ブロック**を別々に編集し、
   両方 commit → 一方で「今すぐ同期」→ `conflicts` になること
   （コード branch の push はスキップ、collab refs は同期される）。
1b. サイドバーの**「⚠ コンフリクト N 件（タップして解決）」バッジ**をタップすると
   Git パネルが開き、コンフリクト解決画面が起動すること（同期由来のコンフリクトは
   sentinel `__sync__` = `origin/<現ブランチ>` に対して解決される。libgit2 の
   `merge_endpoints` が sentinel をリモート追跡 ref へ解決する）。Git パネルの
   「コンフリクトの解決…」ランチャからブランチを選んで解決することもできる。
2. **コンフリクト解決画面（全画面モーダル）**が起動すること
   （`git_conflict_versions(root, source)` が base/ours/theirs の 3 版を読む。
   ワークツリーには一切触れない）。
3. **自動マージできたブロック**は「自動」バッジ付きで畳まれて表示されること
   （片側のみ変更・両側同一変更・別リスト項目の編集など）。
4. **本当に衝突したブロック**はカードで、**専門用語なし**の 3 択が出ること
   （ours/theirs/HEAD を出さない）:
   - 「**あなたの変更**」を残す
   - 「**相手の変更**」を残す
   - **「両方を残す（あなた → 相手）」**
5. Kanban ページのコンフリクトは、ブロック md が**カード風にプレビュー描画**されること
   （`renderPreviewHtml` 再利用）。
6. 全ブロック解決 →「**マージを完了**」で、連結 → `normalizeMarkdown` →
   `joinFrontmatter` → `git_merge_resolve(root, source, resolved)` が 2 親 merge commit を
   作り、**同期が自動再開（push まで）**すること。
7. **「中断」はいつでも可能**で、閉じてもワークツリーが無傷のまま保たれること。
8. 出力が常に canonical（`normalizeMarkdown` 冪等）であること — 解決後に diff が
   意味的最小になっていることを確認。

---

## 手順 F: モバイル PDF（`src/export/pdf.ts` / `EditorPane.tsx`）

プラットフォーム統一の印刷 API が無いため、ベストエフォート + 明示フォールバック。

1. エクスポートメニュー → **PDF** を選ぶ。
2. iOS（WKWebView, iOS 16+）で **`window.print()`** が印刷コントローラを出すこと。
   Android WebView は no-op のことがある（それでも致命ではない）。
3. 印刷が使えない/不発のとき、**「HTMLを書き出して共有」ボタン**
   （`EditorPane.tsx`、`saveExport`）から**自己完結型 HTML を書き出して OS の共有シート**に
   渡せること（`write_export_file` → 共有は OS 任せ）。
4. 書き出した HTML を他アプリ（メール/ファイル/ブラウザ）で開いて内容が正しいこと
   （CSS インライン・外部アセットなし・埋め込み解決済み）。

> デスクトップ PDF（一時ファイル `write_temp_file` → `file://` を WebviewWindow で開く +
> `tauri://error` → `window.open` フォールバック）は `tauri dev` で自動確認済み。

---

## 手順 G: 自動同期（`src/app/autosync.ts`、`.hakushi/config.json`）

設定は「同期設定…」内の**自動同期**セクション。config は `.hakushi/config.json`
（gitignore 済み）。既定: `onLaunch=true` / `intervalMin=null` / `afterCommit=false`。

1. **起動時同期（onLaunch、既定オン）**: リモート設定済み + ワークツリーが
   **クリーン**のときだけ、起動直後に 1 回 sync が走ること
   （`shouldAutoSyncOnLaunch` = `onLaunch && hasRemote && !dirty`）。
2. **定期同期（intervalMin、既定 null=オフ）**: 5〜60 分に設定すると**単一タイマー**で
   周期実行され、**ビジーポーリングにならない**こと（`setInterval`、多重起動は busy
   ガードで抑止）。設定変更でタイマーが張り替わること。
3. **dirty のときは自動同期をスキップ**すること（**勝手にコミットしない**）。
4. 自動同期が **conflicts** を返したときは**サイドバーにバッジ**が出るだけで、
   **モーダルは勝手に開かない**こと。バッジは**タップ可能**で、タップすると Git パネルが
   開いて ConflictResolver が起動する（手順 E-1b と同じ経路。自動でモーダルは開かない）。
5. 失敗は**サイレント**に扱い、ステータス行に結果が出ること（作業を邪魔しない）。

---

## 既知の制約（M8 スコープ、docs/dev/M7-M8-PLAN.md §4 / README v2 バックログ）

- **モバイルは fetch-only（pull）**: push / ブランチ切替 / マージはデスクトップ限定
  （gix 制約。UI は `capabilityNotice` で理由を表示）。
- **コンフリクト解決は libgit2 限定**（in-memory 3-way マージ）。モバイルは
  fetch-only 運用のため通常コンフリクトは発生しない。
- **OS レベルのバックグラウンド同期は未対応**（アプリ起動中のみ。BGTaskScheduler /
  WorkManager は Tauri プラグイン待ち → v2）。
- **Android の keyring は in-memory フォールバック**（再起動で PAT が消える）。
  恒久化は stronghold 移行 → v2。
- **モバイル PDF はベストエフォート**（`window.print()` + 共有フォールバック）。
  高品質印刷（Typst バックエンド）は v2。
- **ダークモード未対応**（現状ライトのみで一貫）→ v2。
