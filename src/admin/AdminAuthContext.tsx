import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { doc, getDoc, onSnapshot, serverTimestamp, writeBatch } from "firebase/firestore";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { auth } from "../firebase/auth";
import { db, isFirebaseConfigured, useFirebaseEmulators } from "../firebase/config";
import type { AdminRole, AdminUser } from "./types";

// A bare username (no "@") signs in as <username>@lulua.local, so the local
// admin can log in as just "admin".
export function toAuthEmail(login: string): string {
  return login.includes("@") ? login : `${login}@lulua.local`;
}

// Firebase Auth rejects passwords under 6 characters. Only against the local
// emulators, short passwords are padded deterministically so a throwaway local
// login like "admin" works; the real backend always gets the password as typed.
function toAuthPassword(password: string): string {
  return useFirebaseEmulators && password.length < 6 ? password.padEnd(6, "~") : password;
}

interface AdminAuthContextValue {
  loading: boolean;
  firebaseUser: User | null;
  profile: AdminUser | null;
  bootstrapNeeded: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOutAdmin: () => Promise<void>;
  bootstrapOwner: (email: string, password: string, displayName: string) => Promise<void>;
  hasRole: (roles: AdminRole[]) => boolean;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AdminUser | null>(null);
  const [bootstrapNeeded, setBootstrapNeeded] = useState(false);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setLoading(false);
      return;
    }

    getDoc(doc(db, "system", "bootstrap")).then((snap) => {
      setBootstrapNeeded(!snap.exists());
    });

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      if (!user) {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => unsubAuth();
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured || !firebaseUser) return;

    setLoading(true);
    const unsubProfile = onSnapshot(
      doc(db, "admins", firebaseUser.uid),
      (snap) => {
        setProfile(snap.exists() ? ({ id: snap.id, ...snap.data() } as AdminUser) : null);
        setLoading(false);
      },
      () => {
        setProfile(null);
        setLoading(false);
      }
    );

    return () => unsubProfile();
  }, [firebaseUser]);

  const value = useMemo<AdminAuthContextValue>(
    () => ({
      loading,
      firebaseUser,
      profile,
      bootstrapNeeded,
      async signIn(email, password) {
        await signInWithEmailAndPassword(auth, toAuthEmail(email), toAuthPassword(password));
      },
      async signOutAdmin() {
        await firebaseSignOut(auth);
      },
      async bootstrapOwner(email, password, displayName) {
        email = toAuthEmail(email);
        const cred = await createUserWithEmailAndPassword(auth, email, toAuthPassword(password));
        await updateProfile(cred.user, { displayName });

        const batch = writeBatch(db);
        batch.set(doc(db, "admins", cred.user.uid), {
          email,
          displayName,
          role: "owner" satisfies AdminRole,
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        batch.set(doc(db, "system", "bootstrap"), { ownerClaimed: true, claimedAt: serverTimestamp() });
        await batch.commit();
        setBootstrapNeeded(false);
      },
      hasRole(roles) {
        return !!profile && profile.active && roles.includes(profile.role);
      },
    }),
    [loading, firebaseUser, profile, bootstrapNeeded]
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error("useAdminAuth must be used within AdminAuthProvider");
  return ctx;
}
