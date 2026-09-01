## 2024-05-18 - Link custom input components to labels
**Learning:** For accessibility in custom UI components (like dropdown wrappers or buttons mocking selects), explicitly dynamically generate IDs using `useId()` and link them to labels using `htmlFor` and `aria-labelledby` to maintain screen reader focus.
**Action:** Use `useId()` in custom form components to pair `label` with interactive sub-elements.
