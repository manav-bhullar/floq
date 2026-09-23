## 2026-09-23 - Dynamic ARIA labels for mapped inputs
**Learning:** When rendering mapped input elements (like OTP fields), screen readers lack positional context unless explicitly provided.
**Action:** Always dynamically generate and apply `aria-label` attributes (e.g., `aria-label={"Digit " + (index + 1) + " of 6"}`) to mapped inputs to improve accessibility.
