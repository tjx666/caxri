/**
 * Formats a byte count for compact UI display: whole bytes below 1 KB, otherwise one decimal in binary (1024-based)
 * KB/MB/GB. A count this large is exceptional (a Terminal's process tree, a stray cache) rather than routine, so it
 * still gets one decimal instead of falling back to whole GB and losing the only precision that distinguishes it from
 * its neighbors.
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
