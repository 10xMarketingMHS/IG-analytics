import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError } from "@/lib/api";
import { clearResourceCache } from "@/lib/use-resource";

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
    setUser(user);
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    clearResourceCache();
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
