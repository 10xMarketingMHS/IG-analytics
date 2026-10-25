import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  type Location,
} from "react-router-dom";
import { AuthProvider } from "@/lib/auth-context";
import { WorkspacesProvider } from "@/lib/workspaces-context";
import { ThemeProvider } from "@/components/theme-provider";
import { ProtectedRoute } from "@/components/protected-route";
import { Loader } from "@/components/loader";
import { AppShell } from "@/components/app-shell";
import { Modal } from "@/components/modal";
import { Toaster } from "@/components/ui/sonner";
import { LoginPage } from "@/pages/login";
import { HomePage } from "@/pages/home";
import { AnalyticsPage } from "@/pages/analytics";
import { lazy, Suspense } from "react";
import { InsightsPage } from "@/pages/insights";
// Trends pulls in Recharts (heavy) — load it only when visited.
const TrendsPage = lazy(() => import("@/pages/trends").then((m) => ({ default: m.TrendsPage })));
import { MetricsPage } from "@/pages/metrics";
import { SchedulingPage } from "@/pages/scheduling";
import { ReportsPage } from "@/pages/reports";
import { PostsPage } from "@/pages/posts";
import { TasksPage } from "@/pages/tasks";
import { SocialMediaPage } from "@/pages/social-media";
import { ActivityPage } from "@/pages/activity";
import { InboxPage } from "@/pages/inbox";
import { LeavePage } from "@/pages/leave";
import { ChatPage } from "@/pages/chat";
import { AddPostPage } from "@/pages/add-post";
import { BulkAddPostPage } from "@/pages/bulk-add-post";
import { useWorkspaces } from "@/lib/workspaces-context";
// Task Settings, Channels, and Teams are now tabs inside one master Settings
// page (see settings.tsx) — /task-rules, /channels, /teams still route here
// so any old link keeps working, just pre-selecting the matching tab.
import { SettingsPage } from "@/pages/settings";
import { GoalsPage } from "@/pages/goals";
import { FormatAnalyticsPage } from "@/pages/format-analytics";
import { LeaderboardPage } from "@/pages/leaderboard";
import { MyTeamPage } from "@/pages/my-team";

// Adding posts is for admins and anyone given Add Post access — everyone else
// who opens the address gets a short explanation instead of an empty page.
function AddPostGate({ children }: { children: React.ReactNode }) {
  const { isAdmin, hasPermission, loading } = useWorkspaces();
  if (loading) return null;
  if (!isAdmin && !hasPermission("create_post")) {
    return (
      <section className="screen">
        <div className="card pad home-empty">
          Adding posts is for admins, or people an admin has given Add Post access. You can see every post under Posts.
        </div>
      </section>
    );
  }
  return <>{children}</>;
}

// The Add/Edit Post form rendered inside the glass modal. Closing returns to
// the page underneath; a successful save navigates on to /posts (handled inside
// the form), which drops the modal because the new location has no background.
function PostFormModal() {
  const navigate = useNavigate();
  const { id } = useParams();
  const close = () => navigate(-1);
  // Editing one post = single form; adding = the bulk multi-post table.
  if (id) {
    return (
      <Modal onClose={close} title="Edit Post">
        <AddPostPage onClose={close} />
      </Modal>
    );
  }
  return <AddPostGate><BulkAddPostPage onClose={close} /></AddPostGate>;
}

function AppRoutes() {
  const location = useLocation();
  // When present, render this location's page as the background and overlay the
  // matched modal route on top (React Router's modal-route pattern).
  const state = location.state as { backgroundLocation?: Location } | null;
  const background = state?.backgroundLocation;

  return (
    <>
      <Routes location={background || location}>
        <Route path="/login" element={<LoginPage />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route path="/home" element={<HomePage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/leave" element={<LeavePage />} />
            {/* Dashboard and Top Performers live on as the two tabs of Analytics. */}
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/dashboard" element={<Navigate to="/analytics" replace />} />
            <Route path="/metrics" element={<MetricsPage />} />
            <Route path="/scheduling" element={<SchedulingPage />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route
              path="/trends"
              element={
                <Suspense fallback={<div className="screen"><Loader label="Loading trends…" /></div>}>
                  <TrendsPage />
                </Suspense>
              }
            />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/top" element={<Navigate to="/analytics?tab=top" replace />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/posts" element={<PostsPage />} />
            {/* Channels, Task Settings, Teams all live inside Settings now — these
                paths just render it pre-selected to the matching tab. */}
            <Route path="/channels" element={<SettingsPage />} />
            {/* Integrations merged into Channels — keep the path working for old links / OAuth callback. */}
            <Route path="/integrations" element={<Navigate to="/channels" replace />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/my-team" element={<MyTeamPage />} />
            <Route path="/task-rules" element={<SettingsPage />} />
            <Route path="/social-media" element={<SocialMediaPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/chat" element={<ChatPage />} />
            {/* Direct visits (no background) still render the form. */}
            <Route path="/posts/new" element={<AddPostGate><BulkAddPostPage /></AddPostGate>} />
            <Route path="/posts/:id/edit" element={<AddPostPage />} />
            <Route path="/analytics/:type" element={<FormatAnalyticsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* Goals: Team goals, Org goals (the old Goals board), Set goals and Discipline. */}
            <Route path="/goals-board" element={<GoalsPage />} />
            {/* Old Goal Setting link — each person's goals are now Goals › Set goals. */}
            <Route path="/goals" element={<Navigate to="/goals-board?tab=set" replace />} />
            <Route path="/teams" element={<Navigate to="/my-team?tab=roster" replace />} />
          </Route>
        </Route>

        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>

      {background && (
        <Routes>
          <Route path="/posts/new" element={<PostFormModal />} />
          <Route path="/posts/:id/edit" element={<PostFormModal />} />
        </Routes>
      )}
    </>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <WorkspacesProvider>
            <AppRoutes />
          </WorkspacesProvider>
        </AuthProvider>
        {/* on phones, toasts rise above the tab bar (components/mobile.css) */}
        <Toaster mobileOffset={{ bottom: "calc(var(--m-tab, 0px) + 12px)" }} />
      </BrowserRouter>
    </ThemeProvider>
  );
}
