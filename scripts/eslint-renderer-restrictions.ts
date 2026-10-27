import { browserUnsafeImports } from './architecture-boundaries';

const rendererUnsafePackageImports = browserUnsafeImports.flatMap((specifier) =>
    specifier === 'electron' ? [] : [specifier, `${specifier}/*`],
);
/**
 * Renderer import bans shared by the general Renderer block and the i18n wrapper override, which re-declares the rule
 * without the UI-kit ban because a later flat-config block replaces a rule's options instead of merging them.
 */
export const rendererPlatformImportPatterns = [
    {
        group: ['@caxri/system', '@caxri/system/*'],
        message:
            '@caxri/system is not browser-safe; the Renderer must use a typed protocol or Desktop bridge.',
    },
    {
        group: ['electron', 'electron/*'],
        message:
            'The renderer must never import Electron APIs directly; use the typed window.caxri bridge.',
    },
    {
        group: ['node:*'],
        message:
            'The renderer must never import Node.js builtins directly; use the typed window.caxri bridge.',
    },
    {
        group: ['fs', 'path', 'child_process', 'os'],
        message:
            'The renderer must never import Node.js builtins directly; use the typed window.caxri bridge.',
    },
    {
        group: rendererUnsafePackageImports,
        message:
            'The renderer must never import platform-only packages directly; use the typed window.caxri bridge.',
    },
];
/**
 * `@lobehub/ui` is accepted only as the i18n runtime (stack-baseline.md, "Accepted runtime exception"). Its components
 * pull antd and Emotion, so the rest of the Renderer must keep using Base UI primitives and the design-token CSS.
 */
export const rendererUiKitImportPattern = {
    group: ['@lobehub/ui', '@lobehub/ui/*', 'antd', 'antd/*', '@emotion/*'],
    message:
        '@lobehub/ui is accepted only as the i18n runtime; import translations from apps/desktop/src/renderer/src/i18n and use Base UI primitives for components.',
};
/**
 * Renderer date and number formatting must follow the interface language (`workbench.language`), not the system locale
 * that a bare `toLocaleString()` or `Intl.DateTimeFormat(undefined)` resolves to. See docs/i18n.md "Dates and
 * numbers".
 */
export const rendererLocaleFormatRestrictions = [
    {
        selector: 'CallExpression[callee.property.name=/^toLocale(?:Date|Time)?String$/]',
        message:
            'toLocaleString, toLocaleDateString, and toLocaleTimeString follow the system locale; use localeDateTimeFormat, localeNumberFormat, or formatCount from apps/desktop/src/renderer/src/lib/locale-format.ts.',
    },
    {
        selector:
            'NewExpression[callee.object.name="Intl"][callee.property.name=/^(?:DateTimeFormat|NumberFormat)$/][arguments.0.type="Identifier"][arguments.0.name="undefined"]',
        message:
            'Intl formatters built with an undefined locale follow the system locale; use localeDateTimeFormat or localeNumberFormat from apps/desktop/src/renderer/src/lib/locale-format.ts.',
    },
    {
        selector:
            'NewExpression[callee.object.name="Intl"][callee.property.name="NumberFormat"][arguments.length=0]',
        message:
            'Intl.NumberFormat() follows the system locale; use localeNumberFormat or formatCount from apps/desktop/src/renderer/src/lib/locale-format.ts.',
    },
];

/**
 * `navigator.clipboard` writes reject with `NotAllowedError` whenever the document lacks focus: after a native context
 * menu closes, or when an OSC 52 copy arrives while another app is in front. Renderer copies go through Main's
 * `clipboard.write` via `apps/desktop/src/renderer/src/lib/clipboard.ts`. Reads stay allowed: they run from a focused
 * paste shortcut.
 */
export const rendererClipboardWriteRestrictions = [
    {
        selector:
            'MemberExpression[object.object.name="navigator"][object.property.name="clipboard"][property.name=/^write(?:Text)?$/]',
        message:
            'navigator.clipboard writes fail without document focus; use writeClipboardText or writeClipboardContent from apps/desktop/src/renderer/src/lib/clipboard.ts.',
    },
];
