import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { Loader } from "@/components/loader";
import { EodProvider } from "@/lib/eod-context";
import { EodGate } from "@/components/eod-gate";

export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <Loader fullscreen size={200} />;
  }

  if (!user) {
    return (
      <Navigate
        to={`/login?redirectTo=${encodeURIComponent(location.pathname)}`}
        replace
      />
    );
  }

  // Everything authenticated lives behind the EOD gate: editors must clock in
  // before any route is reachable; admins/viewers pass straight through.
  return (
    <EodProvider>
      <EodGate>
        <Outlet />
      </EodGate>
    </EodProvider>
  );
}
