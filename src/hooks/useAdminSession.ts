import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth } from "../firebase/auth";
import { db, isFirebaseConfigured } from "../firebase/config";

export interface AdminSessionInfo {
  uid: string;
  displayName: string;
  email: string;
  role: string;
  // Multi-branch POS: a cashier's assigned branches (see AdminUser.branchIds).
  branchIds: string[];
}

// Lightweight, storefront-safe "is the current visitor a signed-in admin"
// check — mirrors the isAnyAdmin() Firestore rule exactly (active admins/
// {uid} doc), so a "yes" here always means the matching Firestore reads
// will actually succeed too. Used to gate admin-only UI that needs to
// appear outside the /admin route tree, without pulling in the heavier
// AdminAuthContext (built for the admin app's own login/redirect flow).
export function useAdminSession(): AdminSessionInfo | null {
  const [session, setSession] = useState<AdminSessionInfo | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured) return;
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user || user.isAnonymous) {
        setSession(null);
        return;
      }
      try {
        const snap = await getDoc(doc(db, "admins", user.uid));
        const data = snap.data();
        if (snap.exists() && data?.active) {
          setSession({ uid: user.uid, displayName: data.displayName ?? "", email: data.email ?? "", role: data.role ?? "", branchIds: Array.isArray(data.branchIds) ? data.branchIds : [] });
        } else {
          setSession(null);
        }
      } catch {
        setSession(null);
      }
    });
    return unsub;
  }, []);

  return session;
}
