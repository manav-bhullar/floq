## 2026-08-26 - Accessible Form Inputs
**Learning:** Custom UI inputs and mocked select buttons lack native accessible labeling.
**Action:** Always use React's `useId()` to generate unique IDs linking `<label>` elements to custom interactive elements via `htmlFor` and `aria-labelledby`, ensuring focus support for screen readers.
