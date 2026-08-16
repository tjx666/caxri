/**
 * `@yutengjing/prettier-config` (v2.0.0) ships a plain `index.js` with no bundled or `@types` declarations, so this
 * repository declares its default-exported static config object locally for `prettier.config.ts`.
 */
declare module '@yutengjing/prettier-config' {
    import type { Config } from 'prettier';

    const sharedPrettierConfig: Config;

    export default sharedPrettierConfig;
}
