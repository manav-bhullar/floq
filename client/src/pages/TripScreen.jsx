import { useState } from "react";
import { useApp } from "../context/AppContext";
import { useAuth } from "../context/AuthContext";

import { cancelRideRequest } from "../api/rideRequests";
import TripMap from "../components/TripMap";
import CancelModal from "../components/CancelModal";
import PassengerList from "../components/PassengerList";
import { useDriverLocation } from "../hooks/useDriverLocation";
import "./TripScreen.css";

export default function TripScreen() {
  const { state, dispatch } = useApp();
  const { user } = useAuth();
  const [showCancelModal, setShowCancelModal] = useState(false);

  async function confirmCancel() {
    try {
      await cancelRideRequest(
        state.rideRequest?.id || state.trip?.rideRequestId,
      );
      dispatch({ type: "RESET" });
      dispatch({
        type: "SET_NOTIFICATION",
        payload: {
          type: "info",
          message: "Trip cancelled. Co-riders have been returned to the queue.",
        },
      });
    } catch {
      dispatch({
        type: "SET_NOTIFICATION",
        payload: {
          type: "error",
          message: "Failed to cancel. Please try again.",
        },
      });
    } finally {
      setShowCancelModal(false);
    }
  }

  const isStarted = state.trip?.status === "STARTED";
  const driverLocation = useDriverLocation(state.trip?.id, isStarted);

  if (!state.trip) {
    return (
      <div className="trip-screen-loading">
        <div className="loading-spinner"></div>
        <p>Finalizing your trip...</p>
      </div>
    );
  }

  const trip = state.trip;
  const me = (trip.passengers || []).find((p) => p.userId === user?.id) || {};

  const displayDistance =
    typeof me.distanceKm === "number" && me.distanceKm > 0
      ? me.distanceKm
      : trip.totalDistanceKm;

  const displayEtaMinutes =
    typeof me.etaMinutes === "number" && me.etaMinutes >= 0
      ? me.etaMinutes
      : trip.estimatedEtaMinutes;

  // Status chip styles based on M3 Expressive states
  let statusClass = "trip-status-chip--pending";
  const soloFare = displayDistance * 12; // Generic solo rate
  const savings = soloFare - (me.fareShare || 0);

  return (
    <div className="trip-screen-expressive">
      {/* Map Panel (Full Bleed) */}
      <div className="trip-map-container">
        <TripMap
          stops={trip.stops}
          myRideRequestId={me.rideRequestId}
          driverLocation={driverLocation}
        />
      </div>

      {/* Persistent Information Panel (Floating Glass Card) */}
      <div className="trip-content-layer">
        <div className="trip-sidebar-card">
          <div className="trip-sheet-header">
            <div className={`trip-status-chip ${statusClass}`}>
              {trip.status}
            </div>
            <h2 className="trip-headline">Your Shared Trip</h2>
          </div>

          {/* 1 & 2: Fare and ETA */}
          <div className="trip-primary-stats">
            <div>
              <p className="trip-stats-label">Your Fare</p>
              <h2 className="trip-stats-value-fare">
                ₹{me.fareShare?.toFixed(0) || "0"}
              </h2>
            </div>
            <div style={{ textAlign: "right" }}>
              <p className="trip-stats-label">Est. Arrival</p>
              <h2 className="trip-stats-value-eta">
                {displayEtaMinutes}
                <span className="trip-stats-value-eta-unit">min</span>
              </h2>
            </div>
          </div>

          {/* 3: Value Confirmation (Mint Savings) */}
          {savings > 0 && (
            <div className="trip-savings-banner">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="20"
                viewBox="0 -960 960 960"
                width="20"
                fill="currentColor"
              >
                <path d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm-40-160h80v-80h-80v80Zm0-120h80v-360h-80v360Z" />
              </svg>
              You saved ₹{savings.toFixed(0)} vs travelling alone!
            </div>
          )}

          {/* 4: Co-riders */}
          <div className="trip-passengers">
            <PassengerList
              passengers={trip.passengers}
              currentUserId={user?.id}
            />
          </div>

          {/* 5: Route Context */}
          <div className="trip-route-context">
            <h3 className="trip-route-context-title">Route Summary</h3>
            <p className="trip-route-context-text">
              Total Distance: {displayDistance?.toFixed(2)} km
            </p>
            <p className="trip-route-context-text" style={{ marginTop: "4px" }}>
              Detour Ratio: ~
              {(displayDistance > 0
                ? (trip.totalDistanceKm / displayDistance - 1) * 100
                : 0
              ).toFixed(0)}
              % added
            </p>
          </div>

          <div className="trip-actions-row">
            <button
              className="btn btn-danger"
              style={{ width: "100%" }}
              onClick={() => setShowCancelModal(true)}
            >
              Cancel Trip
            </button>
          </div>
        </div>
      </div>

      <CancelModal
        isOpen={showCancelModal}
        onClose={() => setShowCancelModal(false)}
        onConfirm={confirmCancel}
      />
    </div>
  );
}
