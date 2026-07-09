# Web 版の実 git バックエンド（サーバーレス）

ブラウザ版 Hakushi を、**永続化された本物の git** で動かし、**サーバー（CORS
プロキシ）無しで GitHub と同期**するための実装。旧 `tauri-mock.ts`（非永続・擬似
git）を production web で置き換える。

## 構成

| レイヤ | 実装 | ファイル |
| --- | --- | --- |
| 永続ストレージ | lightning-fs（IndexedDB） | [`web-git/store.ts`](../../src/app/web-git/store.ts) |
| ローカル git | isomorphic-git（実 blob/tree/commit） | 同上 |
| リモート同期 | GitHub REST/Git Data API | [`web-git/github.ts`](../../src/app/web-git/github.ts) |
| collab 同期 | `refs/hakushi/*` を Git Data API で和集合マージ | 同上 |
| バックエンド組立 | `WorkspaceBackend` 40 メソッド | [`web-git/backend.ts`](../../src/app/web-git/backend.ts) |

バックエンド選択（[`workspace.ts`](../../src/app/workspace.ts) の `backend()`）:

```
isTauri()                    -> tauriBackend      (libgit2 / gix)
else typeof indexedDB!=undef -> webGitBackend     (実ブラウザ = 本番 web)
else                         -> mockBackend       (jsdom / vitest)
```

ストレージは2つの lightning-fs ルート:
- `/hakushi` … git 作業ツリー（`.md` ページ＋`.git`＋`.gitignore`）。
  `.hakushi/`（自動同期設定などのローカル専用キャッシュ）はシードされる
  `.gitignore` で除外され、ワークツリーを汚さない。
- `/hakushi-meta` … 非 git のメタ情報（collab ログ、同期状態、ベースキャッシュ）。

## なぜ CORS プロキシ無しで動くのか

ブラウザから `github.com` の git スマート HTTP を直接叩くと、GitHub が CORS
ヘッダを返さないためブラウザが遮断する（クライアントだけでは回避不能）。一方
`api.github.com` は CORS を許可しているので、**blob → tree → commit → ref** を
API で作成すれば、プロキシ無し・PAT だけで push/pull 相当が成立する。git の
オブジェクトは内容アドレス（SHA-1）で決まるため、ローカル（isomorphic-git）と
リモート（GitHub）のオブジェクトは自然に一致する。

## 空リポジトリの初回同期（重要な GitHub API の罠）

**GitHub はコミット 0 件のリポジトリで Git Data API 全体を 409
"Git Repository is empty." で拒否する**（ref 取得だけでなく tree/blob/commit の
作成も。実 API で確認済み）。そのため初回同期は:

1. `GET /git/ref/heads/<branch>` が 409 → 空リポジトリと判定
2. **Contents API**（空リポジトリでも使える唯一の書込み経路）で
   `README.md`（`# <リポジトリ名>`、メッセージ "Hakushi: initial commit"）の
   初期コミットを作成
3. 以降は通常フロー: その初期コミットをリモート head として 3-way マージ →
   Git Data API で snapshot push（README はローカルにも取り込まれる）

## 同期モデル

- **1 同期 = 1 スナップショットコミット。** 未コミットのローカル変更は同期前に
  「同期前のローカル変更」として自動コミットされ、リモート取込は "Sync from
  remote" コミットになる（ユーザー編集とリモート変更が同一コミットに混ざらない）。
- **同期ベースはブランチ別**（`baseByBranch`）。ベースの tree はメタ側に
  キャッシュし、blob の再取得を避ける。
- **コンフリクト時はベースを前進させない。** マージ結果（非コンフリクト分を含む
  全ツリー）は `pendingMerge` として保持し、解決時にまとめて適用・コミット・
  ベース前進する。解決後の再同期でリモート側変更が巻き戻ることはない。
- **非テキストは常にパススルー。** バイナリ（UTF-8 で解釈できない blob）・
  シンボリックリンク・実行ビット・サブモジュールは sha 参照のまま push ツリーに
  乗せる（取込・マージ・再エンコードは一切しない）ので、同期で壊れない。
