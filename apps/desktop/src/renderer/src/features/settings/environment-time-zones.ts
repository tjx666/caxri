const CURRENT_TIME_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Chromium ships the current IANA catalog; include the current zone and UTC even when the catalog aliases one of them.
 */
export function environmentTimeZones(): string[] {
    const values = Intl.supportedValuesOf('timeZone');
    return [...new Set([...values, CURRENT_TIME_ZONE, 'UTC'].filter(Boolean))].toSorted(
        (left, right) => left.localeCompare(right),
    );
}
