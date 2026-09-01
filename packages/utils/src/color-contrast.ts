import { sortedCopy } from './sorted-copy.js';

/**
 * Computes WCAG relative luminance for an sRGB `#rrggbb` or `#rrggbbaa` color, ignoring an alpha suffix. Callers must
 * resolve transparency before using this value for a contrast guarantee.
 */
export function relativeLuminance(hexColor: string): number {
    const hex = hexColor.replace('#', '');
    const linearize = (value: number): number =>
        value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    const channels = [0, 2, 4].map((start) =>
        linearize(Number.parseInt(hex.slice(start, start + 2), 16) / 255),
    );
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * Computes the WCAG contrast ratio between two opaque sRGB `#rrggbb` colors.
 */
export function contrastRatio(first: string, second: string): number {
    const [lighter, darker] = sortedCopy(
        [relativeLuminance(first), relativeLuminance(second)],
        (left, right) => right - left,
    );
    return (lighter + 0.05) / (darker + 0.05);
}
