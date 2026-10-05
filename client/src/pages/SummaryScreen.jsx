import { useState, useEffect, useMemo, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { useAuth } from "../context/AuthContext";
import PassengerList from "../components/PassengerList";
import TripMap from "../components/TripMap";
import { formatTime } from "../utils/time";
import { getTripById } from "../api/trips";
import {
  createPaymentOrder,
  verifyPayment,
  getPaymentStatus,
} from "../api/payment";
import "./SummaryScreen.css";

/**
 * Dynamically injects the Razorpay checkout script into the document head/body if not already loaded.
 * Returns a Promise that resolves when window.Razorpay is ready.
 */
function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (typeof window !== "undefined" && window.Razorpay) {
      return resolve(true);
    }

    const existingScript = document.querySelector(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]'
    );

    if (existingScript) {
      if (window.Razorpay) {
        return resolve(true);
      }
      existingScript.addEventListener("load", () => resolve(true));
      existingScript.addEventListener("error", () =>
        reject(new Error("Failed to load Razorpay SDK"))
      );
      return;
    }

    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () =>
      reject(
        new Error(
          "Unable to load Razorpay payment gateway. Please check your internet connection."
        )
      );
    document.body.appendChild(script);
  });
}

function Confetti() {
  // Generate random confetti pieces only once
  const pieces = useMemo(
    () =>
      Array.from({ length: 20 }).map((_, i) => ({
        left: `${Math.random() * 100}%`,
        animationDelay: `${Math.random() * 2}s`,
        animationDuration: `${2 + Math.random() * 3}s`,
        background:
          i % 2 === 0 ? "var(--color-md-primary)" : "var(--color-md-tertiary)",
      })),
    []
  );

  return (
    <div className="confetti-container">
      {pieces.map((style, i) => (
        <div key={i} className="confetti-piece" style={style} />
      ))}
    </div>
  );
}

