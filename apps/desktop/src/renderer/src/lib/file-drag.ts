import type { DragEvent } from 'react';

import type { TerminalRecord } from '@caxri/protocol';

import { isAgentProcessRunning } from './terminal-agent-runtime';

/**
 * Custom MIME type carrying a Files entry's absolute path to internal Caxri drop targets.
 */
export const FILE_TREE_DRAG_TYPE = 'application/x-caxri-file-path';

/**
 * Path references allow Terminal insertion without granting Files move operations.
 */
const FILE_REFERENCE_DRAG_TYPE = 'application/x-caxri-file-reference';

export function startFilePathDrag(
    dataTransfer: DataTransfer,
    path: string,
    isMovable: boolean,
): void {
    dataTransfer.effectAllowed = isMovable ? 'copyMove' : 'copy';
    dataTransfer.setData(isMovable ? FILE_TREE_DRAG_TYPE : FILE_REFERENCE_DRAG_TYPE, path);
}

/**
 * The type Chromium gives a drag that carries files from another application, such as Finder or a screenshot thumbnail.
 */
const OS_FILES_DRAG_TYPE = 'Files';

export function hasOsFiles(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
    return dataTransfer.types.includes(OS_FILES_DRAG_TYPE);
}

/**
 * The paths a drop inserts into a Terminal. A Caxri Files entry carries its own path; files from another application
 * resolve through {@link osFilePaths}. `files` narrows which dropped files count, for a target that takes some of them
 * another way.
 */
export function terminalDragPaths(
    event: DragEvent,
    files: Iterable<File> = event.dataTransfer.files,
): string[] {
    const path = event.dataTransfer.getData(FILE_REFERENCE_DRAG_TYPE) || dragPath(event);
    if (path) return [path];
    return osFilePaths(files);
}

/**
 * The on-disk paths of files from another application or a file picker. The page cannot read them, so the preload
 * resolves each one; a file with no path on disk (a file promise such as a Photos item) resolves to `''` and is left
 * out.
 */
export function osFilePaths(files: Iterable<File>): string[] {
    return Array.from(files, (file) => globalThis.caxri.pathForFile(file)).filter(Boolean);
}

export function hasTerminalDraggedPath(event: DragEvent): boolean {
    return (
        event.dataTransfer.types.includes(FILE_REFERENCE_DRAG_TYPE) ||
        hasOsFiles(event.dataTransfer) ||
        hasDraggedPath(event)
    );
}

function isWithinDirectory(path: string, directory: string): boolean {
    const base = stripTrailingSeparators(directory);
    return path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`);
}

/**
 * Agent worktree observation supersedes launch cwd only for resolving inserted references.
 *
 * `workbenchRoot` is the Session's Workbench Root. An Agent that moved into a linked worktree with `cd` rather than a
 * reported `EnterWorktree` leaves `agentCwd` unset while Files, Git, and the Workbench Root all follow the worktree, so
 * every path dragged from them fell outside the launch cwd and pasted absolute. While that Agent runs, a path inside
 * the Workbench Root but outside the launch cwd is written relative to the Workbench Root. A plain shell keeps its own
 * cwd: its relative paths resolve against where it actually stands, not against the Session's worktree.
 */
export function terminalReferencePath(
    path: string,
    terminal: Pick<TerminalRecord, 'agentCwd' | 'cwd' | 'lastAgentProcessState'>,
    workbenchRoot?: string,
): string {
    if (!isAgentProcessRunning(terminal.lastAgentProcessState))
        return terminalInputPath(path, terminal.cwd);
    if (terminal.agentCwd) return terminalInputPath(path, terminal.agentCwd);
    const baseDirectory =
        workbenchRoot &&
        !isWithinDirectory(path, terminal.cwd) &&
        isWithinDirectory(path, workbenchRoot)
            ? workbenchRoot
            : terminal.cwd;
    return terminalInputPath(path, baseDirectory);
}

/**
 * Project roots insert absolute paths without participating in Files move operations.
 */
export const PROJECT_PATH_DRAG_TYPE = 'application/x-caxri-project-path';

/**
 * Project drops retain their absolute identity even inside the destination Terminal's cwd.
 */
export function projectTerminalInput(
    dataTransfer: Pick<DataTransfer, 'getData'>,
): string | undefined {
    const path = dataTransfer.getData(PROJECT_PATH_DRAG_TYPE);
    return path ? terminalInputPath(path) : undefined;
}

export function dragPath(event: DragEvent): string | undefined {
    return event.dataTransfer.getData(FILE_TREE_DRAG_TYPE) || undefined;
}

export function hasDraggedPath(event: DragEvent): boolean {
    return event.dataTransfer.types.includes(FILE_TREE_DRAG_TYPE);
}

function stripTrailingSeparators(path: string): string {
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * Rewrites an absolute path as the shortest form a shell running in `baseDirectory` resolves to the same entry. Paths
 * inside the base become relative (`src/index.ts`, `.` for the base itself); anything else stays absolute because a
 * `../`-chain is neither shorter nor clearer than the absolute path it replaces. A relative path that starts with `-`
 * is prefixed with `./` so the shell command does not parse it as an option.
 */
export function shellRelativePath(path: string, baseDirectory: string | undefined): string {
    if (!baseDirectory) return path;
    const base = stripTrailingSeparators(baseDirectory);
    const target = stripTrailingSeparators(path);
    if (target === base) return '.';
    const prefix = base.endsWith('/') ? base : `${base}/`;
    if (!target.startsWith(prefix)) return path;
    const relative = target.slice(prefix.length);
    return relative.startsWith('-') ? `./${relative}` : relative;
}

/**
 * Produces one POSIX-shell argument for Files-to-Terminal drops. The path is made relative to the Terminal's working
 * directory first, since the shorter spelling costs an Agent fewer tokens per reference and reads the way a person
 * would type it. Wrapping only paths with shell-significant characters keeps ordinary paths readable while preventing
 * spaces, quotes, and metacharacters from changing command structure.
 */
export function terminalInputPath(path: string, baseDirectory?: string): string {
    const input = shellRelativePath(path, baseDirectory);
    if (/^[\w@%+=:,./-]+$/.test(input)) return input;
    return `'${input.replaceAll("'", String.raw`'\''`)}'`;
}
