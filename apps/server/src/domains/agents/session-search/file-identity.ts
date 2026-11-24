import { lstat } from 'node:fs/promises';

import { antigravityConversationStamp } from '../providers/antigravity/conversation-database';
import type { StoredTranscript } from './store';

export interface FileIdentity {
    inode: number;
    size: number;
    mtimeMs: number;
}

/**
 * An Antigravity conversation is a SQLite database whose recent writes sit in its write-ahead log, so its identity
 * covers both files.
 */
export async function transcriptIdentity(
    provider: StoredTranscript['provider'],
    path: string,
): Promise<FileIdentity | undefined> {
    if (provider !== 'antigravity') return fileIdentity(path);
    const stamp = await antigravityConversationStamp(path);
    return stamp && { inode: stamp.inode, size: stamp.size, mtimeMs: stamp.mtimeMs };
}

export async function fileIdentity(path: string): Promise<FileIdentity | undefined> {
    try {
        const stats = await lstat(path);
        if (!stats.isFile()) return;
        return { inode: stats.ino, size: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) };
    } catch {
        return undefined;
    }
}

export function isUnchanged(stored: StoredTranscript | undefined, identity: FileIdentity): boolean {
    return (
        stored !== undefined &&
        stored.inode === identity.inode &&
        stored.size === identity.size &&
        stored.mtimeMs === identity.mtimeMs
    );
}

export function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}
