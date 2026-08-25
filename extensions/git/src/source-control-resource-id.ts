const MAX_SOURCE_CONTROL_RESOURCE_ID_LENGTH = 480;

function hash(value: string, seed: number): string {
    let result = seed;
    for (const character of value) {
        result ^= character.codePointAt(0) ?? 0;
        result = Math.imul(result, 16_777_619);
    }
    return (result >>> 0).toString(36).padStart(7, '0');
}

/**
 * Preserves existing short identities while projecting a stable bounded ID for legal Git paths that exceed the
 * controlled-view schema. The full path remains in display, action, and authorized Runtime fields.
 */
export function boundedSourceControlResourceId(...parts: readonly string[]): string {
    const id = parts.join(':');
    if (id.length <= MAX_SOURCE_CONTROL_RESOURCE_ID_LENGTH) return id;
    const fingerprint = `${hash(id, 2_166_136_261)}${hash(id, 2_654_435_769)}`;
    const prefixLength = MAX_SOURCE_CONTROL_RESOURCE_ID_LENGTH - fingerprint.length - 1;
    return `${id.slice(0, prefixLength)}:${fingerprint}`;
}
