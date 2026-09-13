## 2024-05-18 - Missing ID for Form Inputs
**Learning:** React 19's `useId` is available and should be used to dynamically link input labels and input fields inside custom components without generating global collisions, improving screen reader experience significantly.
**Action:** Always implement `useId` for inputs wrapping custom components, explicitly applying it to the inner `<input id={inputId}>` and `<label htmlFor={inputId}>`.
