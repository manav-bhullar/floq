## $(date +%Y-%m-%d) - Form Error Accessibility
**Learning:** React 19 apps sometimes neglect dynamic error announcements. When auth or form errors appear dynamically without triggering a page reload or standard focus change, screen readers miss them.
**Action:** Always add `role="alert"` and `aria-live="assertive"` to the static container wrapping dynamically injected auth errors. For array mapped inputs (like OTP boxes), dynamically bind `aria-label` to provide positional context (e.g. `Digit ${index + 1} of 6`).
