import type { AgentChatPathReference } from '@caxri/protocol';

import { isOsFileReferenceRefused } from '../../lib/file-drag';

/**
 * Whether `file`, from another application, is a folder. Chromium hands a dropped or pasted folder over as a `File`
 * whose bytes cannot be read, so reading its first byte fails; an empty file reads as nothing instead.
 */
async function isFolder(file: File): Promise<boolean> {
    try {
        await file.slice(0, 1).arrayBuffer();
        return false;
    } catch {
        return true;
    }
}

/**
 * The files and folders among `files` (dropped, pasted, or picked from another application) that have a path on this
 * Mac, as path references. A file promise such as a Photos item has no path and is left out, and an SSH Host window
 * takes none (`isOsFileReferenceRefused`).
 */
export async function agentChatOsFileReferences(
    files: readonly File[],
): Promise<AgentChatPathReference[]> {
    if (isOsFileReferenceRefused()) return [];
    const references = await Promise.all(
        files.map(async (file) => {
            const path = globalThis.caxri.pathForFile(file);
            return path ? { path, isDirectory: await isFolder(file) } : undefined;
        }),
    );
    return references.filter((reference) => reference !== undefined);
}
