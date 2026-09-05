/**
 * Expands a closed-enum counter map into flat, greppable log fields (`turnFinished` → `phaseTurnFinished`). Log records
 * cannot nest, and one field per enum member keeps a summary analyzable with `jq` alone. The key space is bounded by
 * the enum, so this never produces unbounded field names.
 */
export function countFields(
    prefix: string,
    counts: ReadonlyMap<string, number>,
): Record<string, number> {
    return Object.fromEntries(
        [...counts].map(([key, count]) => [
            `${prefix}${key[0].toUpperCase()}${key.slice(1)}`,
            count,
        ]),
    );
}
