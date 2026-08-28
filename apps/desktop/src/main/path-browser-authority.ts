import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { MainRequest, MethodResult, ServerOperationResult } from '@caxri/protocol';
import { CaxriError, MAX_FILE_BROWSE_ENTRIES } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';

import type { DesktopServerConnection } from './server-connection';

type StartParameters = Extract<MainRequest, { method: 'pathBrowser.start' }>['params'];
type BrowseParameters = Extract<MainRequest, { method: 'pathBrowser.browse' }>['params'];
type NavigateParameters = Extract<MainRequest, { method: 'pathBrowser.navigate' }>['params'];
type OpenParameters = Extract<MainRequest, { method: 'pathBrowser.open' }>['params'];
type CloseParameters = Extract<MainRequest, { method: 'pathBrowser.close' }>['params'];
type Snapshot = MethodResult<'pathBrowser.start'>;
type Entry = Snapshot['entries'][number];

interface RootIdentity {
    path: string;
    device: string;
    inode: string;
}

interface FileIdentity {
    device: string;
    inode: string;
    root: RootIdentity;
}

interface Candidate {
    id: string;
    kind: Entry['kind'];
    name: string;
    path: string;
    snapshot?: { device: string; inode: string };
}

interface BrowserContext {
    browseSessionId?: string;
    candidates: Map<string, Candidate>;
    currentDirectory: string;
    expiresAt?: number;
    id: string;
    kind: 'grant' | 'project';
    projectId?: string;
    root: RootIdentity;
    rootLabel: string;
    sourceSessionId: string;
}

export interface PathBrowserOpenTarget {
    expectedIdentity: FileIdentity;
    grantRoot?: RootIdentity;
    path: string;
    projectId?: string;
}

interface PathBrowserAuthorityOptions {
    getServer(): DesktopServerConnection;
    getWindow(): BrowserWindow | undefined;
    nextTestRoot(): string | undefined;
    openFile(target: PathBrowserOpenTarget): Promise<{ canceled: true } | { opened: true }>;
    grantTtlMs?: number;
    now?: () => number;
    userHome?: string;
}

const DEFAULT_GRANT_TTL_MS = 60_000;
const MAX_SCANNED_ENTRIES = 4_096;

