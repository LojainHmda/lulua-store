import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  linkWithCredential,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
} from "../db/auth";
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from "../db/firestore";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AdminCustomer } from "../admin/types";
import { auth } from "../firebase/auth";
import { db, isBackendConfigured } from "../firebase/config";

function isIdentified(user: User | null): boolean {
  return !!user && !user.isAnonymous;
}

interface CustomerAuthContextValue {
  loading: boolean;
  firebaseUser: User | null;
  profile: AdminCustomer | null;
  isSignedIn: boolean;
  signInOpen: boolean;
  openSignIn: () => void;
  closeSignIn: () => void;
  ensureGuestSession: () => Promise<User>;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string, name: string) => Promise<void>;
  signOutCustomer: () => Promise<void>;
}

const CustomerAuthContext = createContext<CustomerAuthContextValue | null>(null);

// signUpWithEmail's own updateProfile(displayName) call races the reactive
// effect below (which fires on the same auth-state change and may create the
// Firestore doc first, before displayName has actually landed on the user
// object) — set synchronously before any await in signUpWithEmail so it's
// already in place no matter which side wins that race.
let pendingSignupName: string | null = null;

async function ensureProfileDoc(user: User): Promise<void> {
  const ref = doc(db, "customers", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(ref, {
    uid: user.uid,
    authProvider: user.providerData[0]?.providerId === "google.com" ? "google" : "password",
    photoURL: user.photoURL ?? undefined,
    name: pendingSignupName ?? user.displayName ?? "",
    email: user.email ?? "",
    ordersCount: 0,
    totalSpent: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export function CustomerAuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AdminCustomer | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);

  useEffect(() => {
    if (!isBackendConfigured) {
      setLoading(false);
      return;
    }
    const unsub = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      if (!isIdentified(user)) {
        setProfile(null);
        setLoading(false);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!isBackendConfigured || !isIdentified(firebaseUser)) return;
    setLoading(true);
    ensureProfileDoc(firebaseUser!).catch(() => {});
    const unsub = onSnapshot(
      doc(db, "customers", firebaseUser!.uid),
      (snap) => {
        setProfile(snap.exists() ? ({ id: snap.id, ...snap.data() } as AdminCustomer) : null);
        setLoading(false);
      },
      () => {
        setProfile(null);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [firebaseUser]);

  useEffect(() => {
    if (isIdentified(firebaseUser)) setSignInOpen(false);
  }, [firebaseUser]);

  const value = useMemo<CustomerAuthContextValue>(
    () => ({
      loading,
      firebaseUser,
      profile,
      isSignedIn: isIdentified(firebaseUser),
      signInOpen,
      openSignIn: () => setSignInOpen(true),
      closeSignIn: () => setSignInOpen(false),
      async ensureGuestSession() {
        // Firebase Auth restores a persisted session asynchronously; if this
        // runs before that finishes, auth.currentUser reads null even for an
        // already-signed-in customer, so this used to sign them in anonymously
        // on top of their real session — silently detaching whatever order
        // they placed from their account. authStateReady() waits for the
        // real restored state before deciding whether a guest session is
        // actually needed.
        await auth.authStateReady();
        if (auth.currentUser) return auth.currentUser;
        const cred = await signInAnonymously(auth);
        return cred.user;
      },
      async signInWithGoogle() {
        const provider = new GoogleAuthProvider();
        if (auth.currentUser?.isAnonymous) {
          try {
            await linkWithPopup(auth.currentUser, provider);
            return;
          } catch (err) {
            if ((err as { code?: string }).code !== "auth/credential-already-in-use") throw err;
          }
        }
        await signInWithPopup(auth, provider);
      },
      async signInWithEmail(email, password) {
        await signInWithEmailAndPassword(auth, email, password);
      },
      async signUpWithEmail(email, password, name) {
        pendingSignupName = name;
        try {
          if (auth.currentUser?.isAnonymous) {
            const credential = EmailAuthProvider.credential(email, password);
            try {
              const linked = await linkWithCredential(auth.currentUser, credential);
              await updateProfile(linked.user, { displayName: name });
              return;
            } catch (err) {
              if ((err as { code?: string }).code !== "auth/credential-already-in-use") throw err;
            }
          }
          const cred = await createUserWithEmailAndPassword(auth, email, password);
          await updateProfile(cred.user, { displayName: name });
        } finally {
          pendingSignupName = null;
        }
      },
      async signOutCustomer() {
        await firebaseSignOut(auth);
      },
    }),
    [loading, firebaseUser, profile, signInOpen]
  );

  return <CustomerAuthContext.Provider value={value}>{children}</CustomerAuthContext.Provider>;
}

export function useCustomerAuth() {
  const ctx = useContext(CustomerAuthContext);
  if (!ctx) throw new Error("useCustomerAuth must be used within CustomerAuthProvider");
  return ctx;
}
