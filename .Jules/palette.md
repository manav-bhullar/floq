## 2026-09-28 - Dynamic ARIA Labeling for Custom Form Controls
**Learning:** Using React's `useId` hook effectively binds standard labels to custom inputs and mock-select elements (like button-based date pickers). This ensures screen readers correctly associate the semantic label with the interactive component, overcoming limitations of elements that lack native implicit labeling.
**Action:** Always utilize `useId` to programmatically generate IDs and link them using `htmlFor` on the label and `id` or `aria-labelledby` on the custom element, especially in custom UI wrappers.
