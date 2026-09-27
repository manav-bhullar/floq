## 2024-05-14 - Add aria-label to mapped form input elements
**Learning:** Mapped input fields (such as OTP inputs) lack positional context for screen readers when they are rendered. While the visual layout implicitly indicates their sequence, assistive technologies need an explicit label.
**Action:** When rendering mapped input elements, always dynamically generate and apply `aria-label` attributes (e.g., `aria-label={"Digit ${index + 1} of 6"}`) to provide positional context for screen readers navigating the map.
