/**
 * Formats a byte count for compact UI display: whole bytes below 1 KB, otherwise one decimal in binary (1024-based)
 * KB/MB.
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
