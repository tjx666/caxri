import type { ClassValue } from 'clsx';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Thin wrapper over `clsx` + `tailwind-merge` for conditional Tailwind class-name composition: `clsx` resolves
 * conditionals/arrays, `twMerge` dedupes conflicting utilities (e.g. a caller-supplied `className` overriding a
 * component's own `px-2`).
 */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}

/**
 * Shell shared by the settings/keybindings/theme Monaco panes and their Suspense fallback shimmer (`SettingsPage`,
 * `KeybindingsForm`, `ThemeForm`, `ConfigEditor`).
 */
export const configEditorClassName = 'min-w-0 min-h-0 bg-background';

/**
 * Suspense-fallback shimmer while the lazy Monaco `ConfigEditor` loads. Kept as an `animate-[…]` utility referencing
 * the `configuration-loading` `@keyframes`, which stays in `styles.css` as global CSS: a `background-position` sweep
 * over a `color-mix` gradient isn't expressible as a Tailwind utility on its own.
 */
export const configEditorLoadingClassName = cn(
    configEditorClassName,
    'bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--elevated)_60%,transparent),transparent),var(--background)]',
    'bg-[length:180%_100%]',
    'animate-[configuration-loading_1.2s_ease_infinite]',
);
