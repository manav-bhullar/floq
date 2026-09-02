## 2024-05-24 - Accessible Custom Input Components
**Learning:** Custom UI components in React (like location search inputs or dropdown wrappers) often lack proper label association, failing to maintain screen reader context.
**Action:** Use React 19's `useId` to dynamically generate IDs. Explicitly link `<label>` elements to custom input elements using `htmlFor`/`id`, and use `aria-labelledby` for custom interactive elements (like a `<button>` mocking a date picker) to properly associate them with their textual labels.
