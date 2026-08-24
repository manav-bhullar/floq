import { useState, useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { useLocation, Link } from "react-router-dom";
import { useApp } from "../context/AppContext";
import "./TopNav.css";

export default function TopNav() {
  const { user, isAuthenticated, logout } = useAuth();
  const { state } = useApp();
  const location = useLocation();
  const [showModal, setShowModal] = useState(false);
  const modalRef = useRef(null);

  useEffect(() => {
    if (!showModal) return;

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setShowModal(false);
        return;
      }

      if (e.key === "Tab") {
        if (!modalRef.current) return;

        const focusableElements = modalRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusableElements.length === 0) return;

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            lastElement.focus();
            e.preventDefault();
          }
        } else {
          if (document.activeElement === lastElement) {
            firstElement.focus();
            e.preventDefault();
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    // Focus the first interactive element when opened
    if (modalRef.current) {
      const focusableElements = modalRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusableElements.length > 0) {
        focusableElements[0].focus();
      }
    }

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showModal]);

  if (!isAuthenticated) return null;

  const authRoutes = ["/login", "/register", "/verify-email"];
  if (authRoutes.includes(location.pathname)) return null;

  return (
    <>
      <div className="top-nav">
        {state.uiState === "IDLE" ? (
          <Link
            to="/home"
            className="top-nav-brand-container glass-card"
            style={{ textDecoration: "none" }}
          >
            <span
              style={{
                font: "var(--type-headline-large)",
                color: "var(--color-md-primary)",
                letterSpacing: "-0.5px",
                fontWeight: "800",
              }}
            >
              Floq
            </span>
          </Link>
        ) : (
          <div className="top-nav-brand-container glass-card">
            <span
              style={{
                font: "var(--type-headline-large)",
                color: "var(--color-md-primary)",
                letterSpacing: "-0.5px",
                fontWeight: "800",
              }}
            >
              Floq
            </span>
          </div>
        )}
        <div className="user-profile glass-card">
          <div className="user-avatar">
            {user?.name?.charAt(0).toUpperCase() || "U"}
          </div>
          <span className="user-name">{user?.name}</span>
          <button
            onClick={() => setShowModal(true)}
            className="logout-btn"
            title="Logout"
            aria-label="Logout"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
          </button>
        </div>
      </div>

      {showModal && (
        <div className="logout-modal-backdrop" onClick={() => setShowModal(false)}>
          <div
            className="logout-modal glass-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="logout-modal-title"
            ref={modalRef}
          >
            <h3 id="logout-modal-title">Sign Out</h3>
            <p>Are you sure you want to sign out of your account?</p>
            <div className="logout-modal-actions">
              <button
                className="btn-cancel"
                onClick={() => setShowModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn-confirm"
                onClick={() => {
                  setShowModal(false);
                  logout();
                }}
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
