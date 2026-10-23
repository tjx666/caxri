/**
 * Insertion-ordered maps the Project file watcher keeps bounded: polled directory signatures and recent change
 * fingerprints. Each evicts its oldest entries once it passes `maximum`.
 */

/**
 * Finds the oldest evictable key (Map iteration order's first key other than `protectedRoot`). Kept as its own function
 * (rather than nested inside `rememberPolledDirectory`'s `while` loop) so its `continue`/`break` control flow stays
 * scoped to a single loop.
 */
function oldestEvictableKey<T>(
    directories: ReadonlyMap<string, T>,
    protectedRoot: string | undefined,
): string | undefined {
    for (const path of directories.keys()) {
        if (path === protectedRoot) continue;
        return path;
    }
    return undefined;
}

export function rememberPolledDirectory<T>(
    directories: Map<string, T>,
    directory: string,
    value: T,
    protectedRoot: string | undefined,
    maximum: number,
): void {
    directories.delete(directory);
    directories.set(directory, value);
    while (directories.size > Math.max(1, maximum)) {
        const candidate = oldestEvictableKey(directories, protectedRoot);
        if (!candidate) return;
        directories.delete(candidate);
    }
}

export function didFingerprintChange(
    fingerprints: Map<string, string>,
    path: string,
    fingerprint: string,
    maximum: number,
): boolean {
    if (fingerprints.get(path) === fingerprint) return false;
    fingerprints.delete(path);
    fingerprints.set(path, fingerprint);
    while (fingerprints.size > Math.max(1, maximum)) {
        const oldest = fingerprints.keys().next().value;
        if (!oldest) break;
        fingerprints.delete(oldest);
    }
    return true;
}
