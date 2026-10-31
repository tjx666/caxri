import { parseFileLocation } from '@caxri/protocol';

/**
 * A file an Agent cited, as the file viewer opens it: the path the Server resolves against the Session (absolute, or
 * relative to its Workbench root), its last segment for the title, and the lines the citation named, if any.
 */
export interface FileViewerTarget {
    endLine?: number;
    name: string;
    path: string;
    startLine?: number;
}

/**
 * Reads a cited reference (`src/a.ts:12`, `/repo/a.md#L3-L5`, `a.json`) the way Desktop's Chat opens one
 * (`parseFileLocation`). A malformed location (`a.ts#L5-L2`) still opens the file, at its top.
 */
export function fileViewerTarget(reference: string): FileViewerTarget {
    const { location, target } = parseFileLocation(reference.trim());
    const path = target.replace(/\/+$/u, '') || target;
    const name = path.slice(path.lastIndexOf('/') + 1) || path;
    if (!location) return { name, path };
    return location.mode === 'caret'
        ? { endLine: location.line, name, path, startLine: location.line }
        : { endLine: location.endLine, name, path, startLine: location.startLine };
}

/**
 * Whether a zero-based line index falls in the cited range, which the viewer tints.
 */
export function isFileViewerLineCited(target: FileViewerTarget, index: number): boolean {
    if (target.startLine === undefined) return false;
    const line = index + 1;
    return line >= target.startLine && line <= (target.endLine ?? target.startLine);
}

/**
 * The line the viewer scrolls to first: a little above the cited one, so it does not sit flush against the header. `0`
 * without a citation, and never past the last line.
 */
export function fileViewerInitialLine(target: FileViewerTarget, lineCount: number): number {
    if (lineCount === 0 || target.startLine === undefined) return 0;
    return Math.min(Math.max(target.startLine - 1 - 3, 0), lineCount - 1);
}
