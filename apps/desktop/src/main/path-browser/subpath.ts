/**
 * Pure helpers behind the path browser's VS Code-style subpath fallback (`packages/x/` typed while the Project holds
 * `example/packages/x/`). Filesystem validation stays in the authority.
 */

/**
 * Splits a Project-relative browse input into the directory segments that must exist as a path suffix. Returns
 * `undefined` for input the subpath fallback must not touch: home, absolute, dot-relative, or filter-only input.
 */
export function projectSubpathSuffix(input: string): string[] | undefined {
    if (input.startsWith('/') || input.startsWith('~')) return undefined;
    // Drop the final filter segment (or the empty segment after a trailing slash).
    const segments = input.split('/').slice(0, -1);
    if (segments.length === 0) return undefined;
    if (segments.some((segment) => !segment || segment === '.' || segment === '..'))
        return undefined;
    return segments;
}

/**
 * Looks up the memo for `key` or any shorter suffix it extends. `null` means the Project is known to hold no such
 * directory (a negative entry covers every deeper suffix), a string is the located prefix directory to try first, and
 * `undefined` means Server Core must be asked.
 */
export function memoizedSubpathPrefix(
    memo: ReadonlyMap<string, string | null>,
    key: string,
): string | null | undefined {
    let best: { key: string; prefix: string | null } | undefined;
    for (const [cachedKey, prefix] of memo) {
        if (key !== cachedKey && !key.startsWith(`${cachedKey}/`)) continue;
        if (!best || cachedKey.length > best.key.length) best = { key: cachedKey, prefix };
    }
    return best?.prefix;
}
