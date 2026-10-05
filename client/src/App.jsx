import { useEffect } from "react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { Analytics } from "@vercel/analytics/react";
import {
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import { useApp } from "./context/AppContext";
import { useAuth } from "./context/AuthContext";
import { useGlobalSocket } from "./hooks/useGlobalSocket";
import { getRouteForUiState } from "./utils/routeUtils";
import ProtectedRoute from "./ProtectedRoute";

import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";
import HomeScreen from "./pages/HomeScreen";
import WaitingScreen from "./pages/WaitingScreen";
import TripScreen from "./pages/TripScreen";
import SummaryScreen from "./pages/SummaryScreen";

import StatusBanner from "./components/StatusBanner";
import LoadingState from "./components/LoadingState";
import TopNav from "./components/TopNav";

export default function App() {
  const { state } = useApp();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useGlobalSocket();

  const userId = user?.id;
  const targetRoute = userId
    ? getRouteForUiState(state.uiState, state.trip?.id)
    : null;

  // 🔥 Lifecycle-driven navigation after hydration completes
  useEffect(() => {
    if (!userId) return;
    if (state.loading.init) return;

    // Let the user stay on the verify-email page if they need to verify
    if (location.pathname === "/verify-email") return;

    if (targetRoute && location.pathname !== targetRoute) {
      navigate(targetRoute, { replace: true });
    }
  }, [
    userId,
    state.loading.init,
    state.uiState,
    state.trip?.id,
    targetRoute,
    navigate,
    location.pathname,
  ]);

  // Initial loading / hydration
  if (authLoading || state.loading.init) {
    return <LoadingState message="Loading your session..." />;
  }

  return (
    <>
      <StatusBanner />
      <TopNav />
      <SpeedInsights />
      <Analytics />

      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route
          path="/home"
          element={
            <ProtectedRoute>
              <HomeScreen />
            </ProtectedRoute>
          }
        />
        <Route
          path="/waiting"
          element={
            <ProtectedRoute>
              <WaitingScreen />
            </ProtectedRoute>
          }
        />
        <Route
          path="/trip/:tripId?"
          element={
            <ProtectedRoute>
              <TripScreen />
            </ProtectedRoute>
          }
        />
        <Route
          path="/summary/:tripId"
          element={
            <ProtectedRoute>
              <SummaryScreen />
            </ProtectedRoute>
          }
        />

        <Route path="*" element={<Navigate to={targetRoute} replace />} />
      </Routes>
    </>
  );
}
