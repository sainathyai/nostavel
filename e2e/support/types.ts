// The two theme mechanisms this suite has to distinguish (see
// e2e/support/theme.ts and the AC 5/6 specs): `light`/`dark` is the only
// vocabulary either one uses, whether driven by Playwright's `colorScheme`
// project setting (prefers-color-scheme) or by ThemeToggle's `data-theme`
// attribute.
export type Theme = "light" | "dark";
