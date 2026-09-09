import { caxri } from './caxri';

/**
 * Linked folders participate in lazy navigation without losing their symlink identity.
 */
export function isDirectoryEntry(entry: { kind?: string; linkKind?: string }): boolean {
    return (
        entry.kind === 'directory' || (entry.kind === 'symlink' && entry.linkKind === 'directory')
    );
}

/**
 * Target display metadata can be stale or absent after a probe timeout; activation asks the Server for its current
 * kind.
 */
export async function resolveEntryKind(
    sessionId: string,
    entry: { kind: 'file' | 'directory' | 'symlink'; path: string },
): Promise<'file' | 'directory'> {
    if (entry.kind !== 'symlink') return entry.kind;
    return caxri.request('files.resolveKind', { sessionId, path: entry.path });
}
