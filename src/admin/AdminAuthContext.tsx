import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from "../db/auth";
import { doc, onSnapshot } from "../db/firestore";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { auth } from "../firebase/auth";
import { db, isBackendConfigured } from "../firebase/config";
import type { AdminRole, AdminUser } from "./types";

// A bare username (no "@") signs in as <username>@lulua.local, so the local
// admin can log in as just "admin".
export function toAuthEmail(login: string): string {
  return login.includes("@") ? login : `${login}@lulua.local`;
}

// Firebase Auth rejects passwords under 6 characters, so short passwords are
// padded deterministically: the owner's "admin" login works everywhere
// (stored as "admin~"). Passwords of 6+ characters are sent as typed.
function toAuthPassword(password: string): string {
  return password.length < 6 ? password.padEnd(6, "~") : password;
}

interface AdminAuthContextValue {
  loading: boolean;
  firebaseUser: User | null;
  profile: AdminUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOutAdmin: () => Promise<void>;
  hasRole: (roles: AdminRole[]) => boolean;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AdminUser | null>(null);

  useEffect(() => {
    if (!isBackendConfigured) {
      setLoading(false);
      return;
    }

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
    if (!isBackendConfigured || !firebaseUser) return;

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
      async signIn(email, password) {
        await signInWithEmailAndPassword(auth, toAuthEmail(email), toAuthPassword(password));
      },
      async signOutAdmin() {
        await firebaseSignOut(auth);
      },
      hasRole(roles) {
        return !!profile && profile.active && roles.includes(profile.role);
      },
    }),
    [loading, firebaseUser, profile]
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error("useAdminAuth must be used within AdminAuthProvider");
  return ctx;
}
