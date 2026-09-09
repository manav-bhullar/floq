## 2023-10-27 - [Dynamic ID Generation for Custom UI and Mock Selects]
**Learning:** Hardcoded IDs in custom UI components and mock selects present a recurring issue. When they are reused across forms or pages, these IDs collide, breaking screen-reader `htmlFor` and `aria-labelledby` relations.
**Action:** Always leverage React 19's `useId()` hook to generate unique IDs internally for these components, guaranteeing uniqueness across the DOM structure.
