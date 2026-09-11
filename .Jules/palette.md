## 2023-10-27 - Custom UI Components Accessibility
**Learning:** This application makes use of custom React elements styled as standard form fields (e.g. using a `<button>` to look and function as a `<select>` dropdown for time picking). Due to not using native inputs for all form elements, simply using `<label htmlFor="id">` is insufficient and breaks screen reader focus.
**Action:** Always link custom mock inputs (like buttons used as selects) using `aria-labelledby` rather than `htmlFor`, and generate unique IDs for these dynamically using `useId()`.
