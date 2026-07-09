# リリース自動化 (CD) — Web / macOS / Windows / iOS / Android

`main` にマージが入るたびに [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
が動き、**リリースに値するコミットがあるときだけ** 5チャネルへ配信します。

## 仕組み

```
main へ merge
   │
   ▼
[version] semantic-release が Conventional Commits を解析
   │   feat: / fix: / perf: / BREAKING → 新バージョンを算出
   │   chore: / docs: / test: / ci: / refactor: → 何もせず終了(以降スキップ)
   │   ├─ scripts/sync-version.mjs で全設定へバージョン伝播
   │   ├─ その差分を main へ commit（"chore(release): X.Y.Z [skip ci]"）
   │   ├─ タグ vX.Y.Z を push
   │   └─ GitHub Release を作成
   ▼ (published == true のときだけ)
[web] ──── GitHub Pages へデプロイ（静的SPA）
[desktop] macOS(universal)/Windows/Linux の署名済みインストーラを Release へ添付
[ios] ──── TestFlight へアップロード（本番申請は手動）
[android] Google Play 内部テストへアップロード（本番昇格は手動）
```

### バージョンの単一の真実

`tauri.conf.json` の `version` が真実です。semantic-release が算出した番号を
[`scripts/sync-version.mjs`](../../scripts/sync-version.mjs) が以下へ伝播します:

| ファイル | 反映先 |
| --- | --- |
| `package.json` | `version` |
| `src-tauri/Cargo.toml` | `[package] version` |
| `src-tauri/Cargo.lock` | `hakushi` クレートの `version` |
| `src-tauri/tauri.conf.json` | `version`（Android の versionName/Code はここから Tauri が生成） |
| `src-tauri/gen/apple/project.yml` | `CFBundleShortVersionString` / `CFBundleVersion` |

ストアが要求する「毎回必ず増える」ビルド番号（iOS `CFBundleVersion` /
Android `versionCode`）は、iOS/Android ジョブが `BUILD_NUMBER=${{ github.run_number }}`
を渡して上書きします（コミットはしない、CI 限定）。

### コミット規約 (Conventional Commits)

| 接頭辞 | 例 | 上がる桁 |
| --- | --- | --- |
| `fix:` | `fix: 保存時のクラッシュを修正` | patch (0.1.0 → 0.1.1) |
| `feat:` | `feat: カレンダービューを追加` | minor (0.1.0 → 0.2.0) |
| `feat!:` / `BREAKING CHANGE:` 本文 | 破壊的変更 | major (0.1.0 → 1.0.0) |
| `chore:` `docs:` `ci:` `refactor:` `test:` `style:` | 雑務・文書 | **リリースなし** |

Squash マージ運用なら、PR タイトルを Conventional Commits にすると確実です。

## 前提となる GitHub 設定

1. **Pages**: リポジトリ Settings → Pages → Source = **GitHub Actions**。
2. **Actions 権限**: Settings → Actions → General → Workflow permissions =
   **Read and write**。
3. **main へのブッシュ許可**: main にブランチ保護をかけている場合、`version`
   ジョブが bump コミットを push できるよう、次のどちらかが必要です。
   - 保護ルールで GitHub Actions bot の push を許可する、または
   - `RELEASE_TOKEN`（`repo` 権限の PAT／fine-grained: Contents=write）を
     Secrets に登録する。未設定なら自動で `GITHUB_TOKEN` を使います。
   - bump コミットには `[skip ci]` が付くので再実行ループは起きません。

## 必要な Secrets（Settings → Secrets and variables → Actions）

### 共通（任意）
| Secret | 用途 |
| --- | --- |
| `RELEASE_TOKEN` | 保護された main へ bump を push する PAT（任意） |

### macOS 署名・公証（`desktop` / 未設定なら未署名ビルド）
| Secret | 用途 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 証明書 (.p12) の base64 |
| `APPLE_CERTIFICATE_PASSWORD` | 上記 .p12 のパスワード |
| `APPLE_SIGNING_IDENTITY` | 例: `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` / `APPLE_PASSWORD` | 公証用 Apple ID とアプリ用パスワード |
| `APPLE_TEAM_ID` | 10桁のチームID |

### Tauri 自動アップデータ署名（任意・`desktop`）
| Secret | 用途 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `tauri signer generate` の秘密鍵 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | その鍵のパスワード |

### iOS（`ios` → TestFlight）
| Secret | 用途 |
| --- | --- |
| `IOS_CERTIFICATE` | Apple Distribution 証明書 (.p12) の base64 |
| `IOS_CERTIFICATE_PASSWORD` | 上記 .p12 のパスワード |
| `IOS_PROVISIONING_PROFILE` | App Store 用プロビジョニングプロファイル (.mobileprovision) の base64 |
| `APPLE_TEAM_ID` | 開発チームID（署名に使用） |
| `APPLE_API_ISSUER_ID` | App Store Connect API の Issuer ID |
| `APPLE_API_KEY_ID` | 同 Key ID |
| `APPLE_API_PRIVATE_KEY` | 同 秘密鍵 (.p8) の中身 |

base64 化の例: `base64 -i dist.p12 | pbcopy`（macOS）。

### Android（`android` → Google Play 内部テスト）
| Secret | 用途 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | アップロード鍵ストア (.jks) の base64 |
| `ANDROID_KEYSTORE_PASSWORD` | ストアのパスワード |
| `ANDROID_KEY_ALIAS` | 鍵エイリアス |
| `ANDROID_KEY_PASSWORD` | 鍵のパスワード |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Play Console で発行したサービスアカウント JSON（Release マネージャ権限） |

Play 側は、対象アプリを一度手動で（またはドラフトで）作成し、`internal`
トラックを有効にしておく必要があります。`applicationId` は `dev.hakushi.app`。

## Web 版の性質

Web ビルドは **永続化された実 git バックエンド**（[`src/app/web-git/`](../../src/app/web-git/)）
で動作します。ファイルは IndexedDB（lightning-fs）に保存され**リロードしても消えず**、
コミット／履歴／ブランチは isomorphic-git による本物の git です。リモート同期は
**GitHub REST API 経由**（CORS プロキシ不要・完全クライアント）で行います。詳細と
制約は [WEB-GIT.md](WEB-GIT.md) を参照。旧 mock（[`tauri-mock.ts`](../../src/app/tauri-mock.ts)）は
vitest 専用に降格しています。

Google Cloud で独自ドメイン運用したい場合は、`web` ジョブを Firebase Hosting
（`FirebaseExtended/action-hosting-deploy`）に差し替え、`BASE_PATH` を `/` に
戻すだけで移行できます。

## 動作確認の手順

1. 上記 Secrets と GitHub 設定を投入。
2. `fix:` か `feat:` を含む PR を作って main にマージ。
3. Actions の `Release` を確認:
   - `version` が緑 → タグ `vX.Y.Z` と GitHub Release ができる。
   - `web` → Pages URL が更新。
   - `desktop` → Release にインストーラが添付。
   - `ios` → App Store Connect の TestFlight にビルド出現（処理に数分）。
   - `android` → Play Console の内部テストにビルド出現。
4. 初回はモバイル署名の識別子（プロファイル名／IPA 出力パス）で失敗しがち
   です。ログを見て `app-path`（`src-tauri/gen/apple/build/arm64/Hakushi.ipa`）や
   AAB 検出パスを実際の出力に合わせて調整してください。

## ローカル確認

```bash
# 次に上がるバージョンをドライラン表示（push はしない）
npx semantic-release --dry-run

# 任意バージョンを全ファイルへ手動反映
npm run sync-version -- 1.2.3
```
