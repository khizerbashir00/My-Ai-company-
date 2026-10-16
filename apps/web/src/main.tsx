import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import './index.css';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { AgentDetailPage } from './pages/AgentDetail';
import { ApprovalsPage } from './pages/Approvals';
import { LeadDetailPage } from './pages/LeadDetail';
import { LeadsPage } from './pages/Leads';
import { LoginPage } from './pages/Login';
import { MarketingPage } from './pages/Marketing';
import { OrganizationPage } from './pages/Organization';
import { OverviewPage } from './pages/Overview';
import { SettingsPage } from './pages/Settings';
import { SourcesPage } from './pages/Sources';
import { TaskDetailPage } from './pages/TaskDetail';
import { TasksPage } from './pages/Tasks';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Don't retry auth/validation/not-found errors; retry network blips twice.
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading label="Opening HQ" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-semibold">That page doesn’t exist</h1>
      <Link to="/" className="mt-2 inline-block font-medium text-brand hover:underline">
        Go to the overview
      </Link>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<OverviewPage />} />
              <Route path="leads" element={<LeadsPage />} />
              <Route path="leads/:id" element={<LeadDetailPage />} />
              <Route path="sources" element={<SourcesPage />} />
              <Route path="approvals" element={<ApprovalsPage />} />
              <Route path="approvals/:id" element={<ApprovalsPage />} />
              <Route path="marketing" element={<MarketingPage />} />
              <Route path="marketing/:section/:id" element={<MarketingPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="tasks/:id" element={<TaskDetailPage />} />
              <Route path="organization" element={<OrganizationPage />} />
              <Route path="organization/:id" element={<AgentDetailPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
