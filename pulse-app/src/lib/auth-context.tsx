import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { api, ApiError, onSignedOut } from "@/lib/api";
import { clearResourceCache } from "@/lib/use-resource";
import { clearTaskAlerts } from "@/lib/use-task-alerts";
import { setActivitySeenUser } from "@/lib/activity-seen";

// Everything kept in memory for whoever was signed in: gone when they go, so
// the next person on this browser never sees it, even for a moment.
function forgetSignedInData() {
  clearResourceCache();
  clearTaskAlerts();
}

// name/imageUrl/color are the user's own self-service profile (see
// PATCH /users/me) — independent of the editor roster record editorId may
// point to. All null until the person sets them.
type AuthUser = {
  id: string;
  email: string;
  editorId: string | null;
  name: string | null;
  imageUrl: string | null;
  color: string | null;
  // Which in-app alerts they get (Settings › Notifications); a missing key is on.
  notifyPrefs?: Record<string, boolean>;
  isSuperAdmin?: boolean;
  // Set while a Super Admin views Echo as this person (read-only): who they really are.
  viewingAs?: { id: string; name: string } | null;
};

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  // Re-pull the current user (e.g. after saving profile changes) without a
  // full page reload.
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const signedIn = useRef(false);
  signedIn.current = !!user;
  // the bell's "seen up to" mark is each person's own
  setActivitySeenUser(user?.id ?? "");

  // The server stopped accepting this session (it ran out, the login was
  // switched off, the password changed): sign out here once, which also stops
  // every panel asking, and say why.
  useEffect(() => onSignedOut((message) => {
    if (!signedIn.current) return;
    signedIn.current = false;
    forgetSignedInData();
    setUser(null);
    toast(/^(Not signed in|Session expired)$/.test(message) ? "Your session has ended. Please sign in again." : message || "Please sign in again.");
  }), []);

  useEffect(() => {
    api<{ user: AuthUser }>("/auth/me")
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const { user } = await api<{ user: AuthUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    forgetSignedInData();
    setUser(user);
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    forgetSignedInData();
    setUser(null);
  }

  async function refreshUser() {
    const { user } = await api<{ user: AuthUser }>("/auth/me");
    setUser(user);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

export { ApiError };
