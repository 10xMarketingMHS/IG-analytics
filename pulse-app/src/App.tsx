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
import { AppShell } from "@/components/app-shell";
import { Modal } from "@/components/modal";
import { Toaster } from "@/components/ui/sonner";
import { LoginPage } from "@/pages/login";
import { DashboardPage } from "@/pages/dashboard";
import { InsightsPage } from "@/pages/insights";
import { ReportsPage } from "@/pages/reports";
import { PostsPage } from "@/pages/posts";
import { TasksPage } from "@/pages/tasks";
import { AddPostPage } from "@/pages/add-post";
import { SettingsPage } from "@/pages/settings";
import { FormatAnalyticsPage } from "@/pages/format-analytics";
import { LeaderboardPage } from "@/pages/leaderboard";

// The Add/Edit Post form rendered inside the glass modal. Closing returns to
// the page underneath; a successful save navigates on to /posts (handled inside
// the form), which drops the modal because the new location has no background.
function PostFormModal() {
  const navigate = useNavigate();
  const { id } = useParams();
  const close = () => navigate(-1);
  return (
    <Modal onClose={close} title={id ? "Edit Post" : "Add Post"}>
      <AddPostPage onClose={close} />
    </Modal>
  );
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
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/posts" element={<PostsPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            {/* Direct visits (no background) still render the form full-page. */}
            <Route path="/posts/new" element={<AddPostPage />} />
            <Route path="/posts/:id/edit" element={<AddPostPage />} />
            <Route path="/analytics/:type" element={<FormatAnalyticsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Route>

        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
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
        <Toaster />
      </BrowserRouter>
    </ThemeProvider>
  );
}
