# Testing

## Firestore security rules

Rules changes are covered by an automated test suite that runs against the real Firestore engine via the Firebase Emulator Suite — not mocked. This is the primary safety net for anything touching `firestore.rules`, especially the checkout/stock-decrement logic, since the app has no backend server to fall back on.

**One-time setup:** the emulator needs a local Java runtime. This project uses a portable JDK (no admin install required) at `C:\Users\USER\AppData\Local\java-jdk21\jdk-21.0.12+8`, already added to this Windows user's PATH. If running on a different machine, install any JDK 11+ and make sure `java -version` works.

**Run the tests:**

```powershell
# Terminal 1 — start the emulators (leave running)
npx firebase emulators:start --only firestore,auth --project sisley-rules-test

# Terminal 2 — run the rules test suite
npm run test:rules
```

Tests live in `tests/rules/*.test.ts`, using `@firebase/rules-unit-testing`. `tests/rules/setup.ts` connects to the emulator at `127.0.0.1:8080` (Firestore) — no real Firebase project or network access is touched by these tests.

Add a new `*.test.ts` file per collection/feature as rules grow (e.g. `orders.test.ts` for the checkout stock-decrement rules in Phase 3).
