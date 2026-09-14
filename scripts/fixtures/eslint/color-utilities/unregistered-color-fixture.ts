/**
 * Fixture for `caxri/registered-color-utilities`. Class names live in plain string constants rather than JSX because
 * the rule reads string literals wherever they appear, and `scripts/` is not compiled with JSX support.
 */

/**
 * The three shapes that reach the DOM and produce no CSS: a bare palette name, a shaded one, and `--selection`, which
 * is declared on `:root` but deliberately kept out of the `@theme inline` bridge, so it is dead in exactly the same way
 * `bg-white` is. The variant chain and the opacity modifier must not hide any of them.
 */
export const deadColorClasses = [
    'bg-white rounded-md p-2',
    'hover:bg-selection text-black/60',
    'text-blue-500',
];

/**
 * The sanctioned forms, which must stay silent: semantic roles from the bridge, the arbitrary-value escape hatch a raw
 * theme color is referenced through, and an arbitrary size that is not a color at all.
 */
export const liveColorClasses = [
    'border border-border bg-elevated text-foreground',
    'text-muted hover:bg-[var(--selection)]',
    'text-[12px] text-git-added',
];
