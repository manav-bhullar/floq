## $(date +%Y-%m-%d) - Dynamic IDs for Custom UI Accessibility
**Learning:** When building custom UI components in React that mock native form elements (like complex dropdowns or custom datetime buttons), missing IDs break screen reader context since standard `htmlFor` and `aria-labelledby` linkages cannot be established.
**Action:** Always use `useId` to dynamically generate unique IDs for these custom inputs, then explicitly associate them using `htmlFor` on labels and `aria-labelledby` on the mock inputs (like buttons acting as dropdown triggers).
