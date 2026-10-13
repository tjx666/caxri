export type SourceMapFlavor = 'include' | 'omit';

/**
 * Old or externally assembled builds may not carry the flavor marker. They retain the historical debuggable update
 * channel instead of accidentally switching to the opt-in no-map artifact.
 */
export function normalizeSourceMapFlavor(value: unknown): SourceMapFlavor {
    return value === 'omit' ? 'omit' : 'include';
}

export function packagedSourceMapFlavor(): SourceMapFlavor {
    return normalizeSourceMapFlavor(
        typeof __CAXRI_SOURCE_MAP_FLAVOR__ === 'string' ? __CAXRI_SOURCE_MAP_FLAVOR__ : undefined,
    );
}

export function releaseDmgFileName(version: string, flavor: SourceMapFlavor): string {
    const suffix = flavor === 'omit' ? '-nosourcemap' : '';
    return `Caxri-${version}-arm64${suffix}.dmg`;
}
