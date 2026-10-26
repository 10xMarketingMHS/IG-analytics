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
import { PERM_PAGE, type PageAccess, type PageKey } from "@/lib/page-access";

// Per-user permission grants (Settings → Access) — additive on top of role.
// Keep in sync with server/src/permissions.js PERMISSION_KEYS.
export type PermissionKey =
  | "create_post"
  | "goal_setting_access"
  | "task_settings"
  | "channels"
  | "content_taxonomy"
  | "access_manage"
  | "assign_tasks"
  | "resolve_tasks"
  | "hold_tasks"
  | "edit_goals"
  | "discipline";

export type Workspace = {
  id: string;
  name: string;
  logo_url: string | null;
  role?: "admin" | "editor" | "viewer";
  // Active grants the current user holds in this workspace's org.
  permissions?: PermissionKey[];
};

type WorkspacesContextValue = {
  workspaces: Workspace[];
  active: Workspace | null;
  isAdmin: boolean;
  // True if the caller is an admin OR holds an active grant for `key` — or,
  // once their position's Page access row is saved, if that row has the page's
  // tick (or they hold the grant). The real gate is server-side; this only
  // drives UI affordance.
  hasPermission: (key: PermissionKey) => boolean;
  // Page access (Settings › Page access): the caller's own row, null while loading
  pageAccess: PageAccess | null;
  // May they see / change this page? A saved row decides; otherwise `today`, the rule before the grid.
  pageRule: (key: PageKey, mode: "see" | "change", today: boolean) => boolean;
  loading: boolean;
  switchTo: (id: string) => void;
  createWorkspace: (name: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  refresh: () => Promise<Workspace[]>;
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
      window.location.assign("/analytics");
    },
    [activeId],
  );

  const createWorkspace = useCallback(async (name: string) => {
    const { workspace } = await api<{ workspace: Workspace }>("/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    setActiveWorkspaceId(workspace.id);
    window.location.assign("/analytics");
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
  // the caller's Page access row, read again for each workspace
  const [pageAccess, setPageAccess] = useState<PageAccess | null>(null);
  useEffect(() => {
    if (!user || !active?.id) { setPageAccess(null); return; }
    let off = false;
    api<PageAccess>("/page-access/me").then((p) => { if (!off) setPageAccess(p); }).catch(() => { if (!off) setPageAccess(null); });
    return () => { off = true; };
  }, [user, active?.id]);
  const rowTicks = pageAccess && !pageAccess.super ? pageAccess.pages : null;
  const pageRule = useCallback(
    (key: PageKey, mode: "see" | "change", today: boolean) => (pageAccess?.super ? true : rowTicks ? !!rowTicks[key]?.[mode] : today),
    [pageAccess?.super, rowTicks],
  );
  const hasPermission = useCallback(
    (key: PermissionKey) => {
      const granted = active?.permissions?.includes(key) ?? false;
      const page = PERM_PAGE[key];
      if (page && rowTicks) return granted || !!rowTicks[page.key]?.[page.mode];
      return isAdmin || granted;
    },
    [isAdmin, active?.permissions, rowTicks],
  );

  return (
    <WorkspacesContext.Provider
      value={{ workspaces, active, isAdmin, hasPermission, pageAccess, pageRule, loading, switchTo, createWorkspace, renameWorkspace, refresh: load }}
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
