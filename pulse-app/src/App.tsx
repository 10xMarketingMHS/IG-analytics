import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/lib/auth-context";
import { WorkspacesProvider } from "@/lib/workspaces-context";
import { ThemeProvider } from "@/components/theme-provider";
import { ProtectedRoute } from "@/components/protected-route";
import { AppShell } from "@/components/app-shell";
import { Toaster } from "@/components/ui/sonner";
import { LoginPage } from "@/pages/login";
import { DashboardPage } from "@/pages/dashboard";
import { InsightsPage } from "@/pages/insights";
import { ReportsPage } from "@/pages/reports";
import { PostsPage } from "@/pages/posts";
import { AddPostPage } from "@/pages/add-post";
import { SettingsPage } from "@/pages/settings";
import { FormatAnalyticsPage } from "@/pages/format-analytics";
import { LeaderboardPage } from "@/pages/leaderboard";

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <WorkspacesProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route element={<ProtectedRoute />}>
              <Route element={<AppShell />}>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/insights" element={<InsightsPage />} />
                <Route path="/leaderboard" element={<LeaderboardPage />} />
                <Route path="/reports" element={<ReportsPage />} />
                <Route path="/posts" element={<PostsPage />} />
                <Route path="/posts/new" element={<AddPostPage />} />
                <Route path="/posts/:id/edit" element={<AddPostPage />} />
                <Route path="/analytics/:type" element={<FormatAnalyticsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
            </Route>

            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
          </WorkspacesProvider>
        </AuthProvider>
        <Toaster />
      </BrowserRouter>
    </ThemeProvider>
  );
}
