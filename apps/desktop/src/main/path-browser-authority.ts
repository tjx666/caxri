import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { MainRequest, MethodResult } from '@caxri/protocol';
import { CaxriError, MAX_CONFIGURABLE_FILE_BYTES, MAX_FILE_BROWSE_ENTRIES } from '@caxri/protocol';
import { AsyncSemaphore } from '@caxri/system';

import type { DesktopServerConnection } from './server-connection';

type StartParameters = Extract<MainRequest, { method: 'pathBrowser.start' }>['params'];
type BrowseParameters = Extract<MainRequest, { method: 'pathBrowser.browse' }>['params'];
type NavigateParameters = Extract<MainRequest, { method: 'pathBrowser.navigate' }>['params'];
type OpenParameters = Extract<MainRequest, { method: 'pathBrowser.open' }>['params'];
type CloseParameters = Extract<MainRequest, { method: 'pathBrowser.close' }>['params'];
type Snapshot = MethodResult<'pathBrowser.start'>;
type Entry = Snapshot['entries'][number];
type BrowserMode = Snapshot['mode'];
type Opened = MethodResult<'pathBrowser.open'>;

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
    parent?: RootIdentity;
    snapshot?: { device: string; inode: string };
}

interface BrowserContext {
    browseSessionId: string;
    candidates: Map<string, Candidate>;
    currentDirectory: string;
    freeOriginDirectory?: string;
    id: string;
    input: string;
    listedDirectory: RootIdentity;
    mode: BrowserMode;
    root: RootIdentity;
    rootLabel: string;
    sourceSessionId: string;
}

interface ResolvedBrowseInput {
    directory: string;
    filter: string;
}

interface BoundedFileReader {
    read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ): Promise<{ bytesRead: number }>;
}

export interface PathBrowserOpenTarget {
    expectedIdentity: FileIdentity;
    path: string;
    sessionId: string;
}

interface PathBrowserAuthorityOptions {
    getServer(): DesktopServerConnection;
    openFile(target: PathBrowserOpenTarget): Promise<{ canceled: true } | { opened: true }>;
    userHome?: string;
}

const MAX_SCANNED_ENTRIES = 4_096;
const MAX_CONCURRENT_BROWSES = 4;
const MAX_FILTER_LENGTH = 255;

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

async function directoryIdentity(path: string): Promise<RootIdentity> {
    try {
        const before = await lstat(path, { bigint: true });
        if (before.isSymbolicLink() || !before.isDirectory())
            throw new CaxriError('PATH_DENIED', 'Browse location is not a directory');
        const canonicalPath = await realpath(path);
        const after = await lstat(path, { bigint: true });
        if (
            after.isSymbolicLink() ||
            !after.isDirectory() ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            (await realpath(path)) !== canonicalPath
        )
            throw new CaxriError('CONFLICT', 'Browse location changed during authorization');
        return {
            path: canonicalPath,
            device: after.dev.toString(),
            inode: after.ino.toString(),
        };
    } catch (error) {
        return pathFailure(error, 'Unable to inspect browse location');
    }
}

async function validateDirectory(directory: RootIdentity): Promise<void> {
    try {
        const current = await lstat(directory.path, { bigint: true });
        if (
            current.isSymbolicLink() ||
            !current.isDirectory() ||
            current.dev.toString() !== directory.device ||
            current.ino.toString() !== directory.inode ||
            (await realpath(directory.path)) !== directory.path
        )
            throw new CaxriError('CONFLICT', 'Browse location changed after it was listed');
    } catch (error) {
        return pathFailure(error, 'Unable to validate browse location');
    }
}

