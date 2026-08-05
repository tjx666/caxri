import { clsx, type ClassValue } from 'clsx';

/**
 * Thin wrapper over `clsx` for conditional class-name composition.
 *
 * Historically this also ran output through `tailwind-merge` to dedupe
 * conflicting Tailwind utility classes, but the app now uses hand-written
 * semantic CSS classes exclusively, so the merge step is unnecessary.
 */
export function cn(...inputs: ClassValue[]): string {
    return clsx(inputs);
}
