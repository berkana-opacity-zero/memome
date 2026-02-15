# MemoMe (React + Firebase)

Memo app that syncs across devices with Google login and Firestore.

## 1. Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill values in `.env.local` from Firebase Console:
- Firebase project settings -> Your apps -> Web app config

Required keys:
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`

## 2. Firebase console settings

### Authentication
1. Go to Authentication -> Sign-in method
2. Enable Google provider

### Firestore Database
1. Create database in production mode
2. Apply rules from `firestore.rules`:

```bash
firebase deploy --only firestore:rules
```

No manual collection creation is needed. A `notes` collection is auto-created when the first note is added.

## 3. Vercel deploy

1. Push this folder to your GitHub memo repository
2. Import the repo in Vercel
3. Add all `VITE_FIREBASE_*` variables in Project Settings -> Environment Variables
4. Deploy

## Scripts

- `npm run dev`: start local dev server
- `npm run build`: production build
- `npm run preview`: preview built app
- `npm run lint`: run ESLint
