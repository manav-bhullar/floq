import { useState, useEffect, useRef, useId } from "react";
import { useApp } from "../context/AppContext";

import { createRideRequest, getRideRequests } from "../api/rideRequests";
import { searchLocation, reverseGeocode } from "../api/geocoding";
import DateTimePickerModal from "./DateTimePickerModal";

function getDistance(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null)
    return Infinity;
  const R = 6371; // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function LocationInput({
  label,
  value,
  onSelect,
  allowCurrentLocation,
  referenceLocation,
}) {
  const inputId = useId();
  const [query, setQuery] = useState(value?.displayName || "");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);
  const wrapperRef = useRef(null);
  const latestQueryRef = useRef("");

  useEffect(() => {
    setQuery(value?.displayName || "");
  }, [value]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleChange(e) {
    const val = e.target.value;
    setQuery(val);
    latestQueryRef.current = val;
    setOpen(true);

    if (value?.displayName && val !== value.displayName) {
      onSelect(null);
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (val.trim().length < 3) {
      setResults([]);
      // Keep open if allowCurrentLocation so the button stays visible
      if (!allowCurrentLocation || val.trim().length > 0) {
        setOpen(false);
      }
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        let found = await searchLocation(val);
        if (referenceLocation) {
          found.sort((a, b) => {
            const distA = getDistance(
              referenceLocation.lat,
              referenceLocation.lng,
              a.lat,
              a.lng,
            );
            const distB = getDistance(
              referenceLocation.lat,
              referenceLocation.lng,
              b.lat,
              b.lng,
            );
            return distA - distB;
          });
        }
        if (latestQueryRef.current === val) {
          setResults(found);
        }
      } catch {
        if (latestQueryRef.current === val) {
          setResults([]);
        }
      } finally {
        if (latestQueryRef.current === val) {
          setLoading(false);
        }
      }
    }, 600);
  }

  function handleSelect(place) {
    setQuery(place.displayName);
    setResults([]);
    setOpen(false);
    onSelect(place);
  }

  function handleCurrentLocation() {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      return;
    }
    setLoading(true);
    setQuery("Locating...");

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const place = await reverseGeocode(
            pos.coords.latitude,
            pos.coords.longitude,
          );
          if (place) {
            handleSelect(place);
          } else {
            setQuery("");
            alert("Could not determine your address.");
          }
        } catch (err) {
          setQuery("");
          alert("Error fetching location.");
        } finally {
          setLoading(false);
        }
      },
      () => {
        setLoading(false);
        setQuery("");
        alert("Unable to retrieve your location.");
      },
    );
  }

  return (
    <div className="location-input-wrapper" ref={wrapperRef}>
      <div className="md3-input-group" style={{ position: "relative" }}>
        <label htmlFor={inputId} className="md3-label">{label}</label>
        <input
          id={inputId}
          className="md3-input"
          style={allowCurrentLocation ? { paddingRight: "48px" } : {}}
          type="text"
          placeholder="Search for a location..."
          value={query}
          onChange={handleChange}
          onFocus={() => setOpen(true)}
          autoComplete="off"
        />
        {allowCurrentLocation && (
          <button
            type="button"
            onClick={handleCurrentLocation}
            title="Use current location"
            aria-label="Use current location"
            style={{
              position: "absolute",
              right: "12px",
              bottom: "28px", // Center relative to the 56px tall input
              transform: "translateY(50%)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0A56D1",
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24px"
              viewBox="0 -960 960 960"
              width="24px"
              fill="currentColor"
            >
              <path d="M440-42v-80q-125-14-214.5-103.5T122-440H42v-80h80q14-125 103.5-214.5T440-838v-80h80v80q125 14 214.5 103.5T838-520h80v80h-80q-14 125-103.5 214.5T520-122v80h-80Zm40-158q116 0 198-82t82-198q0-116-82-198t-198-82q-116 0-198 82t-82 198q0 116 82 198t198 82Zm0-120q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47Zm0-80q33 0 56.5-23.5T560-480q0-33-23.5-56.5T480-560q0-33-56.5-23.5T400-480q0 33 23.5 56.5T480-400Z" />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div className="location-dropdown">
          {loading && (
            <div className="location-dropdown-item location-loading">
              Searching...
            </div>
          )}

          {!loading && query.trim().length >= 3 && results.length === 0 && (
            <div className="location-dropdown-item location-empty">
              No results found
            </div>
          )}

          {!loading &&
            results.map((place, index) => (
              <button
                key={index}
                type="button"
                className="location-dropdown-item"
                onClick={() => handleSelect(place)}
              >
                {place.displayName}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export default function RideRequestForm({ onLocationSelect }) {
  const { state, dispatch } = useApp();

  const getDefaultTime = () => {
    const now = new Date();
    // Round up to the next 15-minute slot
    const ms = 1000 * 60 * 15;
    const rounded = new Date(Math.ceil(now.getTime() / ms) * ms);
    const tzOffset = rounded.getTimezoneOffset() * 60000;
    return new Date(rounded.getTime() - tzOffset).toISOString().slice(0, 16);
  };

  const [pickup, setPickup] = useState(null);
  const [drop, setDrop] = useState(null);
  const [preferredTime, setPreferredTime] = useState(getDefaultTime());
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isDatePickerOpen, setDatePickerOpen] = useState(false);
  const timeLabelId = useId();

  const formatDisplayTime = (isoString) => {
    if (!isoString) return "";
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };

  const handlePickupSelect = (loc) => {
    setPickup(loc);
    if (onLocationSelect) onLocationSelect("PICKUP", loc);
  };

  const handleDropSelect = (loc) => {
    setDrop(loc);
    if (onLocationSelect) onLocationSelect("DROPOFF", loc);
  };

  function validate() {
    if (!pickup) return "Please select a pickup location";
    if (!drop) return "Please select a drop location";
    if (!preferredTime) return "Please select a preferred time";

    if (pickup.lat === drop.lat && pickup.lng === drop.lng) {
      return "Pickup and drop cannot be the same location";
    }

    const prefTime = new Date(preferredTime);
    if (prefTime < new Date(Date.now() - 5 * 60 * 1000)) {
      return "Preferred time cannot be in the past";
    }

    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);

    try {
      const rideRequest = await createRideRequest({
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        dropLat: drop.lat,
        dropLng: drop.lng,
        pickupAddress: pickup.displayName,
        dropAddress: drop.displayName,
        preferredTime: new Date(preferredTime).toISOString(),
      });
      dispatch({ type: "SET_RIDE_REQUEST", payload: rideRequest });
    } catch (err) {
      if (err.status === 409) {
        const requests = await getRideRequests("PENDING");
        if (requests.length > 0) {
          dispatch({ type: "SET_RIDE_REQUEST", payload: requests[0] });
          dispatch({
            type: "SET_NOTIFICATION",
            payload: {
              type: "info",
              message: "You already have an active ride request. View it here.",
            },
          });
          setLoading(false);
          return;
        }
      }

      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = !!pickup && !!drop && !!preferredTime && !loading;

  return (
    <form className="ride-request-form" onSubmit={handleSubmit}>
      <h2 className="form-title">Request a Ride</h2>
      <p
        className="form-subtitle"
        style={{
          color: "var(--text-muted)",
          fontSize: "0.875rem",
          marginBottom: "1.5rem",
          marginTop: "-0.5rem",
        }}
      >
        We'll group you with nearby riders heading the same way.
      </p>

      <LocationInput
        label="Pickup location"
        value={pickup}
        onSelect={handlePickupSelect}
        allowCurrentLocation={true}
        referenceLocation={drop}
      />

      <LocationInput
        label="Drop location"
        value={drop}
        onSelect={handleDropSelect}
        referenceLocation={pickup}
      />

      <div className="md3-input-group datetime-input-group">
        <label id={timeLabelId} className="md3-label">Preferred Time</label>
        <button
          type="button"
          aria-labelledby={timeLabelId}
          className="md3-input datetime-expressive"
          onClick={() => setDatePickerOpen(true)}
          style={{
            textAlign: "left",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
          }}
        >
          {formatDisplayTime(preferredTime)}
        </button>
        <div className="datetime-icon">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="24px"
            viewBox="0 -960 960 960"
            width="24px"
            fill="currentColor"
          >
            <path d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm-40-120 200-200-56-56-144 144v-208h-80v240l80 80Z" />
          </svg>
        </div>
      </div>

      <DateTimePickerModal
        isOpen={isDatePickerOpen}
        onClose={() => setDatePickerOpen(false)}
        initialDate={preferredTime}
        onConfirm={(newTime) => {
          setPreferredTime(newTime);
          setDatePickerOpen(false);
        }}
      />

      {error && <p className="form-error">{error}</p>}

      <button
        type="submit"
        className="fab-extended"
        style={{ width: "100%", marginTop: "16px" }}
        disabled={!canSubmit}
      >
        {loading ? "Submitting request..." : "Request Ride"}
      </button>
    </form>
  );
}
