/**
 * The host label a phone shows for this Desktop: the machine name's first DNS label, stripped to letters, digits,
 * spaces, `_`, and `-`, and bounded to 100 characters.
 */
export const mobileHostDisplayName = (source: string): string =>
    source
        .split('.', 1)[0]
        .replaceAll(/[^\p{L}\p{N} _-]/gu, '')
        .trim()
        .slice(0, 100) || 'Caxri Host';
