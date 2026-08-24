## 2024-05-18 - TopNav Logout Modal Focus Trapping
**Learning:** For a11y, it's crucial to trap focus within active modals, using a `tabindex` query, so keyboard users don't interact with hidden page elements.
**Action:** When implementing modal/dialog dialogs, use standard focus management by capturing keyboard events (e.g. Tab/Shift+Tab, Escape) on mount using `useRef` and `useEffect`.
