/**
 * Normalizes a user-typed font-family setting into a CSS `font-family` list entry. A bare name containing spaces is
 * quoted for the CSS parser; values that already carry quotes or their own comma-separated stack pass through
 * untouched. Returns `undefined` for unset/blank input so callers can fall back to their default stack.
 */
export function cssFontFamilyEntry(custom: string | null | undefined): string | undefined {
    const trimmed = custom?.trim();
    if (!trimmed) return undefined;
    const needsQuotes = trimmed.includes(' ') && !/[,"']/.test(trimmed);
    return needsQuotes ? `"${trimmed}"` : trimmed;
}
