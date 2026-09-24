## 2024-05-24 - OTP Input Accessibility
**Learning:** React 19 mapped OTP inputs required dynamically generated `aria-label` properties for screen reader users to understand index positional context, especially on mobile forms.
**Action:** When rendering mapped input elements, always dynamically generate and apply `aria-label` attributes (e.g., `aria-label={"Digit " + (index + 1) + " of 6"}`).
