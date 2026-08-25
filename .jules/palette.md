## 2024-05-24 - A11y linkage for custom UI components
**Learning:** Custom UI elements like dropdown wrappers or mocked inputs (like buttons imitating selects) can break screen reader focus and flow if `htmlFor` and `aria-labelledby` are disconnected from dynamic inputs.
**Action:** Always dynamically generate IDs for inputs wrapped in generic components and explicitly link mock inputs to their labels using `aria-labelledby`.
