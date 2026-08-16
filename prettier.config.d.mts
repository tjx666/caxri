import type { Config } from 'prettier';

/**
 * Sibling declaration file for `prettier.config.mjs`. TS has no way to type-check a plain `.mjs` module without
 * `allowJs`, which this repository intentionally keeps off for Main/Preload/Runtime and tooling code; TS auto-resolves
 * this `.d.mts` file for any import of `./prettier.config.mjs` (including the relative import from
 * `scripts/__tests__/prettier-toolchain-contract.test.ts`) without needing the `.mjs` file itself to be added to a
 * tsconfig `include` list.
 */
declare const prettierConfig: Config & {
    tailwindFunctions?: string[];
    tailwindStylesheet?: string;
};

export default prettierConfig;
