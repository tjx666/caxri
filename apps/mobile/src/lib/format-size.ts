/**
 * Renders a byte count in human units (B/KB/MB) instead of a raw byte figure, matching the Files panel's original
 * formatting; shared by the Files panel and the Session composer so both read sizes the same way.
 */
export function formatByteSize(size: number): string;
export function formatByteSize(size: number | undefined): string | null;
export function formatByteSize(size: number | undefined): string | null {
    if (size === undefined) return null;
    if (size < 1_024) return `${size} B`;
    if (size < 1_024 * 1_024) return `${Math.round(size / 1_024)} KB`;
    return `${(size / 1_024 / 1_024).toFixed(1)} MB`;
}
