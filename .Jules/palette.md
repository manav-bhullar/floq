## 2026-09-29 - Form Validation Disabled Button Anti-Pattern
**Learning:** Disabling submit buttons based on missing form fields completely hides inline validation errors from users. React forms need an interactive submit button to run `validate()` and show helpful field-level error messages.
**Action:** Keep submit buttons enabled (except during loading states) to ensure inline error messages are accessible and visible to users.
