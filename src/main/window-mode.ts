export type E2EWindowMode = 'hidden' | 'visible';

/**
 * Production windows always remain visible. Only an E2E launch may suppress native presentation,
 * and focused tests default to that hidden path unless their fixture opts into desktop behavior.
 */
export function resolveE2EWindowMode(options: {
    isE2E: boolean;
    requestedMode?: string;
}): E2EWindowMode {
    if (!options.isE2E) return 'visible';
    return options.requestedMode === 'visible' ? 'visible' : 'hidden';
}
