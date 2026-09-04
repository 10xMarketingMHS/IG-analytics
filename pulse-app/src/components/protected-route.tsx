import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { Loader } from "@/components/loader";

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

  return <Outlet />;
}