async function authorizeCandidate(
    parent: RootIdentity,
    candidatePath: string,
    expected?: Candidate['snapshot'],
): Promise<{ identity: FileIdentity; kind: 'directory' | 'file'; path: string }> {
    await validateDirectory(parent);
    try {
        const lexicalStats = await lstat(candidatePath, { bigint: true });
        if (lexicalStats.isSymbolicLink())
            throw new CaxriError('PATH_DENIED', 'Symbolic links cannot be opened');
        if (
            expected &&
            (expected.device !== lexicalStats.dev.toString() ||
                expected.inode !== lexicalStats.ino.toString())
        )
            throw new CaxriError('CONFLICT', 'Path changed after it was listed');
        const canonicalPath = await realpath(candidatePath);
        if (!isSameOrInside(parent.path, canonicalPath) || dirname(canonicalPath) !== parent.path)
            throw new CaxriError('PATH_DENIED', 'Path escapes its listed directory');
        const stats = await lstat(canonicalPath, { bigint: true });
        if (
            stats.isSymbolicLink() ||
            stats.dev !== lexicalStats.dev ||
            stats.ino !== lexicalStats.ino
        )
            throw new CaxriError('CONFLICT', 'Path changed during authorization');
        if (!stats.isDirectory() && !stats.isFile())
            throw new CaxriError('VALIDATION', 'Path is not a regular file or directory');
        await validateDirectory(parent);
        return {
            identity: {
                device: stats.dev.toString(),
                inode: stats.ino.toString(),
                root: parent,
            },
            kind: stats.isDirectory() ? 'directory' : 'file',
            path: canonicalPath,
        };
    } catch (error) {
        return pathFailure(error, 'Unable to authorize browse entry');
    }
}

function displayProjectDirectory(root: string, directory: string): string {
    const value = relative(root, directory).split(sep).join('/');
    return value ? `${value}/` : '';
}

function trailingSlash(path: string): string {
    return path === '/' ? '/' : `${path}/`;
}

/**
 * Reads at most one byte beyond the external-file limit. A file can grow after `stat()`, so `readFile()` would allow
 * another process to make Main allocate the entire expanded file before a post-read check could reject it.
 */
