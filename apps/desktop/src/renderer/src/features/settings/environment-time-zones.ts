/**
 * Chromium ships the current IANA catalog; include the current zone and UTC even when the catalog aliases one of them.
 */
export function environmentTimeZones(): string[] {
    const values = Intl.supportedValuesOf('timeZone');
    const current = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return [...new Set([...values, current, 'UTC'].filter(Boolean))].toSorted((left, right) =>
        left.localeCompare(right),
    );
}