export default function SummaryScreen() {
  const { state, dispatch } = useApp();
  const { user } = useAuth();
  const { tripId: routeTripId } = useParams();
  const navigate = useNavigate();

  const [localTrip, setLocalTrip] = useState(null);
  const [paymentStatusLoading, setPaymentStatusLoading] = useState(true);
  const [isPaid, setIsPaid] = useState(false);
  const [paymentDetails, setPaymentDetails] = useState(null);
  const [serverFareShare, setServerFareShare] = useState(null);
  const [paying, setPaying] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [paymentSuccessMessage, setPaymentSuccessMessage] = useState(null);

  const trip = state.trip || localTrip;
  const effectiveTripId = trip?.id || routeTripId;

  // Fallback: If trip not loaded into app state, fetch by ID
  useEffect(() => {
    if (!state.trip && routeTripId && user?.id) {
      getTripById(user.id, routeTripId)
        .then((fetchedTrip) => {
          if (fetchedTrip) {
            setLocalTrip(fetchedTrip);
          }
        })
        .catch((err) => {
          console.error("Could not fetch trip details:", err);
        });
    }
  }, [state.trip, routeTripId, user?.id]);

  const me = (trip?.passengers || []).find((p) => p.userId === user?.id) || {};
  const isRider = Boolean(me.userId || (trip?.passengers && trip.passengers.some((p) => p.userId === user?.id)));

  const displayDistance =
    typeof me.distanceKm === "number" && me.distanceKm > 0
      ? me.distanceKm
      : trip?.totalDistanceKm || 0;

  const fareAmount =
    typeof me.fareShare === "number" && me.fareShare > 0
      ? me.fareShare
      : typeof serverFareShare === "number"
      ? serverFareShare
      : 0;

  const soloFare = displayDistance * 12; // Generic solo rate 12/km
  const savings = soloFare - fareAmount;

  // Query payment status on mount and when tripId is available
  useEffect(() => {
    let isMounted = true;

    async function checkStatus() {
      if (!effectiveTripId || !user?.id) {
        setPaymentStatusLoading(false);
        return;
      }

      try {
        setPaymentStatusLoading(true);
        setPaymentError(null);
        const statusRes = await getPaymentStatus(effectiveTripId);

        if (isMounted && statusRes) {
          setIsPaid(Boolean(statusRes.isPaid));
          if (statusRes.payment) {
            setPaymentDetails(statusRes.payment);
          }
          if (typeof statusRes.fareShare === "number") {
            setServerFareShare(statusRes.fareShare);
          }
        }
      } catch (err) {
        console.warn("Failed to check payment status on mount:", err);
        // If status query fails (e.g. 404), assume unpaid for riders with a fare
        if (isMounted) {
          setIsPaid(false);
        }
      } finally {
        if (isMounted) {
          setPaymentStatusLoading(false);
        }
      }
    }

    checkStatus();

    return () => {
      isMounted = false;
    };
  }, [effectiveTripId, user?.id]);

  // Handle Pay Now Flow
  const handlePayNow = useCallback(async () => {
    if (!effectiveTripId) {
      setPaymentError("Trip information is missing. Cannot initiate payment.");
      return;
    }

    try {
      setPaying(true);
      setPaymentError(null);
      setPaymentSuccessMessage(null);

      // 1. Ensure Razorpay SDK is loaded
      await loadRazorpayScript();

      if (typeof window === "undefined" || !window.Razorpay) {
        throw new Error("Razorpay checkout SDK failed to initialize.");
      }

      // 2. Create order on backend
      const orderPayload = {
        tripId: effectiveTripId,
        ...(me.id ? { tripUserId: me.id } : {}),
      };

      const orderData = await createPaymentOrder(orderPayload);
      const { orderId, amount, currency, keyId, tripUserId } = orderData;

      const razorpayKey =
        import.meta.env.VITE_RAZORPAY_KEY_ID || keyId || "rzp_test_mock";

      // 3. Configure Razorpay modal options
      const options = {
        key: razorpayKey,
        amount: amount,
        currency: currency || "INR",
        name: "floq Carpooling",
        description: `Ride fare share for trip #${effectiveTripId.slice(-6)}`,
        order_id: orderId,
        handler: async function (response) {
          try {
            setVerifying(true);
            const verifyPayload = {
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
              tripUserId: tripUserId || me.id,
            };

            const verifyResult = await verifyPayment(verifyPayload);

            if (verifyResult && verifyResult.status === "SUCCESS") {
              setIsPaid(true);
              setPaymentDetails(
                verifyResult.payment || {
                  razorpayPaymentId: response.razorpay_payment_id,
                  status: "SUCCESS",
                }
              );
              setPaymentSuccessMessage(
                `Payment of ₹${(amount / 100).toFixed(0)} confirmed! Ref: ${response.razorpay_payment_id}`
              );
            }
          } catch (verifyErr) {
            console.error("Payment verification failed:", verifyErr);
            setPaymentError(
              verifyErr.message ||
                "Payment verification failed on the server. Please contact support if amount was deducted."
            );
          } finally {
            setVerifying(false);
            setPaying(false);
          }
        },
        prefill: {
          name: user?.name || "",
          email: user?.email || "",
          contact: user?.phone || "",
        },
        theme: {
          color: "#6366f1", // primary floq purple/indigo
        },
        modal: {
          ondismiss: () => {
            setPaying(false);
          },
        },
      };

      const rzpInstance = new window.Razorpay(options);

      rzpInstance.on("payment.failed", function (response) {
        console.error("Razorpay payment failed:", response.error);
        setPaymentError(
          response.error?.description ||
            "Payment failed or was cancelled. Please try again."
        );
        setPaying(false);
      });

      rzpInstance.open();
    } catch (err) {
      console.error("Failed to initiate payment:", err);
      setPaymentError(
        err.message || "Failed to initialize payment. Please try again."
      );
      setPaying(false);
    }
  }, [effectiveTripId, me.id, user]);

  function handleGoHome() {
    if (isRider && !isPaid && fareAmount > 0) {
      setPaymentError("Please complete your ride payment before booking a new ride.");
      return;
    }
    dispatch({ type: "RESET" });
    navigate("/home");
  }

  const isPaymentRequired = isRider && fareAmount > 0 && !isPaid;

  return (
    <div className="summary-screen-expressive">
      {/* Map Panel (Full Bleed Wallpaper) */}
      <div className="summary-map-container">
        <TripMap stops={trip?.stops} myRideRequestId={me.rideRequestId} />
      </div>

      <Confetti />

      <div className="summary-content-layer">
        <div className="summary-glass-card">
          <div className="summary-completion-mark">
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>

          <h1 className="summary-title">Trip Complete</h1>
          {trip?.completedAt && (
            <p className="summary-time">
              Completed at {formatTime(trip.completedAt)}
            </p>
          )}

          <div className="summary-stats-card glass-card">
            {/* Fare Display */}
            <div style={{ textAlign: "center" }}>
              <p className="summary-stats-fare-label">Your Fare</p>
              <h2 className="summary-stats-fare-value">
                ₹{fareAmount > 0 ? fareAmount.toFixed(0) : "0"}
              </h2>

              {/* Payment Status Pill */}
              <div className="summary-payment-status-wrapper">
                {paymentStatusLoading ? (
                  <span className="summary-payment-badge summary-payment-badge--loading">
                    Checking payment status...
                  </span>
                ) : isPaid ? (
                  <span className="summary-payment-badge summary-payment-badge--paid">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Payment Received (PAID)
                  </span>
                ) : isPaymentRequired ? (
                  <span className="summary-payment-badge summary-payment-badge--unpaid">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    Payment Pending
                  </span>
                ) : null}
              </div>
            </div>

            {/* Savings Callout */}
            {savings > 0 && (
              <div className="summary-stats-savings">
                <span className="summary-stats-savings-label">
                  Value Unlocked
                </span>
                <span className="summary-stats-savings-value">
                  You saved ₹{savings.toFixed(0)}
                </span>
                <span className="summary-stats-savings-subtext">
                  compared to a solo ride
                </span>
              </div>
            )}

            {/* Trip Details Row */}
            <div className="summary-stats-row">
              <div>
                <p className="summary-stats-row-label">Distance</p>
                <p className="summary-stats-row-value">
                  {displayDistance?.toFixed(2)} km
                </p>
              </div>
              <div style={{ textAlign: "right" }}>
                <p className="summary-stats-row-label">Duration</p>
                <p className="summary-stats-row-value">
                  {trip?.estimatedEtaMinutes || 0} min
                </p>
              </div>
            </div>

            {/* Passengers */}
            <div style={{ textAlign: "left" }}>
              <PassengerList
                passengers={trip?.passengers}
                currentUserId={user?.id}
              />
            </div>
          </div>

          {/* Payment Success Confirmation Banner */}
          {paymentSuccessMessage && (
            <div className="summary-alert summary-alert--success">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span>{paymentSuccessMessage}</span>
            </div>
          )}

          {/* Payment Error Banner */}
          {paymentError && (
            <div className="summary-alert summary-alert--error">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{paymentError}</span>
            </div>
          )}

          {/* Actions Container */}
          <div className="summary-actions-container">
            {/* Pay Now Button (Shown prominently when payment is pending) */}
            {isPaymentRequired && (
              <button
                className="btn btn-primary summary-pay-btn fab-extended"
                onClick={handlePayNow}
                disabled={paying || verifying || paymentStatusLoading}
              >
                {paying || verifying ? (
                  <>
                    <span className="summary-spinner-small" />
                    {verifying ? "Verifying Payment..." : "Opening Checkout..."}
                  </>
                ) : (
                  <>
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                      <line x1="1" y1="10" x2="23" y2="10" />
                    </svg>
                    Pay Now (₹{fareAmount.toFixed(0)})
                  </>
                )}
              </button>
            )}

            {/* Payment Requirement Helper Note */}
            {isPaymentRequired && (
              <p className="summary-lock-hint">
                🔒 You must pay your ride fare before booking a new ride.
              </p>
            )}

            {/* Book a New Ride Button (Gated by payment status) */}
            <button
              className={`btn fab-extended summary-fab ${
                isPaymentRequired ? "summary-fab--disabled" : ""
              }`}
              onClick={handleGoHome}
              disabled={isPaymentRequired || paymentStatusLoading}
              title={
                isPaymentRequired
                  ? "Complete payment to unlock new ride booking"
                  : "Book a new ride"
              }
            >
              {isPaid ? "Book a New Ride" : isPaymentRequired ? "Payment Required" : "Book a New Ride"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
