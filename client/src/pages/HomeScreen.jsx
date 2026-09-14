import { useState, useEffect, useMemo } from "react";
import { useApp } from "../context/AppContext";
import { useAuth } from "../context/AuthContext";
import RideRequestForm from "../components/RideRequestForm";
import TripMap from "../components/TripMap";
import "leaflet/dist/leaflet.css";
import "./HomeScreen.css";

export default function HomeScreen() {
  const { dispatch } = useApp();
  const { user } = useAuth();
  const [activeStop, setActiveStop] = useState([]);
  const [isExpanded, setIsExpanded] = useState(window.innerWidth >= 768);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) setIsExpanded(true);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // University coordinates as default wallpaper center
  const defaultCenter = [49.2606, -123.246]; // e.g., UBC

  const handleLocationSelect = (type, loc) => {
    if (loc) {
      // We only store the single most recently interacted location.
      // This forces the map to fly specifically to this location and NOT draw a line yet.
      setActiveStop([
        {
          stopOrder: type === "PICKUP" ? 1 : 2,
          type,
          lat: loc.lat,
          lng: loc.lng,
        },
      ]);
    } else {
      setActiveStop([]);
    }
  };

  // Shift the map's visual center to the right on desktop so the route isn't covered by the Glass Card
  const fitBoundsOptions = useMemo(
    () => ({
      paddingTopLeft: window.innerWidth >= 768 ? [600, 150] : [100, 100],
      paddingBottomRight: [100, 150],
    }),
    [],
  );

  return (
    <div className="home-screen-expressive">
      {/* Background Wallpaper Map */}
      <div className="home-map-layer">
        <TripMap
          stops={activeStop}
          defaultCenter={defaultCenter}
          fitBoundsOptions={fitBoundsOptions}
        />
      </div>

      {/* Atmospheric Blur Shapes */}
      <div className="blur-shape home-blur-1"></div>
      <div className="blur-shape home-blur-2"></div>

      {/* Foreground Content */}
      <div
        className={`home-content-layer ${isExpanded ? "expanded" : "collapsed"}`}
      >
        <div className="home-glass-card glass-card">
          {/* Drag Handle to toggle expansion on mobile */}
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

          <h1 className="home-headline">Where to next, {user?.name}?</h1>

          {!isExpanded ? (
            <div
              className="collapsed-mock-input"
              onClick={() => setIsExpanded(true)}
              role="button"
              aria-label="Open destination search"
              aria-expanded={isExpanded}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  setIsExpanded(true);
                  e.preventDefault();
                }
              }}
            >
              <span className="mock-placeholder">
                Search for a destination...
              </span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mock-icon"
              >
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
            </div>
          ) : (
            <RideRequestForm onLocationSelect={handleLocationSelect} />
          )}
        </div>
      </div>
    </div>
  );
}
