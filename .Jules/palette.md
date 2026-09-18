## 2024-05-24 - Dynamic IDs for Custom Accessibility Components
**Learning:** Custom UI components (like dropdown inputs or mock-select buttons) in React require explicitly linked labels for screen readers. Static IDs will clash if a component is used multiple times on the same page.
**Action:** Use React `useId()` to generate unique IDs, linking `<label>` (via `htmlFor` or `id`) to inputs (`id`) or mock interactive elements (`aria-labelledby`).
