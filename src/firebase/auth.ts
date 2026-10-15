import { connectAuthEmulator, type Auth, getAuth } from "firebase/auth";
import { emulatorPorts, firebaseApp, isFirebaseConfigured, useFirebaseEmulators } from "./config";

export const auth = (isFirebaseConfigured ? getAuth(firebaseApp) : undefined) as Auth;

// See config.ts's useFirebaseEmulators for what this flag is and why it's
// off by default. Admin sign-in needs the Auth emulator too, not just
// Firestore's, whenever it's on -- otherwise the admin login screen would
// authenticate against the real project while every Firestore read/write
// after it hit the local emulator instead, an inconsistent split.
if (isFirebaseConfigured && useFirebaseEmulators) {
  connectAuthEmulator(auth, `http://127.0.0.1:${emulatorPorts.auth}`, { disableWarnings: true });
}
