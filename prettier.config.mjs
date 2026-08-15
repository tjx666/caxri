import sharedPrettierConfig from '@yutengjing/prettier-config';

/**
 * `@yutengjing/prettier-config`'s published API (v2.0.0) is a static default-exported config object, not a
 * `createPrettierConfig(options)` factory: it already resolves `prettier-plugin-jsdoc` and `@prettier/plugin-xml`, and
 * appends `prettier-plugin-tailwindcss` last in `plugins` when that package is installed (see
 * `node_modules/@yutengjing/prettier-config/index.js`). Tailwind-specific options aren't part of that factory surface,
 * so they're layered on here instead.
 */
export default {
    ...sharedPrettierConfig,
    tailwindFunctions: ['cn', 'cva'],
    tailwindStylesheet: './src/renderer/src/styles/theme.css',
};
