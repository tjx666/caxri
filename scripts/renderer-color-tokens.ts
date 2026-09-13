/**
 * The Renderer's color vocabulary, restated for tooling that cannot read CSS.
 *
 * `apps/desktop/src/renderer/src/styles/theme.css` is the source of truth; an ESLint rule runs synchronously and may
 * not read a file, so these two lists mirror it the same way `architecture-boundaries.ts` mirrors the package graph.
 * `scripts/__tests__/renderer-color-tokens.test.ts` parses the stylesheet and fails when either list drifts.
 */

/**
 * Semantic roles bridged into Tailwind by `@theme inline`. These are the only color tokens a utility may name.
 */
export const registeredColorRoles = [
    'accent',
    'accent-foreground',
    'background',
    'badge',
    'badge-foreground',
    'border',
    'danger',
    'danger-foreground',
    'elevated',
    'foreground',
    'git-added',
    'git-conflicting',
    'git-deleted',
    'git-modified',
    'git-untracked',
    'indicator',
    'merged',
    'muted',
    'overlay',
    'shadow',
    'success',
    'surface',
    'warning',
];

/**
 * Colors declared on `:root` but deliberately left out of the bridge, so they have no utility of their own and are
 * referenced as `bg-[var(--selection)]`. A utility that names one produces no CSS.
 */
export const rawOnlyColorNames = ['selection'];

/**
 * Tailwind's built-in palette, which `@theme { --color-*: initial }` unregisters. A closed upstream set that only
 * changes when Tailwind ships a new major; reading it back out of the installed package would make the rule depend on
 * resolution order inside `node_modules`.
 */
export const tailwindPaletteNames = [
    'amber',
    'black',
    'blue',
    'cyan',
    'emerald',
    'fuchsia',
    'gray',
    'green',
    'indigo',
    'lime',
    'neutral',
    'orange',
    'pink',
    'purple',
    'red',
    'rose',
    'sky',
    'slate',
    'stone',
    'teal',
    'violet',
    'white',
    'yellow',
    'zinc',
];