export async function readBoundedExternalContent(file: BoundedFileReader): Promise<Buffer> {
    const content = Buffer.allocUnsafe(MAX_CONFIGURABLE_FILE_BYTES + 1);
    let offset = 0;
    while (offset < content.byteLength) {
        // eslint-disable-next-line no-await-in-loop -- one bounded file descriptor owns a sequential cursor
        const { bytesRead } = await file.read(content, offset, content.byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    if (offset > MAX_CONFIGURABLE_FILE_BYTES)
        throw new CaxriError('CAPACITY', 'File exceeded the read safety limit');
    return content.subarray(0, offset);
}

/**
 * Splits a complete POSIX input into the directory to enumerate and its final refinement without performing shell
 * expansion. Relative input always resolves from the last explicitly navigated directory, never from a prior live
 * refinement, so changing `..` to `../name` cannot accidentally climb twice.
 */
function resolveBrowseInput(value: string, origin: string, userHome: string): ResolvedBrowseInput {
    if (value.includes('\0')) throw new CaxriError('VALIDATION', 'Path contains a null byte');
    if (/^\$(?:HOME|\{HOME\})(?:\/|$)/u.test(value))
        throw new CaxriError('VALIDATION', 'Shell path expansion is not supported');
    if (value !== '~' && value.startsWith('~') && !value.startsWith('~/'))
        throw new CaxriError('VALIDATION', 'Only current-user ~ paths are supported');
    if (!value) return { directory: origin, filter: '' };
    if (value === '~' || value === '~/') return { directory: userHome, filter: '' };

    const inputPath = value.startsWith('~/')
        ? resolve(userHome, value.slice(2))
        : isAbsolute(value)
          ? resolve(value)
          : resolve(origin, value);
    const lastSegment = value.split('/').at(-1);
    const namesDirectory =
        value.endsWith('/') || lastSegment === '.' || lastSegment === '..' || value === '/';
    return namesDirectory
        ? { directory: inputPath, filter: '' }
        : { directory: dirname(inputPath), filter: basename(inputPath) };
}

async function readExternalDocument(
    candidate: Candidate,
): Promise<Extract<Opened, { kind: 'external' }>> {
    if (!candidate.parent || !candidate.snapshot)
        throw new CaxriError('PATH_DENIED', 'External browse entry is no longer available');
    const authorized = await authorizeCandidate(
        candidate.parent,
        candidate.path,
        candidate.snapshot,
    );
    if (authorized.kind !== 'file')
        throw new CaxriError('VALIDATION', 'Path is not a regular file');
    let file: Awaited<ReturnType<typeof open>>;
    try {
        file = await open(authorized.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        return pathFailure(error, 'Unable to open external file');
    }
    try {
        const opened = await file.stat({ bigint: true });
        if (
            !opened.isFile() ||
            opened.dev.toString() !== authorized.identity.device ||
            opened.ino.toString() !== authorized.identity.inode
        )
            throw new CaxriError('CONFLICT', 'File changed before it was opened');
        if (opened.nlink > 1n)
            throw new CaxriError(
                'PATH_DENIED',
                'Files with multiple filesystem links cannot be opened',
            );
        if (opened.size > BigInt(MAX_CONFIGURABLE_FILE_BYTES))
            throw new CaxriError(
                'CAPACITY',
                `File exceeds the ${MAX_CONFIGURABLE_FILE_BYTES} byte safety limit`,
            );
        const boundedContent = await readBoundedExternalContent(file);
        if (boundedContent.includes(0))
            throw new CaxriError('IO', 'Binary files cannot be opened in the editor');
        const current = await lstat(authorized.path, { bigint: true });
        if (
            current.isSymbolicLink() ||
            !current.isFile() ||
            current.dev !== opened.dev ||
            current.ino !== opened.ino ||
            current.nlink > 1n ||
            (await realpath(authorized.path)) !== authorized.path
        )
            throw new CaxriError('CONFLICT', 'File changed while it was opened');
        await validateDirectory(candidate.parent);
        return {
            opened: true,
            kind: 'external',
            document: {
                id: randomUUID(),
                name: candidate.name,
                displayPath: authorized.path,
                content: boundedContent.toString('utf8'),
                mtimeMs: Number(opened.mtimeMs),
                size: Number(opened.size),
                readOnly: true,
            },
        };
    } catch (error) {
        return pathFailure(error, 'Unable to read external file');
    } finally {
        await file.close();
    }
}

/**
 * Owns raw filesystem locations and entry identities behind one browser ID. Project reads keep the existing Server
 * authorization path; free reads are bounded, read-only Main operations and never create Projects or Sessions.
 */
export function createPathBrowserAuthority(options: PathBrowserAuthorityOptions) {
    const contexts = new Map<string, BrowserContext>();
    const operations = new Map<string, Promise<void>>();
    const browseConcurrency = new AsyncSemaphore(MAX_CONCURRENT_BROWSES);
    const userHome = options.userHome ?? homedir();

    function contextFor(id: string): BrowserContext {
        const context = contexts.get(id);
        if (!context)
            throw new CaxriError('PATH_DENIED', 'Path browser context is closed or missing');
        return context;
    }

    /**
     * Opaque entry IDs are replaced as one unit. Serializing one browser prevents an older result from replacing the
     * IDs behind a newer snapshot while the global semaphore still bounds different browser contexts.
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

    function snapshot(
        context: BrowserContext,
        directory: RootIdentity,
        input: string,
        entries: Entry[],
        isTruncated: boolean,
    ): Snapshot {
        context.input = input;
        context.listedDirectory = directory;
        return {
            browserId: context.id,
            canCreate:
                context.mode === 'project' && context.browseSessionId === context.sourceSessionId,
            canGoParent:
                context.mode === 'free'
                    ? directory.path !== '/'
                    : directory.path !== context.root.path,
            directoryLabel:
                context.mode === 'project'
                    ? displayProjectDirectory(context.root.path, context.currentDirectory)
                    : trailingSlash(directory.path),
            entries,
            input,
            mode: context.mode,
            ...(context.mode === 'project' && { rootLabel: context.rootLabel }),
            truncated: isTruncated,
        };
    }

    async function browseProject(
        context: BrowserContext,
        directory: RootIdentity,
        filter: string,
        input: string,
    ): Promise<Snapshot> {
        await validateDirectory(context.root);
        if (!isSameOrInside(context.root.path, directory.path))
            throw new CaxriError('PATH_DENIED', 'Path escapes the Project root');
        if (filter.length > MAX_FILTER_LENGTH)
            return snapshot(context, directory, input, replaceCandidates(context, []), false);
        const result = await options.getServer().request('files.browse', {
            sessionId: context.browseSessionId,
            directory: directory.path,
            query: filter,
        });
        const candidates = result.entries.map((entry) => ({
            id: randomUUID(),
            kind: entry.kind,
            name: entry.name,
            path: entry.path,
        }));
        return snapshot(
            context,
            directory,
            input,
            replaceCandidates(context, candidates),
            result.truncated,
        );
    }

    async function browseFree(
        context: BrowserContext,
        directory: RootIdentity,
        filter: string,
        input: string,
    ): Promise<Snapshot> {
        return browseConcurrency.run(async () => {
            await validateDirectory(directory);
            const normalizedFilter = filter.toLocaleLowerCase();
            const candidates: Candidate[] = [];
            let scanned = 0;
            let isReachedEnd = false;
            let handle: Awaited<ReturnType<typeof opendir>>;
            try {
                handle = await opendir(directory.path);
            } catch (error) {
                return pathFailure(error, 'Unable to read browse directory');
            }
            try {
                while (
                    scanned < MAX_SCANNED_ENTRIES &&
                    candidates.length <= MAX_FILE_BROWSE_ENTRIES
                ) {
                    let entry: Dirent<string> | null;
                    try {
                        // eslint-disable-next-line no-await-in-loop -- a directory handle exposes one sequential cursor
                        entry = await handle.read();
                    } catch (error) {
                        return pathFailure(error, 'Unable to read browse directory');
                    }
                    if (!entry) {
                        isReachedEnd = true;
                        break;
                    }
                    scanned += 1;
                    if (!entry.name.toLocaleLowerCase().includes(normalizedFilter)) continue;
                    const path = resolve(directory.path, entry.name);
                    let stats: Awaited<ReturnType<typeof lstat>>;
                    try {
                        // eslint-disable-next-line no-await-in-loop -- only the bounded displayed page receives identities
                        stats = await lstat(path, { bigint: true });
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                        return pathFailure(error, 'Unable to inspect browse entry');
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
                        parent: directory,
                        snapshot: { device: stats.dev.toString(), inode: stats.ino.toString() },
                    });
                }
            } finally {
                try {
                    await handle.close();
                } catch {
                    // The bounded directory handle is discarded regardless; a close failure cannot expand access.
                }
            }
            await validateDirectory(directory);
            const isTruncated = !isReachedEnd || candidates.length > MAX_FILE_BROWSE_ENTRIES;
            const bounded = candidates
                .toSorted((left, right) => {
                    if (left.kind === 'directory' && right.kind !== 'directory') return -1;
                    if (left.kind !== 'directory' && right.kind === 'directory') return 1;
                    return left.name.localeCompare(right.name);
                })
                .slice(0, MAX_FILE_BROWSE_ENTRIES);
            return snapshot(
                context,
                directory,
                input,
                replaceCandidates(context, bounded),
                isTruncated,
            );
        });
    }

    async function browseInput(
        context: BrowserContext,
        mode: BrowserMode,
        input: string,
    ): Promise<Snapshot> {
        if (mode !== context.mode) {
            context.mode = mode;
            if (mode === 'free') context.freeOriginDirectory = context.listedDirectory.path;
            else {
                context.currentDirectory = context.root.path;
                context.freeOriginDirectory = undefined;
            }
        }
        const origin =
            mode === 'free'
                ? (context.freeOriginDirectory ?? context.currentDirectory)
                : context.currentDirectory;
        let parsed = resolveBrowseInput(input, origin, userHome);
        let directory: RootIdentity;
        try {
            directory = await directoryIdentity(parsed.directory);
        } catch (error) {
            const folderName = input.endsWith('/') ? input.slice(0, -1) : '';
            if (
                mode !== 'project' ||
                !folderName ||
                folderName.includes('/') ||
                !(error instanceof CaxriError) ||
                error.code !== 'NOT_FOUND'
            )
                throw error;
            /**
             * A missing single-segment trailing-slash input is the existing Project-local "create folder" gesture. List
             * its current parent with that name as the filter so Renderer can offer Create without weakening free-path
             * browsing or swallowing permission and identity failures.
             */
            parsed = { directory: context.currentDirectory, filter: folderName };
            directory = await directoryIdentity(context.currentDirectory);
        }
        if (mode === 'project') return browseProject(context, directory, parsed.filter, input);
        return browseFree(context, directory, parsed.filter, input);
    }

    async function openCandidate(context: BrowserContext, candidate: Candidate): Promise<Opened> {
        if (candidate.kind === 'symlink')
            throw new CaxriError('PATH_DENIED', 'Symbolic links cannot be opened');
        const isCurrentProjectPath = isSameOrInside(context.root.path, candidate.path);
        if (!isCurrentProjectPath && context.mode === 'free') {
            if (candidate.kind !== 'file')
                throw new CaxriError('VALIDATION', 'Path is not a regular file');
            const result = await readExternalDocument(candidate);
            contexts.delete(context.id);
            return result;
        }
        const entry = await options.getServer().request('files.authorizeOpen', {
            sessionId: context.browseSessionId,
            path: candidate.path,
        });
        if (entry.kind !== 'file') throw new CaxriError('VALIDATION', 'Path is not a regular file');
        const result = await options.openFile({
            expectedIdentity: {
                device: entry.device,
                inode: entry.inode,
                root: entry.root,
            },
            path: entry.path,
            sessionId: context.sourceSessionId,
        });
        if ('canceled' in result) throw new CaxriError('CANCELLED', 'File open was canceled');
        contexts.delete(context.id);
        return { opened: true, kind: 'project' };
    }

    async function navigateDirectory(
        context: BrowserContext,
        candidate: Candidate,
    ): Promise<Snapshot> {
        let authorized: { kind: 'directory' | 'file'; path: string };
        const isCurrentProjectPath = isSameOrInside(context.root.path, candidate.path);
        if (isCurrentProjectPath || context.mode === 'project') {
            authorized = await options.getServer().request('files.authorizeOpen', {
                sessionId: context.browseSessionId,
                path: candidate.path,
            });
        } else {
            if (!candidate.parent)
                throw new CaxriError('PATH_DENIED', 'Browse entry is no longer available');
            authorized = await authorizeCandidate(
                candidate.parent,
                candidate.path,
                candidate.snapshot,
            );
        }
        if (authorized.kind !== 'directory')
            throw new CaxriError('CONFLICT', 'Directory changed after it was listed');
        const directory = await directoryIdentity(authorized.path);
        context.currentDirectory = directory.path;
        context.listedDirectory = directory;
        if (isCurrentProjectPath) {
            context.mode = 'project';
            context.freeOriginDirectory = undefined;
            return browseProject(context, directory, '', '');
        }
        if (context.mode === 'free') {
            context.freeOriginDirectory = directory.path;
            return browseFree(context, directory, '', trailingSlash(directory.path));
        }
        return browseProject(context, directory, '', '');
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
                input: '',
                listedDirectory: root,
                mode: 'project',
                root,
                rootLabel: project.displayTitle,
                sourceSessionId: sessionId,
            };
            contexts.set(context.id, context);
            try {
                return await browseProject(context, root, '', '');
            } catch (error) {
                contexts.delete(context.id);
                throw error;
            }
        },

        async browse({ browserId, mode, input }: BrowseParameters): Promise<Snapshot> {
            return serialize(browserId, () => browseInput(contextFor(browserId), mode, input));
        },

        async navigate({ browserId, target }: NavigateParameters) {
            return serialize(browserId, async () => {
                const context = contextFor(browserId);
                if (target.kind === 'detachProject') {
                    context.mode = 'free';
                    context.currentDirectory = context.listedDirectory.path;
                    context.freeOriginDirectory = context.listedDirectory.path;
                    return browseFree(
                        context,
                        context.listedDirectory,
                        '',
                        trailingSlash(context.listedDirectory.path),
                    );
                }
                if (target.kind === 'parent') {
                    const parentPath = dirname(context.listedDirectory.path);
                    const boundedParent =
                        context.mode === 'project' && !isSameOrInside(context.root.path, parentPath)
                            ? context.root.path
                            : parentPath;
                    const directory = await directoryIdentity(boundedParent);
                    context.currentDirectory = directory.path;
                    context.listedDirectory = directory;
                    if (context.mode === 'free') {
                        context.freeOriginDirectory = directory.path;
                        return browseFree(context, directory, '', trailingSlash(directory.path));
                    }
                    return browseProject(context, directory, '', '');
                }
                const candidate = context.candidates.get(target.entryId);
                if (!candidate) throw new CaxriError('PATH_DENIED', 'Path browser entry expired');
                if (candidate.kind === 'symlink')
                    throw new CaxriError('PATH_DENIED', 'Symbolic links cannot be opened');
                return candidate.kind === 'file'
                    ? openCandidate(context, candidate)
                    : navigateDirectory(context, candidate);
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
