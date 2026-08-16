<!--
Negative fixture proving ESLint's `markdownProcessorConfig` lints fenced JS/TS code blocks inside
Markdown. The fenced block below is a virtual `.ts` child file once the `@eslint/markdown`
processor extracts it, so the shared TypeScript config's `no-debugger` rule fires on it exactly as
it would on a real source file. `scripts/fixtures/markdown` is excluded from `eslint.config.ts`'s
real `globalIgnores`, so `scripts/__tests__/markdown-toolchain-contract.test.ts` lints this file
directly instead.
-->

# Fixture document

```ts
export function triggerDebuggerStatement(): void {
  debugger;
}
```
