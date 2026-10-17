import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth, ApiError } from "@/lib/auth-context";
import { api } from "@/lib/api";

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // My Day is the landing page; a deep link the user was bounced from wins.
  const redirectTo = searchParams.get("redirectTo") ?? "/home";

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // "Forgot password?" — Pulse can't email anyone, so this asks the admin to set
  // a temporary password (they see the request in Activity and Team › Roster).
  const [forgot, setForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  if (!loading && user) {
    return <Navigate to={redirectTo} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const formData = new FormData(event.currentTarget);
    try {
      await login(String(formData.get("email")), String(formData.get("password")));
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed.");
    } finally {
      setPending(false);
    }
  }

  async function handleForgot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const formData = new FormData(event.currentTarget);
    try {
      await api("/auth/forgot", { method: "POST", body: JSON.stringify({ email: String(formData.get("email")) }) });
      setForgotSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send the request. Try again.");
    } finally {
      setPending(false);
    }
  }

  function showSignIn() {
    setForgot(false);
    setForgotSent(false);
    setError(null);
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="logo">◐</div>
        <h2>{forgot ? "Forgot your password?" : "Welcome to Pulse"}</h2>
        <p>{forgot ? "Your admin will set a temporary password for you." : "Content analytics for DF Foods"}</p>
        {!forgot ? (
          <>
            <form onSubmit={handleSubmit}>
              <input name="email" type="email" placeholder="Email" required autoComplete="email" />
              <input
                name="password"
                type="password"
                placeholder="Password"
                required
                autoComplete="current-password"
              />
              {error && <p className="login-err">{error}</p>}
              <button className="btn btn-primary" type="submit" disabled={pending}>
                {pending ? "Signing in…" : "Sign in"}
              </button>
            </form>
            <button type="button" className="linkbtn login-forgot" onClick={() => { setForgot(true); setError(null); }}>
              Forgot password?
            </button>
          </>
        ) : forgotSent ? (
          <>
            <div className="login-note">
              Request sent. If that email has a Pulse login, your admin has been told. They'll give you a
              temporary password — once you're in, change it under My Profile.
            </div>
            <button type="button" className="linkbtn login-forgot" onClick={showSignIn}>← Back to sign in</button>
          </>
        ) : (
          <>
            <form onSubmit={handleForgot}>
              <input name="email" type="email" placeholder="The email you sign in with" required autoComplete="email" />
              {error && <p className="login-err">{error}</p>}
              <button className="btn btn-primary" type="submit" disabled={pending}>
                {pending ? "Sending…" : "Ask my admin to reset it"}
              </button>
            </form>
            <button type="button" className="linkbtn login-forgot" onClick={showSignIn}>← Back to sign in</button>
          </>
        )}
      </div>
    </div>
  );
}
