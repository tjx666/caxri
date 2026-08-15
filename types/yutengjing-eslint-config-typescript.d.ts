/**
 * `@yutengjing/eslint-config-typescript` ships no type declarations (see its `package.json`,
 * which has no `types`/`typings` field). Without this ambient module, TS synthesizes an
 * unresolvable type for its named exports, which surfaces as
 * `@typescript-eslint/no-unsafe-argument` on every `defineConfig(...)` call site in
 * `eslint.config.ts`.
 *
 * `typescriptConfig`/`typeCheckedConfig` are produced by `typescript-eslint`'s `tseslint.config(...)`
 * helper, whose own return type is `typescript-eslint`'s `ConfigArray`. That type's
 * `languageOptions` shape comes from `@typescript-eslint/utils`, which is not structurally
 * assignable to `eslint/config`'s `defineConfig(...)` parameter type (`@eslint/core`'s
 * `ConfigObject`, missing an index signature). Declare these exports against `defineConfig`'s own
 * expected element type instead, since that is the only shape this module's exports are actually
 * consumed as in `eslint.config.ts`.
 */
declare module '@yutengjing/eslint-config-typescript' {
    import type { ConfigWithExtends } from 'eslint/config';

    export const typescriptConfig: ConfigWithExtends[];
    export const typeCheckedConfig: ConfigWithExtends[];
    export const markdownRulesConfig: ConfigWithExtends[];
    export const markdownProcessorConfig: ConfigWithExtends[];
    export const eslintConfigPrettier: ConfigWithExtends[];
}
