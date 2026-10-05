import { useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { useApp } from "../context/AppContext";
import { useAuth } from "../context/AuthContext";
import { apiClient } from "../api/apiClient";
import { getCurrentRideRequest } from "../api/rideRequests";
import { getCurrentTrip, getTripById } from "../api/trips";

const BACKEND_URL = (import.meta.env.VITE_API_URL || "http://localhost:5050/api")
  .replace(/\/api\/?$/, "");

// Socket events invalidate state; REST remains the authorized source of snapshots.
// Reconnect/focus refreshes recover events missed while offline, without polling.
export function useGlobalSocket() {
  const { user, loading: authLoading } = useAuth();
  const { state, dispatch } = useApp();
  const tripRef = useRef(null);
  useEffect(() => { tripRef.current = state.trip; }, [state.trip]);

  useEffect(() => {
    if (authLoading) return;
    if (!user?.id) {
      dispatch({ type: "SYNC_LIFECYCLE", payload: { rideRequest: null, trip: null } });
      return;
    }

    let active = true;
    tripRef.current = null;
    let initialized = false;
    let refreshingAuth = false;
    let running = false;
    let dirty = false;
    let terminalTripId = null;
    let reason = null;
    const socket = io(BACKEND_URL, {
      // Read the latest token on every reconnect, including after HTTP refresh.
      auth: (callback) => callback({ token: apiClient.accessToken }),
    });

    async function refresh(data = {}) {
      if (!active) return;
      dirty = true;
      if (data.status === "COMPLETED" && data.tripId) terminalTripId = data.tripId;
      if (data.reason) reason = data.reason;
      if (running) return;
      running = true;
      try {
        while (active && dirty) {
          dirty = false;
          const [rideRequest, currentTrip] = await Promise.all([
            getCurrentRideRequest(), getCurrentTrip(user.id),
          ]);
          let trip = currentTrip;
          const previousTripId = terminalTripId || tripRef.current?.id;
          if (!trip && previousTripId) {
            try {
              const previous = await getTripById(user.id, previousTripId);
              if (previous?.status === "COMPLETED") trip = previous;
            } catch (err) {
              // Requeued riders have lost access to their former trip.
              if (err.status !== 403 && err.status !== 404) throw err;
            }
          }
          if (!active) return;
          // An event during the fetch invalidates the in-flight snapshot.
          if (dirty) continue;
          initialized = true;
          tripRef.current = trip;
          dispatch({ type: "SYNC_LIFECYCLE", payload: { rideRequest, trip, reason } });
          reason = null;
          terminalTripId = null;
        }
      } catch (err) {
        if (active && !initialized) {
          dispatch({ type: "SYNC_LIFECYCLE", payload: { rideRequest: null, trip: null } });
          initialized = true;
        }
        if (active) dispatch({ type: "SET_NOTIFICATION", payload: {
          type: "error", message: "Unable to refresh your ride. Reconnect or return to this tab to retry.",
        } });
        console.error("Lifecycle refresh failed:", err);
      } finally {
        running = false;
      }
    }

    const reconnect = () => refresh();
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    const onConnectionError = async (err) => {
      if (!active) return;
      if (err.message === "Authentication error" && !refreshingAuth) {
        refreshingAuth = true;
        try {
          await apiClient.refreshToken();
          if (active) socket.connect();
        } catch {
          if (active) dispatch({ type: "SET_NOTIFICATION", payload: {
            type: "error", message: "Your session expired. Please sign in again.",
          } });
        } finally {
          refreshingAuth = false;
        }
      }
    };
    socket.on("connect", reconnect);
    socket.on("trip_updated", refresh);
    socket.on("ride_request_updated", refresh);
    socket.on("connect_error", onConnectionError);
    window.addEventListener("focus", reconnect);
    document.addEventListener("visibilitychange", onVisibility);
    refresh();

    return () => {
      active = false;
      socket.disconnect();
      window.removeEventListener("focus", reconnect);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user?.id, authLoading, dispatch]);
}
