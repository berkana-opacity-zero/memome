# MemoMe（React + Firebase）

Googleログインと Firestore でデバイス間同期するメモアプリです。

## 1. ローカルセットアップ

```bash
npm install
cp .env.example .env.local
npm run dev
```

Firebaseコンソールから `.env.local` に値を設定してください。
- 「プロジェクト設定」->「マイアプリ」->「ウェブアプリ設定（Web app config）」

必要なキー:
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`

## 2. Firebaseコンソール設定

### 認証設定
1. 「Authentication」->「Sign-in method」を開く
2. Google プロバイダを有効化する

### Firestore データベース
1. 本番モードでデータベースを作成する
2. `firestore.rules` を適用する:

```bash
firebase deploy --only firestore:rules
```

コレクションを手動作成する必要はありません。最初のメモ追加時に `notes` コレクションが自動作成されます。

## 3. Vercelデプロイ

1. このフォルダを GitHub のメモ用リポジトリに push する
2. Vercel でリポジトリをインポートする
3. 「Project Settings」->「Environment Variables」に `VITE_FIREBASE_*` をすべて設定する
4. デプロイする

## 4. アプリとしてインストール（PWA）

- スマホ: ブラウザメニューから「ホーム画面に追加」
- PC（Chrome/Edge）: アドレスバーのインストールアイコン、またはメニューからインストール
- PC（Safari / macOS）: 「Dockに追加」

## スクリプト

- `npm run dev`: ローカル開発サーバーを起動
- `npm run build`: 本番ビルドを作成
- `npm run preview`: ビルド結果をローカルで確認
- `npm run lint`: ESLint を実行
