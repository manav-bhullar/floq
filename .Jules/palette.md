## 2024-05-18 - Accessibility for Mapped Inputs
**Learning:** Mapped inputs (like OTP fields) require positional context for screen readers navigating the map.
**Action:** Always dynamically generate and apply `aria-label` attributes (e.g., `aria-label={\`Digit ${index + 1} of 6\`}`) to mapped input elements.
