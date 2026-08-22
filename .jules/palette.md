## 2024-07-24 - Screen Reader Support for Split OTP Inputs
**Learning:** Split OTP inputs (e.g., 6 separate text fields for a 6-digit code) lack explicit association with a single `<label>`, making them highly confusing for screen reader users who might just hear "Edit text, blank" repeatedly.
**Action:** When implementing split input fields for a single piece of data (like an OTP), always add a descriptive `aria-label` to each individual input (e.g., `aria-label="Digit 1 of OTP"`) so users understand exactly which part of the code they are entering.
