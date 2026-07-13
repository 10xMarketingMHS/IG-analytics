import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export type Workspace = {
  id: string;
  name: string;
  logo_url: string | null;
  role?: "admin" | "editor" | "viewer";
};

type WorkspacesContextValue = {
  workspaces: Workspace[];
  active: Workspace | null;
  isAdmin: boolean;
  loading: boolean;
  switchTo: (id: string) => void;
  createWorkspace: (name: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
};

const WorkspacesContext = createContext<WorkspacesContextValue | undefined>(undefined);

export function WorkspacesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(getActiveWorkspaceId());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { workspaces } = await api<{ workspaces: Workspace[] }>("/workspaces");
    setWorkspaces(workspaces);
    // Resolve the active workspace: stored one if still valid, else the first.
    const stored = getActiveWorkspaceId();
    const resolved =
      (stored && workspaces.find((w) => w.id === stored)?.id) ||
      workspaces[0]?.id ||
      null;
    if (resolved) {
      setActiveWorkspaceId(resolved);
      setActiveId(resolved);
    }
    return workspaces;
  }, []);

  useEffect(() => {
    if (!user) {
      setWorkspaces([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user, load]);

  // Persist the selection, then hard-reload so every page re-fetches its data
  // under the newly active workspace (guarantees full isolation, no stale data).
  const switchTo = useCallback(
    (id: string) => {
      if (id === activeId) return;
      setActiveWorkspaceId(id);
      window.location.assign("/dashboard");
    },
    [activeId],
  );

  const createWorkspace = useCallback(async (name: string) => {
    const { workspace } = await api<{ workspace: Workspace }>("/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    setActiveWorkspaceId(workspace.id);
    window.location.assign("/dashboard");
  }, []);

  const renameWorkspace = useCallback(
    async (id: string, name: string) => {
      await api(`/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await load();
    },
    [load],
  );

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0] ?? null;
  const isAdmin = active?.role === "admin";

  return (
    <WorkspacesContext.Provider
      value={{ workspaces, active, isAdmin, loading, switchTo, createWorkspace, renameWorkspace }}
    >
      {children}
    </WorkspacesContext.Provider>
  );
}

export function useWorkspaces() {
  const ctx = useContext(WorkspacesContext);
  if (!ctx) throw new Error("useWorkspaces must be used within a WorkspacesProvider");
  return ctx;
}