function isSameOrInside(root: string, target: string): boolean {
    const pathFromRoot = relative(root, target);
    return (
        pathFromRoot === '' ||
        (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
    );
}

function pathFailure(error: unknown, fallback: string): never {
    if (error instanceof CaxriError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
        throw new CaxriError('NOT_FOUND', 'File not found');
    if (code === 'EACCES' || code === 'EPERM')
        throw new CaxriError('PATH_DENIED', 'Path is not accessible');
    /**
     * Native filesystem errors include the raw absolute path. Path-browser locations stay Main-owned, so only a stable
     * content-free failure may cross IPC or enter diagnostics.
     */
    throw new CaxriError('IO', fallback);
}

async function chooseDirectory(
    window: BrowserWindow | undefined,
    options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
    return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
}

async function directoryIdentity(path: string): Promise<RootIdentity> {
    try {
        const before = await lstat(path, { bigint: true });
        if (before.isSymbolicLink() || !before.isDirectory())
            throw new CaxriError('PATH_DENIED', 'Authorized browse root is not a directory');
        const canonicalPath = await realpath(path);
        const after = await lstat(path, { bigint: true });
        if (
            after.isSymbolicLink() ||
            !after.isDirectory() ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            (await realpath(path)) !== canonicalPath
        )
            throw new CaxriError('CONFLICT', 'Authorized browse root changed during selection');
        return {
            path: canonicalPath,
            device: after.dev.toString(),
            inode: after.ino.toString(),
        };
    } catch (error) {
        return pathFailure(error, 'Unable to inspect selected folder');
    }
}

async function validateRoot(root: RootIdentity): Promise<void> {
    try {
        const current = await lstat(root.path, { bigint: true });
        if (
            current.isSymbolicLink() ||
            !current.isDirectory() ||
            current.dev.toString() !== root.device ||
            current.ino.toString() !== root.inode ||
            (await realpath(root.path)) !== root.path
        )
            throw new CaxriError('CONFLICT', 'Authorized browse root changed after selection');
    } catch (error) {
        return pathFailure(error, 'Unable to validate selected folder');
    }
}

async function authorizePath(
    root: RootIdentity,
    candidatePath: string,
    expected?: Candidate['snapshot'],
): Promise<{ identity: FileIdentity; kind: 'directory' | 'file'; path: string }> {
    await validateRoot(root);
    let canonicalPath: string;
    try {
        canonicalPath = await realpath(candidatePath);
    } catch (error) {
        return pathFailure(error, 'Unable to resolve authorized path');
    }
    if (!isSameOrInside(root.path, canonicalPath))
        throw new CaxriError('PATH_DENIED', 'Path escapes the authorized browse root');
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
        stats = await lstat(canonicalPath, { bigint: true });
    } catch (error) {
        return pathFailure(error, 'Unable to inspect authorized path');
    }
    if (stats.isSymbolicLink())
        throw new CaxriError('PATH_DENIED', 'Symbolic links cannot be opened from a browse grant');
    if (!stats.isDirectory() && !stats.isFile())
        throw new CaxriError('VALIDATION', 'Path is not a regular file or directory');
    if (
        expected &&
        (expected.device !== stats.dev.toString() || expected.inode !== stats.ino.toString())
    )
        throw new CaxriError('CONFLICT', 'Path changed after it was listed');
    await validateRoot(root);
    return {
        identity: {
            device: stats.dev.toString(),
            inode: stats.ino.toString(),
            root,
        },
        kind: stats.isDirectory() ? 'directory' : 'file',
        path: canonicalPath,
    };
}

function displayDirectory(root: string, directory: string): string {
    const value = relative(root, directory).split(sep).join('/');
    return value ? `${value}/` : '';
}

function classifyInput(value: string, currentDirectory: string, userHome: string): string {
    if (/^\$(?:HOME|\{HOME\})(?:\/|$)/u.test(value))
        throw new CaxriError('VALIDATION', 'Shell path expansion is not supported');
    if (value.startsWith('~') && !value.startsWith('~/'))
        throw new CaxriError('VALIDATION', 'Only current-user ~/ paths are supported');
    if (value.startsWith('~/')) return resolve(userHome, value.slice(2));
    return isAbsolute(value) ? resolve(value) : resolve(currentDirectory, value);
}

/**
 * Owns every raw location behind opaque browser and entry IDs. Project browsing delegates to the Server's existing
 * Session-root resolver; a native folder selection creates a short-lived, read-only context that Main validates on
 * every list and open until the dialog closes, the grant expires, or one file is opened.
 */
export function createPathBrowserAuthority(options: PathBrowserAuthorityOptions) {
    const contexts = new Map<string, BrowserContext>();
    const operations = new Map<string, Promise<void>>();
    const now = options.now ?? Date.now;
    const grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
    const userHome = options.userHome ?? homedir();

    function contextFor(id: string): BrowserContext {
        const context = contexts.get(id);
        if (!context)
            throw new CaxriError('PATH_DENIED', 'Path browser grant is closed or missing');
        if (context.expiresAt !== undefined && context.expiresAt <= now()) {
            contexts.delete(id);
            throw new CaxriError('PATH_DENIED', 'Path browser grant expired');
        }
        return context;
    }

    /**
     * Renderer request generations can ignore stale replies, but Main owns the corresponding opaque entry IDs. Keep
     * browser operations ordered here as well so an older browse cannot finish later and replace the IDs behind a newer
     * list or navigation result.
     */
    async function serialize<T>(browserId: string, operation: () => Promise<T>): Promise<T> {
        const previous = operations.get(browserId);
        const { promise: current, resolve: release } = Promise.withResolvers<void>();
        operations.set(browserId, current);
        try {
            if (previous) await previous;
            return await operation();
        } finally {
            release();
            if (operations.get(browserId) === current) operations.delete(browserId);
        }
    }

    function replaceCandidates(context: BrowserContext, candidates: Candidate[]): Entry[] {
        context.candidates = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        return candidates.map(({ id, kind, name }) => ({ id, kind, name }));
    }

    function snapshot(context: BrowserContext, entries: Entry[], isTruncated: boolean): Snapshot {
        return {
            browserId: context.id,
            canCreate:
                context.kind === 'project' && context.browseSessionId === context.sourceSessionId,
            canGoParent:
                context.kind === 'project' || context.currentDirectory !== context.root.path,
            directoryLabel: displayDirectory(context.root.path, context.currentDirectory),
            entries,
            rootLabel: context.rootLabel,
            truncated: isTruncated,
        };
    }

    async function browseProject(context: BrowserContext, query: string): Promise<Snapshot> {
        if (!context.browseSessionId) return browseLocal(context, query);
        const result = await options.getServer().request('files.browse', {
            sessionId: context.browseSessionId,
            directory: context.currentDirectory,
            query,
        });
        const candidates = result.entries.map((entry) => ({
            id: randomUUID(),
            kind: entry.kind,
            name: entry.name,
            path: entry.path,
        }));
        return snapshot(context, replaceCandidates(context, candidates), result.truncated);
    }

    async function browseLocal(context: BrowserContext, query: string): Promise<Snapshot> {
        const authorized = await authorizePath(context.root, context.currentDirectory);
        if (authorized.kind !== 'directory')
            throw new CaxriError('VALIDATION', 'Path browser location is not a directory');
        context.currentDirectory = authorized.path;
        const normalizedQuery = query.toLocaleLowerCase();
        const candidates: Candidate[] = [];
        let scanned = 0;
        let isReachedEnd = false;
        let handle: Awaited<ReturnType<typeof opendir>>;
        try {
            handle = await opendir(authorized.path);
        } catch (error) {
            return pathFailure(error, 'Unable to read authorized directory');
        }
        try {
            while (scanned < MAX_SCANNED_ENTRIES && candidates.length <= MAX_FILE_BROWSE_ENTRIES) {
                let entry: Dirent<string> | null;
                try {
                    // eslint-disable-next-line no-await-in-loop -- a directory handle exposes one sequential cursor
                    entry = await handle.read();
                } catch (error) {
                    return pathFailure(error, 'Unable to read authorized directory');
                }
                if (!entry) {
                    isReachedEnd = true;
                    break;
                }
                scanned += 1;
                if (!entry.name.toLocaleLowerCase().includes(normalizedQuery)) continue;
                const path = resolve(authorized.path, entry.name);
                let stats: Awaited<ReturnType<typeof lstat>>;
                try {
                    // eslint-disable-next-line no-await-in-loop -- only the bounded displayed page receives identities
                    stats = await lstat(path, { bigint: true });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                    return pathFailure(error, 'Unable to inspect authorized directory entry');
                }
                candidates.push({
                    id: randomUUID(),
                    kind: stats.isSymbolicLink()
                        ? 'symlink'
                        : stats.isDirectory()
                          ? 'directory'
                          : 'file',
                    name: entry.name,
                    path,
                    snapshot: { device: stats.dev.toString(), inode: stats.ino.toString() },
                });
            }
        } finally {
            try {
                await handle.close();
            } catch {
                // The bounded directory handle is discarded regardless; a close failure cannot expand the grant.
            }
        }
        const current = await authorizePath(context.root, authorized.path, {
            device: authorized.identity.device,
            inode: authorized.identity.inode,
        });
        if (current.kind !== 'directory')
            throw new CaxriError('CONFLICT', 'Directory changed during listing');
        const isTruncated = !isReachedEnd || candidates.length > MAX_FILE_BROWSE_ENTRIES;
        const bounded = candidates
            .toSorted((left, right) => {
                if (left.kind === 'directory' && right.kind !== 'directory') return -1;
                if (left.kind !== 'directory' && right.kind === 'directory') return 1;
                return left.name.localeCompare(right.name);
            })
            .slice(0, MAX_FILE_BROWSE_ENTRIES);
        return snapshot(context, replaceCandidates(context, bounded), isTruncated);
    }

    function browseContext(context: BrowserContext, query: string): Promise<Snapshot> {
        return context.kind === 'project'
            ? browseProject(context, query)
            : browseLocal(context, query);
    }

    async function projectContext(
        existing: BrowserContext,
        project: { id: string; displayTitle: string; rootPath: string },
        currentDirectory: string,
        sessions: Array<{ archivedAt?: number; id: string; workbenchProjectId: string }>,
        selectedSessionId?: string,
    ): Promise<BrowserContext> {
        const candidates = sessions.filter(
            (session) =>
                session.archivedAt === undefined && session.workbenchProjectId === project.id,
        );
        const browseSession =
            candidates.find((session) => session.id === selectedSessionId) ?? candidates.at(0);
        const root = await directoryIdentity(project.rootPath);
        return {
            ...existing,
            browseSessionId: browseSession?.id,
            candidates: new Map(),
            currentDirectory: currentDirectory === project.rootPath ? root.path : currentDirectory,
            expiresAt: undefined,
            kind: 'project',
            projectId: project.id,
            root,
            rootLabel: project.displayTitle,
        };
    }

    async function openCandidate(context: BrowserContext, candidate: Candidate) {
        if (candidate.kind === 'symlink')
            throw new CaxriError('PATH_DENIED', 'Symbolic links cannot be opened');
        let target: PathBrowserOpenTarget;
        if (context.kind === 'project' && context.browseSessionId) {
            const entry = await options.getServer().request('files.authorizeOpen', {
                sessionId: context.browseSessionId,
                path: candidate.path,
            });
            if (entry.kind !== 'file')
                throw new CaxriError('VALIDATION', 'Path is not a regular file');
            target = {
                expectedIdentity: {
                    device: entry.device,
                    inode: entry.inode,
                    root: entry.root,
                },
                path: entry.path,
                projectId: context.projectId,
            };
        } else {
            const entry = await authorizePath(context.root, candidate.path, candidate.snapshot);
            if (entry.kind !== 'file')
                throw new CaxriError('VALIDATION', 'Path is not a regular file');
            target = {
                expectedIdentity: entry.identity,
                ...(context.kind === 'grant' && { grantRoot: context.root }),
                path: entry.path,
                projectId: context.projectId,
            };
        }
        const result = await options.openFile(target);
        if ('opened' in result) contexts.delete(context.id);
        return result;
    }

    async function navigateToInput(context: BrowserContext, value: string) {
        const targetPath = classifyInput(value, context.currentDirectory, userHome);
        const state = await options.getServer().request('app.bootstrap');
        const project = state.projects
            .filter((candidate) => isSameOrInside(candidate.rootPath, targetPath))
            .toSorted((left, right) => right.rootPath.length - left.rootPath.length)
            .at(0);
        if (project) {
            const next = await projectContext(
                context,
                project,
                targetPath,
                state.sessions,
                state.selectedSessionId,
            );
            let authorized:
                | Awaited<ReturnType<typeof authorizePath>>
                | ServerOperationResult<'files.authorizeOpen'>;
            let directSnapshot: Candidate['snapshot'];
            if (next.browseSessionId)
                authorized = await options.getServer().request('files.authorizeOpen', {
                    sessionId: next.browseSessionId,
                    path: targetPath,
                });
            else {
                authorized = await authorizePath(next.root, targetPath);
                directSnapshot = {
                    device: authorized.identity.device,
                    inode: authorized.identity.inode,
                };
            }
            if (authorized.kind === 'directory') {
                next.currentDirectory = authorized.path;
                contexts.set(context.id, next);
                return browseContext(next, '');
            }
            if (value === '..' || value.endsWith('/'))
                throw new CaxriError('VALIDATION', 'Path is not a directory');
            const direct: Candidate = {
                id: randomUUID(),
                kind: 'file',
                name: basename(authorized.path),
                path: authorized.path,
                ...(directSnapshot && { snapshot: directSnapshot }),
            };
            return openCandidate(next, direct);
        }

        const testRoot = options.nextTestRoot();
        const selection = testRoot
            ? { canceled: false, filePaths: [testRoot] }
            : await chooseDirectory(options.getWindow(), {
                  title: 'Authorize Folder to Browse',
                  defaultPath: value.endsWith('/') ? targetPath : dirname(targetPath),
                  properties: ['openDirectory'],
              });
        const selectedPath = selection.filePaths.at(0);
        if (!selectedPath || selection.canceled) return { canceled: true as const };
        const root = await directoryIdentity(selectedPath);
        let currentDirectory = root.path;
        let directFile:
            { identity: FileIdentity; kind: 'directory' | 'file'; path: string } | undefined;
        if (value !== '~/') {
            try {
                directFile = await authorizePath(root, targetPath);
            } catch (error) {
                if (error instanceof CaxriError && error.code === 'PATH_DENIED')
                    throw new CaxriError(
                        'PATH_DENIED',
                        'Selected folder does not contain the requested path',
                    );
                throw error;
            }
        }
        if (directFile?.kind === 'directory') currentDirectory = directFile.path;
        const granted: BrowserContext = {
            ...context,
            browseSessionId: undefined,
            candidates: new Map(),
            currentDirectory,
            expiresAt: now() + grantTtlMs,
            kind: 'grant',
            projectId: undefined,
            root,
            rootLabel: basename(root.path) || 'Authorized Folder',
        };
        contexts.set(context.id, granted);
        if (directFile?.kind === 'file') {
            const result = await options.openFile({
                expectedIdentity: directFile.identity,
                grantRoot: root,
                path: directFile.path,
            });
            if ('opened' in result) contexts.delete(context.id);
            return result;
        }
        return browseLocal(granted, '');
    }

    return {
        async start({ sessionId }: StartParameters): Promise<Snapshot> {
            const state = await options.getServer().request('app.bootstrap');
            const session = state.sessions.find((candidate) => candidate.id === sessionId);
            if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
            const project = state.projects.find(
                (candidate) => candidate.id === session.workbenchProjectId,
            );
            if (!project) throw new CaxriError('NOT_FOUND', 'Workbench Project not found');
            const root = await directoryIdentity(project.rootPath);
            const context: BrowserContext = {
                browseSessionId: sessionId,
                candidates: new Map(),
                currentDirectory: root.path,
                id: randomUUID(),
                kind: 'project',
                projectId: project.id,
                root,
                rootLabel: project.displayTitle,
                sourceSessionId: sessionId,
            };
            contexts.set(context.id, context);
            try {
                return await browseProject(context, '');
            } catch (error) {
                contexts.delete(context.id);
                throw error;
            }
        },

        async browse({ browserId, query }: BrowseParameters): Promise<Snapshot> {
            return serialize(browserId, () => browseContext(contextFor(browserId), query));
        },

        async navigate({ browserId, target }: NavigateParameters) {
            return serialize(browserId, async () => {
                const context = contextFor(browserId);
                if (target.kind === 'input') return navigateToInput(context, target.value);
                if (target.kind === 'parent') {
                    if (context.kind === 'grant' && context.currentDirectory === context.root.path)
                        return browseLocal(context, '');
                    return navigateToInput(context, '..');
                }
                const candidate = context.candidates.get(target.entryId);
                if (!candidate) throw new CaxriError('PATH_DENIED', 'Path browser entry expired');
                if (candidate.kind === 'symlink')
                    throw new CaxriError('PATH_DENIED', 'Symbolic links cannot be opened');
                if (candidate.kind === 'file') return openCandidate(context, candidate);
                if (context.kind === 'grant') {
                    const authorized = await authorizePath(
                        context.root,
                        candidate.path,
                        candidate.snapshot,
                    );
                    if (authorized.kind !== 'directory')
                        throw new CaxriError('CONFLICT', 'Directory changed after it was listed');
                    context.currentDirectory = authorized.path;
                } else context.currentDirectory = candidate.path;
                return browseContext(context, '');
            });
        },

        async open({ browserId, entryId }: OpenParameters) {
            return serialize(browserId, async () => {
                const context = contextFor(browserId);
                const candidate = context.candidates.get(entryId);
                if (!candidate) throw new CaxriError('PATH_DENIED', 'Path browser entry expired');
                return openCandidate(context, candidate);
            });
        },

        close({ browserId }: CloseParameters): null {
            contexts.delete(browserId);
            return null;
        },
    };
}
