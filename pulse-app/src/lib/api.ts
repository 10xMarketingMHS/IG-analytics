// Dev: /api on the page's own address, passed to the API by the dev server
// (vite.config.ts), so each address keeps its own sign-in — for example
// superadmin.localhost:3000, admin.localhost:3000 and editor.localhost:3000 at once.
const API_URL = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "/api" : "http://localhost:4000/api");

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

// "Not signed in" from the server (the session ran out, the login was switched
// off, the password changed): the app signs out once instead of every open
// panel carrying on polling (lib/auth-context.tsx). Not for the sign-in calls.
const SIGNED_OUT = "pulse:signed-out";
export function onSignedOut(fn: (message: string) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<string>).detail ?? "");
  window.addEventListener(SIGNED_OUT, h);
  return () => window.removeEventListener(SIGNED_OUT, h);
}

// No answer at all (offline, or the server restarting or waking up), or one
// that isn't Pulse's: said plainly instead of a bare "Request failed".
export const NO_ANSWER = "Pulse's server didn't answer just now. Try again in a moment.";
export const noAnswer = (err: unknown) => err instanceof ApiError && (err.status === 0 || (err.status >= 500 && err.message === NO_ANSWER));

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
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        // Scopes every data request to the active workspace (the switcher).
        ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
        ...options.headers,
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(NO_ANSWER, 0);
  }

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message =
      typeof body.error === "string" ? body.error : res.status >= 500 ? NO_ANSWER : "Request failed";
    // The server says the work day isn't open (ended on another device, closed
    // automatically, or no plan yet) — let the shell re-check instead of
    // carrying on as if it were.
    if (res.status === 403 && /Press Start Work|Start your day first/.test(message)) {
      window.dispatchEvent(new Event("pulse:workday-changed"));
    }
    if (res.status === 401 && !path.startsWith("/auth/")) {
      window.dispatchEvent(new CustomEvent(SIGNED_OUT, { detail: message }));
    }
    throw new ApiError(message, res.status);
  }

  return body as T;
}
