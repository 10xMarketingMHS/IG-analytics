import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth, ApiError } from "@/lib/auth-context";
import { api, noAnswer } from "@/lib/api";
import { EchoRun } from "@/components/echo-run";
import { EchoMark } from "@/components/echo-logo";
import { ParticleField } from "@/components/particle-field";
import { useTheme } from "@/components/theme-provider";
import "./login.css";

// The sign-in screen (login.css), full screen: on the left, rings of small
// coloured dashes turning slowly and stepping aside around the pointer
// (components/particle-field.tsx), a glow under it, and a mini game to play
// (components/echo-run.tsx); the form on the right. One column on phones.

const EYE = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
  </svg>
);
const SUN = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const MOON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);
const EYE_OFF = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.4 3.3M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
  </svg>
);

// The light under the pointer: the glow (.lg-glow) glides after it, eased the
// same at any frame rate and moved with a transform, so following the pointer
// repaints nothing; data-lit while the pointer is over the panel. Still (at
// its resting place) for reduced motion.
function usePointerLight(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    const glow = el?.querySelector<HTMLElement>(".lg-glow");
    if (!el || !glow || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const REST = { x: 0.3, y: 0.42 };                    // where the CSS puts it
    const t = { ...REST }, c = { ...t };
    let w = el.clientWidth, h = el.clientHeight, raf = 0, last = 0;
    const paint = () => {
      glow.style.transform = `translate3d(${((c.x - REST.x) * w).toFixed(1)}px,${((c.y - REST.y) * h).toFixed(1)}px,0)`;
    };
    const tick = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const k = 1 - Math.exp(-6 * dt);
      let moving = false;
      for (const key of ["x", "y"] as const) {
        c[key] += (t[key] - c[key]) * k;
        if (Math.abs(t[key] - c[key]) > 0.0005) moving = true;
      }
      paint();
      if (moving) raf = requestAnimationFrame(tick);
      else { raf = 0; last = 0; }
    };
    const go = () => { if (!raf) raf = requestAnimationFrame(tick); };
    const ro = new ResizeObserver(() => { w = el.clientWidth; h = el.clientHeight; paint(); });
    ro.observe(el);
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      el.toggleAttribute("data-lit", inside);
      if (inside) { t.x = clamp((e.clientX - r.left) / r.width); t.y = clamp((e.clientY - r.top) / r.height); }
      else { t.x = REST.x; t.y = REST.y; }
      go();
    };
    const onLeave = () => { el.removeAttribute("data-lit"); Object.assign(t, REST); go(); };
    paint();
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [ref]);
}

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // My Day is the landing page; a deep link the user was bounced from wins.
  const redirectTo = searchParams.get("redirectTo") ?? "/home";

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showPass, setShowPass] = useState(false);
  // "Forgot password?" — Echo can't email anyone, so this asks the admin to set
  // a temporary password (they see the request in Activity and Team › Roster).
  const [forgot, setForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const art = useRef<HTMLDivElement>(null);
  usePointerLight(art);
  // light or dark: the same choice as the theme menu inside the app (this browser)
  const { theme, toggle } = useTheme();

  if (!loading && user) {
    return <Navigate to={redirectTo} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email")), password = String(formData.get("password"));
    try {
      try {
        await login(email, password);
      } catch (err) {
        // the server didn't answer (restarting, waking up): once more, a moment later
        if (!noAnswer(err)) throw err;
        await new Promise((r) => setTimeout(r, 1500));
        await login(email, password);
      }
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
    <div className="lg-screen">
      <div className="lg-card">
        <div className="lg-art" ref={art}>
          <div className="lg-light" aria-hidden="true">
            <ParticleField className="lg-particles" />
            <span className="lg-glow" />
            <span className="lg-grain" />
          </div>
          <span className="lg-mark" aria-hidden="true"><EchoMark /></span>
          <EchoRun />
          <div className="lg-pitch">
            <span>Echo</span>
            <b>Your team’s content, tasks and goals in one place</b>
          </div>
        </div>

        <div className="lg-side">
          <div className="lg-theme" role="radiogroup" aria-label="Theme">
            {([["light", "Light", SUN], ["dark", "Dark", MOON]] as const).map(([t, label, icon]) => (
              <button key={t} type="button" role="radio" aria-checked={theme === t} aria-label={label} title={`${label} mode`}
                onClick={() => { if (theme !== t) toggle(); }}>
                {icon}
              </button>
            ))}
          </div>
          <div className="lg-form">
            <EchoMark className="lg-logo" />
            <h1>{forgot ? "Forgot your password?" : "Welcome back"}</h1>
            <p className="lg-sub">
              {forgot ? "Your admin will set a temporary password for you." : "Sign in to Echo to pick up where you left off."}
            </p>

            {!forgot ? (
              <form onSubmit={handleSubmit}>
                <label htmlFor="lg-email">Your email</label>
                <input id="lg-email" className="lg-in" name="email" type="email" placeholder="you@company.com" required autoComplete="email" autoFocus />
                <div className="lg-labelrow">
                  <label htmlFor="lg-pass">Password</label>
                  <button type="button" className="lg-link" onClick={() => { setForgot(true); setError(null); }}>Forgot password?</button>
                </div>
                <div className="lg-pass">
                  <input id="lg-pass" className="lg-in" name="password" type={showPass ? "text" : "password"} placeholder="Your password" required autoComplete="current-password" />
                  <button type="button" className="lg-eye" onClick={() => setShowPass((s) => !s)} aria-label={showPass ? "Hide password" : "Show password"} aria-pressed={showPass}>
                    {showPass ? EYE_OFF : EYE}
                  </button>
                </div>
                {error && <p className="lg-err" role="alert">{error}</p>}
                <button className="lg-submit" type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
              </form>
            ) : forgotSent ? (
              <div className="lg-note" role="status">
                Request sent. If that email has an Echo login, your admin has been told. They’ll give you a
                temporary password — once you’re in, change it under My Profile.
              </div>
            ) : (
              <form onSubmit={handleForgot}>
                <label htmlFor="lg-femail">Your email</label>
                <input id="lg-femail" className="lg-in" name="email" type="email" placeholder="The email you sign in with" required autoComplete="email" autoFocus />
                {error && <p className="lg-err" role="alert">{error}</p>}
                <button className="lg-submit" type="submit" disabled={pending}>{pending ? "Sending…" : "Ask my admin to reset it"}</button>
              </form>
            )}

            <p className="lg-foot">
              {forgot
                ? <button type="button" className="lg-link" onClick={showSignIn}>← Back to sign in</button>
                : <>No login yet? Ask your admin to add you to the team.</>}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
