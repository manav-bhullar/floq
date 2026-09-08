## 2024-05-18 - Missing loading state on destructive actions
**Learning:** Found that the CancelModal's destructive action (Confirm Cancel) lacked visual and a11y feedback during the async API call, allowing double clicks and leaving users in the dark.
**Action:** Always add loading states (e.g. \`disabled\` + \`aria-busy\`) to buttons triggering async backend requests (especially destructive ones).
