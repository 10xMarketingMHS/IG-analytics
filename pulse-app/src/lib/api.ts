const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";

// Absolute API base — needed for full-page navigations like the OAuth connect
// flow (where the browser, not fetch, hits the backend so cookies ride along).
export const API_BASE = API_URL;

export const ACTIVE_WORKSPACE_KEY = "pulse-workspace";

export function getActiveWorkspaceId(): string | null {
  return localStorage.getItem(ACTIVE_WORKSPACE_KEY);
}

export function setActiveWorkspaceId(id: string) {
  localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const workspaceId = getActiveWorkspaceId();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      // Scopes every data request to the active workspace (the switcher).
      ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
      ...options.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message =
      typeof body.error === "string" ? body.error : "Request failed";
    throw new ApiError(message, res.status);
  }

  return body as T;
}
