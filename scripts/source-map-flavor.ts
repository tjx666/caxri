import process from 'node:process';

export type SourceMapFlavor = 'include' | 'omit';

/**
 * Resolves the one build-wide Source Map flavor. An absent value keeps ordinary builds debuggable, while any explicit
 * typo fails before Desktop and Server can silently ship different artifacts.
 */
export function resolveSourceMapFlavor(
    environment: { CAXRI_SOURCE_MAPS?: string } = process.env,
): SourceMapFlavor {
    const value = environment.CAXRI_SOURCE_MAPS;
    if (value === undefined) return 'include';
    if (value === 'include' || value === 'omit') return value;
    throw new Error(
        `CAXRI_SOURCE_MAPS must be "include" or "omit"; received ${JSON.stringify(value)}`,
    );
}

export function shouldIncludeSourceMaps(flavor: SourceMapFlavor): boolean {
    return flavor === 'include';
}