- 新規ブランチの初回 push はデフォルトブランチ head を親にする（orphan に
  しない — GitHub の compare / PR が機能する）。
- 全ファイル削除は空ツリー oid（`4b825dc…`）でコミット（`tree: []` は GitHub が
  拒否する）。`recursive=1` の tree 一覧が truncated の場合は誤削除を避けるため
  同期を拒否する。レート制限（403/429）は日本語メッセージに変換。

## collab（Issue/PR）の同期

デスクトップと同じワイヤフォーマット（INTERFACES.md §10.1/§11.3）:
`refs/hakushi/issues|prs/<ulid>` → 空ツリーコミットのチェーン、メッセージ =
canonical JSON 1 行（キー順 v,type,ts,author,data・data キーはソート・author
名はイベント由来・email は `hakushi@local` 固定・タイムスタンプはイベント ts）。

Web 側はローカルの JSONL ログとリモートチェーンの**イベント集合**を突き合わせ:
- リモートにだけあるイベント → ローカル JSONL に取込（`merged` にカウント）
- ローカルにだけあるイベント → チェーンを決定論的に再構築して force push
- チェーン先端 sha はメタにキャッシュし、変化がなければウォークしない

決定論的な再構築ルールが Rust 側 `collab/sync.rs` と一致しているため、
デスクトップと Web が同じリポジトリを共有しても収束する。

## 使い方（利用者）

1. GitHub で PAT（fine-grained: 対象リポジトリの Contents = read/write）を発行。
2. アプリの同期設定で **リモート URL** と**トークン**を入力。URL は
   `https://github.com/OWNER/REPO` / `OWNER/REPO` / `git@github.com:…` の
   いずれでもよい（保存時に https 形式へ正規化される。GitHub 以外は保存時に
   エラー）。
3. 「同期」を押す。空リポジトリなら自動で初期化される。

## 認証（PAT）の扱い

トークンは **セッション限定（メモリのみ）**。IndexedDB にも localStorage にも
保存しないため、リロード／タブを閉じると再入力が必要。これはブラウザに安全な
鍵保管庫が無いことへの意図的なトレードオフ（XSS 露出面を最小化）。リロード後の
起動時自動同期はトークン未保存を検知して**静かにスキップ**する（エラーバナーは
出さない）。

## 正直な制約（現行スコープ）

- **GitHub 専用。** GitLab／自前 git は CORS プロキシが要るため対象外。
- **ローカルの複数コミット履歴はリモートへ再生されない**（スナップショット
  モデル）。履歴はローカル git に残るが、リモートには同期 1 回 = 1 コミット。
- lightning-fs のメタデータ書込みは 500ms デバウンスされるため、書込み直後に
  タブを閉じると直近の変更が失われる可能性がある（lightning-fs の仕様）。
- コンフリクトの `pendingMerge` はメモリのみ。解決前にリロードした場合は
  再同期すれば同じコンフリクトが再検出される（情報は失われない）。
- レート制限: 認証済み GitHub API は 5,000 req/時。ノート用途では十分。

## テスト・検証状況

- `github.test.ts`: 空リポジトリのブートストラップ、report kind の対応
  （pull-only/push-only/コンフリクト）、ベース前進の抑止、バイナリ/シンボリック
  リンクのパススルー、空ツリー push、truncated 拒否、collab の
  canonical 化・和集合マージ・チェーン再構築・tip キャッシュ、を fetch
  スタブで検証（vitest）。
- GitHub 実 API（空リポジトリでの各 409、Contents API ブートストラップ、
  空ツリーコミット、`refs/hakushi/*` の作成/列挙/削除）は `gh api` で実機確認済み。
- ブラウザ実機（vite dev + 実 IndexedDB）で、忠実な GitHub API エミュレータを
  使った通し検証済み: 初回同期（空リポジトリ初期化）→ push-only → pull-only →
  コンフリクト検出/解決/再同期 → Issue/PR の双方向同期・分岐チェーン収束。
- 実 PAT + 実リポジトリでの最終確認は手動チェック（同期設定に PAT を入れて
  「同期」を 1 回押す）。
