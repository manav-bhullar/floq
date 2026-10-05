import { createContext, useContext, useReducer, useMemo } from "react";
import { deriveUIState } from "../utils/stateUtils";

// eslint-disable-next-line react-refresh/only-export-components
export const AppContext = createContext(null);

const initialState = {
  // Canonical source state
  rideRequest: null,
  trip: null,

  // Derived (kept for backward compatibility until next pass)
  uiState: "IDLE",

  // Loading / error buckets required by canonical shape
  loading: {
    init: true,
    submitting: false,
    cancelling: false,
    completing: false,
  },
  error: null,

  // Backwards-compatible fields (deprecated)
  notification: null,
  isInitializing: true,
};

function init(initial) {
  return initial;
}

function reducer(state, action) {
  switch (action.type) {
    case "SYNC_LIFECYCLE": {
      const { rideRequest, trip, reason } = action.payload;
      return {
        ...state,
        rideRequest,
        trip,
        uiState: deriveUIState(rideRequest, trip),
        loading: { ...state.loading, init: false },
        isInitializing: false,
        notification: reason ? { type: "warning", message: reason } :
          (state.notification?.type === "error" ? null : state.notification),
      };
    }

    case "INIT_COMPLETE": {
      const { rideRequest, trip } = action.payload;

      return {
        ...state,
        rideRequest: rideRequest || null,
        trip: trip || null,
        uiState: deriveUIState(rideRequest, trip),
        loading: { ...state.loading, init: false },
        isInitializing: false,
      };
    }

    case "SET_RIDE_REQUEST": {
      const rideRequest = action.payload;

      if (state.isInitializing) {
        return {
          ...state,
          rideRequest,
        };
      }

      return {
        ...state,
        rideRequest,
        uiState: deriveUIState(rideRequest, state.trip),
      };
    }

    case "SET_TRIP": {
      const rideRequest = state.rideRequest;
      const trip = action.payload;
      const derived = deriveUIState(rideRequest, trip);

      if (state.isInitializing) {
        return {
          ...state,
          trip,
        };
      }

      if (derived === "REQUEUED") {
        return {
          ...state,
          trip: null,
          uiState: "PENDING",
          notification: {
            type: "warning",
            message:
              "A co-rider cancelled. You've been returned to the queue with your original search priority — you won't lose your place.",
          },
        };
      }

      return {
        ...state,
        trip,
        uiState: derived,
      };
    }

    case "SET_NOTIFICATION": {
      return {
        ...state,
        notification: action.payload,
      };
    }

    case "CLEAR_NOTIFICATION": {
      return {
        ...state,
        notification: null,
      };
    }

    case "RESET": {
      return {
        ...initialState,
        loading: { ...initialState.loading, init: false },
        isInitializing: false,
      };
    }

    default:
      return state;
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState, init);

  const value = useMemo(() => ({ state, dispatch }), [state]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useApp() {
  const ctx = useContext(AppContext);

  if (!ctx) {
    throw new Error("useApp must be used inside AppProvider");
  }

  return ctx;
}
