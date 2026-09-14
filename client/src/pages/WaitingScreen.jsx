import { useState, useEffect } from "react";
import { useApp } from "../context/AppContext";

import { cancelRideRequest } from "../api/rideRequests";
import { getElapsedSeconds, formatElapsed } from "../utils/time";
import DirectionMap from "../components/DirectionMap";
import "./WaitingScreen.css";

export default function WaitingScreen() {
  const { state, dispatch } = useApp();
  const [cancelling, setCancelling] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [isExpanded, setIsExpanded] = useState(window.innerWidth >= 768);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) setIsExpanded(true);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const rideRequest = state.rideRequest;
  const createdAt = rideRequest?.createdAt || null;
  const [elapsed, setElapsed] = useState(() => getElapsedSeconds(createdAt));

  useEffect(() => {
    setElapsed(getElapsedSeconds(createdAt));
    const timer = setInterval(() => {
      setElapsed(getElapsedSeconds(createdAt));
    }, 1000);
    return () => clearInterval(timer);
  }, [createdAt]);

  async function handleCancel() {
    if (!rideRequest) return;
    setCancelling(true);
    try {
      await cancelRideRequest(rideRequest.id);
      dispatch({ type: "RESET" });
    } catch (err) {
      dispatch({
        type: "SET_NOTIFICATION",
        payload: { type: "error", message: err.message || "Failed to cancel" },
      });
    } finally {
      setCancelling(false);
      setShowCancelConfirm(false);
    }
  }

  if (!rideRequest) return null;

  const isMatched =
    state.uiState === "MATCHED" || rideRequest.status === "RIDERS_MATCHED";

  const getPrimaryMessage = () => {
    if (isMatched) return "Match found!";
    if (elapsed <= 10) return "Setting up your ride request...";
    if (elapsed <= 60) return "Searching for compatible riders...";
    if (elapsed <= 120) return "Still searching — checked once so far";
    return "We're still looking. This can take a few minutes.";
  };

  const getSecondaryMessage = () => {
    if (isMatched) return "Loading your trip details...";
    if (elapsed > 10 && elapsed <= 60) return "Matching runs every 60 seconds";
    if (elapsed > 60 && elapsed <= 120)
      return "60-second cycles continue automatically";
    return null;
  };

  return (
    <div
      className={`waiting-screen-expressive ${isMatched ? "is-matched" : ""}`}
    >
      {/* Direction Map — Swiggy/Zomato style 3D perspective with straight dashed line */}
      <div className="waiting-map-layer">
        <DirectionMap
          pickupLat={rideRequest.pickupLat}
          pickupLng={rideRequest.pickupLng}
          dropLat={rideRequest.dropLat}
          dropLng={rideRequest.dropLng}
        />
      </div>

      {/* Atmospheric Blur Shapes */}
      <div className="blur-shape waiting-blur-1"></div>
      <div className="blur-shape waiting-blur-2"></div>

      {/* Foreground Content */}
      <div
        className={`waiting-content-layer ${isExpanded ? "expanded" : "collapsed"}`}
      >
        <div className="waiting-glass-card glass-card">
          {/* Drag Handle */}
          <div
            className="drag-handle-wrapper"
            onClick={() => setIsExpanded(!isExpanded)}
            role="button"
            aria-label="Toggle details"
            aria-expanded={isExpanded}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                setIsExpanded(!isExpanded);
                e.preventDefault();
              }
            }}
          >
            <div className="drag-handle"></div>
          </div>

          <h1 className="waiting-primary-msg">{getPrimaryMessage()}</h1>
          {getSecondaryMessage() && (
            <p className="waiting-secondary-msg">{getSecondaryMessage()}</p>
          )}

          <div
            className="waiting-status-block"
            onClick={() => !isExpanded && setIsExpanded(true)}
            style={{ cursor: !isExpanded ? "pointer" : "default" }}
            role="button"
            aria-expanded={isExpanded}
            tabIndex={0}
            onKeyDown={(e) => {
              if (!isExpanded && (e.key === "Enter" || e.key === " ")) {
                setIsExpanded(true);
                e.preventDefault();
              }
            }}
          >
            <p className="waiting-timer">
              Waiting for {formatElapsed(elapsed)}
            </p>
          </div>

          {isExpanded && (
            <div className="waiting-expanded-content">
              <hr className="waiting-divider" />

              <div className="waiting-request-summary">
                <span className="waiting-section-label">Your request</span>
                <p className="waiting-route-text">
                  {rideRequest.pickupAddress?.split(",")[0]} →{" "}
                  {rideRequest.dropAddress?.split(",")[0]}
                </p>
                <p className="waiting-time-text">
                  {rideRequest.preferredTime
                    ? new Date(rideRequest.preferredTime).toLocaleTimeString(
                        [],
                        { hour: "2-digit", minute: "2-digit" },
                      )
                    : "ASAP"}
                </p>
              </div>

              {/* Cancel Action */}
              <div className="waiting-cancel-zone">
                {!showCancelConfirm ? (
                  <button
                    className="btn btn-outlined btn-danger"
                    onClick={() => setShowCancelConfirm(true)}
                    disabled={isMatched || cancelling}
                  >
                    Cancel ride
                  </button>
                ) : (
                  <div className="cancel-confirm-inline">
                    <p>Are you sure?</p>
                    <div className="cancel-confirm-actions">
                      <button
                        className="btn btn-danger"
                        onClick={handleCancel}
                        disabled={cancelling}
                      >
                        {cancelling ? "Cancelling..." : "Yes, cancel"}
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => setShowCancelConfirm(false)}
                        disabled={cancelling}
                        autoFocus
                      >
                        Keep searching
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
