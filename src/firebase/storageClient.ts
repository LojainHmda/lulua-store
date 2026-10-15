import { connectStorageEmulator, type FirebaseStorage, getStorage } from "firebase/storage";
import { emulatorPorts, firebaseApp, isFirebaseConfigured, useFirebaseEmulators } from "./config";

export const storage = (isFirebaseConfigured ? getStorage(firebaseApp) : undefined) as FirebaseStorage;

// Same opt-in as Firestore/Auth (see config.ts): uploads go to the local
// Storage emulator instead of a real bucket.
if (isFirebaseConfigured && useFirebaseEmulators) {
  connectStorageEmulator(storage, "127.0.0.1", emulatorPorts.storage);
}
