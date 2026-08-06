import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Thin wrapper over `clsx` + `tailwind-merge` for conditional Tailwind class-name
 * composition: `clsx` resolves conditionals/arrays, `twMerge` dedupes conflicting
 * utilities (e.g. a caller-supplied `className` overriding a component's own `px-2`).
 */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
