/**
 * Vite's ambient client types: `?raw` imports and `import.meta.glob`. Node-side contract tests import the files they
 * assert on this way instead of reading them with `fs`, so the changed-file check and Vitest's watch mode see each file
 * as the test's dependency. The Renderer program gets the same types from `tsconfig.web.json`.
 */
/// <reference types="vite/client" />
