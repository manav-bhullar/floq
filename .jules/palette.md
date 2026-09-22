## 2026-09-22 - CancelModal Cancel Button Loading State
**Learning:** When using React states to disable buttons or show loading states within a modal that doesn't re-mount, adding a quick visual loading state inside an asynchronous handler improves perceived performance, especially for destructive actions like 'Cancel Trip'.
**Action:** Always provide instant visual feedback ('Cancelling...') and disable action buttons within modals for asynchronous operations to prevent multiple submissions.
