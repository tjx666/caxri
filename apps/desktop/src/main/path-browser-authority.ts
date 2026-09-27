import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { MainRequest, MethodResult } from '@caxri/protocol';
import { CaxriError, MAX_FILE_BROWSE_ENTRIES, MAX_PATH_BROWSER_ENTRIES } from '@caxri/protocol';
import { AsyncSemaphore } from '@caxri/system';

import { readExternalFile } from './external-file-snapshot';
import type { FileIdentity, RootIdentity } from './path-browser-identity';
import {
    authorizeCandidate,
    directoryIdentity,
    isSameOrInside,
    pathFailure,
    validateDirectory,
} from './path-browser-identity';
import type { PathBrowserLogger } from './path-browser-log';
import { logSearchFailed, logSearchFallback } from './path-browser-log';
import type { ProjectSearchMatch } from './path-browser-search';
import {
    memoizedProjectSearch,
    rankProjectSearchMatches,
    rememberProjectSearch,
} from './path-browser-search';
import { memoizedSubpathPrefix, projectSubpathSuffix } from './path-browser-subpath';
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

interface Candidate {
    /**
     * Project-relative directory shown beside a `projectSearch` row; absent for ordinary directory listings.
     */
    directoryLabel?: string;
    id: string;
    kind: Entry['kind'];
    source: Entry['source'];
    /**
     * Display-only symlink metadata forwarded from Server Core. Workspace opens are reauthorized by Server Core; links
     * encountered during free browsing remain unavailable.
     */
    linkKind?: Entry['linkKind'];
    linkTarget?: Entry['linkTarget'];
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
    /**
     * Subpath-fallback memo for this browser: a located prefix directory per suffix, or `null` when the Project holds
     * no such directory. A negative entry also covers every longer suffix beneath it, so typing toward a folder that
     * does not exist anywhere costs one bounded scan per new segment instead of one per keystroke.
     */
    locatedSuffixes: Map<string, string | null>;
    mode: BrowserMode;
    root: RootIdentity;
    rootLabel: string;
    /**
     * Quick-open memo for this browser, keyed by lower-cased filter: the complete in-root name hits it produced.
     * `files.search` tests a case-insensitive literal against each Project-relative path, so every longer filter
     * containing this key can only match a subset of these rows and is answered by filtering them here. A burst of
     * keystrokes therefore costs one bounded Project scan instead of one per key, the way `locatedSuffixes` already
     * bounds the subpath fallback. Only a complete scan is stored: a truncated or canceled one proves nothing about the
     * files it never reached.
     */
    searchedFilters: Map<string, ProjectSearchMatch[]>;
    sourceSessionId: string;
}

interface ResolvedBrowseInput {
    directory: string;
    filter: string;
}

export interface PathBrowserOpenTarget {
    expectedIdentity: FileIdentity;
    path: string;
    sessionId: string;
}

interface PathBrowserAuthorityOptions {
    getServer(): DesktopServerConnection;
    logger(): PathBrowserLogger | undefined;
    openFile(target: PathBrowserOpenTarget): Promise<{ canceled: true } | { opened: true }>;
    userHome?: string;
}

const MAX_SCANNED_ENTRIES = 4_096;
const MAX_CONCURRENT_BROWSES = 4;
const MAX_FILTER_LENGTH = 255;

function displayProjectDirectory(root: string, directory: string): string {
    const value = relative(root, directory).split(sep).join('/');
    return value ? `${value}/` : '';
}

/**
 * The free-mode breadcrumb. It is the snapshot's `directoryLabel`, never its `input`: a navigation that typed the whole
 * absolute path back into the field made the user delete it again before they could type anything of their own, which
 * is exactly what the detach gesture exists to avoid.
 */
function trailingSlash(path: string): string {
    return path === '/' ? '/' : `${path}/`;
}

/**
 * True when the whole input is one plain name segment. Anything carrying a separator is an explicit location the user
 * typed, so it keeps the existing relative-path and subpath-fallback behavior instead of turning into a name search.
 */
function isBareFilter(input: string, filter: string): boolean {
    return filter.length > 0 && input === filter && !filter.includes('/');
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
    return {
        opened: true,
        kind: 'external',
        document: await readExternalFile(
            candidate.parent,
            candidate.path,
            candidate.name,
            candidate.snapshot,
        ),
    };
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
        return candidates.map(
            ({ directoryLabel, id, kind, linkKind, linkTarget, name, source }) => ({
                id,
                kind,
                ...(directoryLabel !== undefined && { directoryLabel }),
                ...(linkKind !== undefined && { linkKind }),
                ...(linkTarget !== undefined && { linkTarget }),
                name,
                source,
            }),
        );
    }

    function snapshot(
        context: BrowserContext,
        directory: RootIdentity,
        input: string,
        entries: Entry[],
        isTruncated: boolean,
        displayDirectory = context.currentDirectory,
        projectSearch: Snapshot['projectSearch'] = 'skipped',
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
            /**
             * In Project mode this is the display prefix (the located prefix after a subpath fallback), not necessarily
             * the listed directory. Renderer creation derives its parent from it and stays safe only because the create
             * gesture rejects any name containing `/`, which the fallback always has.
             */
            directoryLabel:
                context.mode === 'project'
                    ? displayProjectDirectory(context.root.path, displayDirectory)
                    : trailingSlash(directory.path),
            entries,
            input,
            mode: context.mode,
            projectSearch,
            ...(context.mode === 'project' && { rootLabel: context.rootLabel }),
            truncated: isTruncated,
        };
    }

    async function browseProject(
        context: BrowserContext,
        directory: RootIdentity,
        filter: string,
        input: string,
        displayDirectory?: string,
    ): Promise<Snapshot> {
        await validateDirectory(context.root);
        if (!isSameOrInside(context.root.path, directory.path))
            throw new CaxriError('PATH_DENIED', 'Path escapes the Project root');
        if (filter.length > MAX_FILTER_LENGTH)
            return snapshot(
                context,
                directory,
                input,
                replaceCandidates(context, []),
                false,
                displayDirectory,
            );
        /**
         * Both lookups run for a bare filter, and they run together. The directory listing answers "what is here"; the
         * Project search answers "where else is this name". Gating the second on the first being empty hid it almost
         * always, because a substring match inside one directory nearly always hits something — typing `app` at the
         * repository root could never reach a deeper `app-menu.ts`. See issue #986.
         */
        const isSearchable = isBareFilter(input, filter);
        const [result, search] = await Promise.all([
            options.getServer().request('files.browse', {
                sessionId: context.browseSessionId,
                directory: directory.path,
                query: filter,
            }),
            isSearchable
                ? searchProject(context, filter)
                : Promise.resolve({ matches: [], status: 'skipped' as const }),
        ]);
        const listed = result.entries.map((entry) => ({
            id: randomUUID(),
            kind: entry.kind,
            ...(entry.linkKind !== undefined && { linkKind: entry.linkKind }),
            ...(entry.linkTarget !== undefined && { linkTarget: entry.linkTarget }),
            name: entry.name,
            path: entry.path,
            source: 'directory' as const,
        }));
        const found = projectSearchCandidates(search.matches, filter, listed);
        return snapshot(
            context,
            directory,
            input,
            replaceCandidates(context, [...listed, ...found.candidates]),
            result.truncated,
            displayDirectory,
            found.isComplete ? search.status : 'incomplete',
        );
    }

    /**
     * Runs the bounded Project-wide name search and reports how far it got. Server Core owns the traversal; Main
     * refuses any returned path outside this browser's root, so nothing the Renderer sees rests on an unchecked Server
     * string. This mirrors the `files.locateDirectory` subpath fallback.
     */
    async function searchProject(
        context: BrowserContext,
        filter: string,
    ): Promise<{ matches: readonly ProjectSearchMatch[]; status: Snapshot['projectSearch'] }> {
        const startedAt = performance.now();
        const memoized = memoizedProjectSearch(context.searchedFilters, filter);
        if (memoized) {
            logSearchFallback(options.logger(), performance.now() - startedAt, {
                memoHit: true,
                matchCount: memoized.length,
                droppedByRootCheck: 0,
                displayedCount: memoized.length,
                truncated: false,
                canceled: false,
            });
            return { matches: memoized, status: 'complete' };
        }
        let result: MethodResult<'files.search'>;
        try {
            result = await options.getServer().request('files.search', {
                sessionId: context.browseSessionId,
                consumer: 'path-browser',
                mode: 'name',
                query: filter,
            });
        } catch (error) {
            // The directory listing is authoritative on its own, so a search engine that cannot start must not turn
            // into a dialog-wide error. It says so in its own group instead, because a group that simply vanished
            // would read as "this name exists nowhere else". A closed reason still reaches the structured log, so a
            // packaged install missing ripgrep is diagnosable instead of reading like the Project has no such file.
            logSearchFailed(options.logger(), performance.now() - startedAt, error);
            return { matches: [], status: 'unavailable' };
        }
        const inRoot: ProjectSearchMatch[] = result.matches.flatMap((match) =>
            isSameOrInside(context.root.path, match.path)
                ? [
                      {
                          path: match.path,
                          relativePath: relative(context.root.path, match.path)
                              .split(sep)
                              .join('/'),
                      },
                  ]
                : [],
        );
        /**
         * A canceled scan reached an unknown part of the Project, so it must read as incomplete rather than as an
         * authoritative "this name exists nowhere". Only a complete scan may be memoized for later filters to refine.
         */
        const isIncomplete = result.truncated || result.canceled;
        if (!isIncomplete) rememberProjectSearch(context.searchedFilters, filter, inRoot);
        logSearchFallback(options.logger(), performance.now() - startedAt, {
            memoHit: false,
            matchCount: result.matches.length,
            droppedByRootCheck: result.matches.length - inRoot.length,
            displayedCount: inRoot.length,
            truncated: result.truncated,
            canceled: result.canceled,
        });
        return { matches: inRoot, status: isIncomplete ? 'incomplete' : 'complete' };
    }

    /**
     * Ranks the search hits and drops the ones the directory listing already shows, so a file in the current directory
     * appears once rather than in both groups. The two groups share one entry budget: the directory listing is what the
     * user navigated to, so it is served first and the search fills whatever is left.
     */
    function projectSearchCandidates(
        matches: readonly ProjectSearchMatch[],
        filter: string,
        listed: readonly Candidate[],
    ): { candidates: Candidate[]; isComplete: boolean } {
        const budget = MAX_PATH_BROWSER_ENTRIES - listed.length;
        if (budget <= 0) return { candidates: [], isComplete: matches.length === 0 };
        const alreadyListed = new Set(listed.map((candidate) => candidate.path));
        const elsewhere = matches.filter((match) => !alreadyListed.has(match.path));
        const ranked = rankProjectSearchMatches(elsewhere, filter, budget);
        return {
            candidates: ranked.map((match) => ({
                directoryLabel: match.directoryLabel,
                id: randomUUID(),
                kind: 'file' as const,
                name: match.name,
                path: match.path,
                source: 'projectSearch' as const,
            })),
            isComplete: ranked.length === elsewhere.length,
        };
    }

    /**
     * VS Code-style subpath fallback: when the typed directory does not exist under the current directory, look for a
     * Project-local directory whose path ends with those segments (for example `packages/x/` copied from Agent output
     * while the Project holds `example/packages/x/`). Server Core bounds and excludes the traversal and picks the
     * shallowest match so the breadcrumb stays predictable; Main revalidates that directory before listing it.
     */
    async function locateProjectDirectory(
        context: BrowserContext,
        input: string,
    ): Promise<{ directory: RootIdentity; displayDirectory: string } | undefined> {
        const suffix = projectSubpathSuffix(input);
        if (!suffix) return undefined;
        const key = suffix.join('/');
        const displayDirectory = await locateProjectPrefix(context, key);
        if (!displayDirectory) return undefined;
        const directory = await directoryIdentity(resolve(displayDirectory, ...suffix));
        if (
            !isSameOrInside(context.root.path, directory.path) ||
            !isSameOrInside(context.root.path, displayDirectory)
        )
            throw new CaxriError('PATH_DENIED', 'Path escapes the Project root');
        return { directory, displayDirectory };
    }

    /**
     * Resolves the prefix directory under which `key` exists, consulting the browser memo before asking Server Core.
     */
    async function locateProjectPrefix(
        context: BrowserContext,
        key: string,
    ): Promise<string | undefined> {
        const memo = memoizedSubpathPrefix(context.locatedSuffixes, key);
        if (memo === null) return undefined;
        if (memo !== undefined) {
            try {
                await directoryIdentity(resolve(memo, key));
                return memo;
            } catch {
                // The memoized prefix no longer holds this deeper path; fall through to a fresh lookup.
            }
        }
        const located = await options.getServer().request('files.locateDirectory', {
            sessionId: context.browseSessionId,
            suffix: key,
        });
        const depth = key.split('/').length;
        // Server Core already picked the shallowest match; Main still refuses a path outside this browser's root so a
        // hostile or stale response can never be memoized into `context.locatedSuffixes`.
        const best =
            located.path !== null && isSameOrInside(context.root.path, located.path)
                ? located.path
                : undefined;
        if (!best) {
            if (located.truncated)
                throw new CaxriError(
                    'NOT_FOUND',
                    'File not found; the Project is too large to locate a matching folder',
                );
            context.locatedSuffixes.set(key, null);
            return undefined;
        }
        const prefix = resolve(best, ...Array.from({ length: depth }, () => '..'));
        context.locatedSuffixes.set(key, prefix);
        return prefix;
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
                    // Free mode browses outside every Project authority, so it stops at the entry's own `lstat`
                    // and never follows a link target for display metadata.
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
                        source: 'directory',
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
        let displayDirectory: string | undefined;
        try {
            directory = await directoryIdentity(parsed.directory, mode === 'project');
        } catch (error) {
            if (mode !== 'project' || !(error instanceof CaxriError) || error.code !== 'NOT_FOUND')
                throw error;
            const folderName = input.endsWith('/') ? input.slice(0, -1) : '';
            if (folderName && !folderName.includes('/')) {
                /**
                 * A missing single-segment trailing-slash input is the existing Project-local "create folder" gesture.
                 * List its current parent with that name as the filter so Renderer can offer Create without weakening
                 * free-path browsing or swallowing permission and identity failures.
                 */
                parsed = { directory: context.currentDirectory, filter: folderName };
                directory = await directoryIdentity(context.currentDirectory, true);
            } else {
                const located = await locateProjectDirectory(context, input);
                if (!located) throw error;
                directory = located.directory;
                displayDirectory = located.displayDirectory;
            }
        }
        if (mode === 'project')
            return browseProject(context, directory, parsed.filter, input, displayDirectory);
        return browseFree(context, directory, parsed.filter, input);
    }

    async function openCandidate(context: BrowserContext, candidate: Candidate): Promise<Opened> {
        const isCurrentProjectPath = isSameOrInside(context.root.path, candidate.path);
        if (!isCurrentProjectPath && candidate.kind === 'symlink')
            throw new CaxriError('PATH_DENIED', 'Links outside the workspace cannot be opened');
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
        const directory = await directoryIdentity(authorized.path, isCurrentProjectPath);
        context.currentDirectory = directory.path;
        context.listedDirectory = directory;
        if (isCurrentProjectPath) {
            context.mode = 'project';
            context.freeOriginDirectory = undefined;
            return browseProject(context, directory, '', '');
        }
        if (context.mode === 'free') {
            context.freeOriginDirectory = directory.path;
            return browseFree(context, directory, '', '');
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
                locatedSuffixes: new Map(),
                mode: 'project',
                root,
                rootLabel: project.displayTitle,
                searchedFilters: new Map(),
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
                    const directory = await directoryIdentity(
                        await realpath(context.listedDirectory.path),
                    );
                    context.mode = 'free';
                    context.currentDirectory = directory.path;
                    context.freeOriginDirectory = directory.path;
                    return browseFree(context, directory, '', '');
                }
                if (target.kind === 'parent') {
                    const parentPath = dirname(context.listedDirectory.path);
                    const boundedParent =
                        context.mode === 'project' && !isSameOrInside(context.root.path, parentPath)
                            ? context.root.path
                            : parentPath;
                    const directory = await directoryIdentity(
                        boundedParent,
                        context.mode === 'project',
                    );
                    context.currentDirectory = directory.path;
                    context.listedDirectory = directory;
                    if (context.mode === 'free') {
                        context.freeOriginDirectory = directory.path;
                        return browseFree(context, directory, '', '');
                    }
                    return browseProject(context, directory, '', '');
                }
                const candidate = context.candidates.get(target.entryId);
                if (!candidate) throw new CaxriError('PATH_DENIED', 'Path browser entry expired');
                if (
                    candidate.kind === 'symlink' &&
                    !isSameOrInside(context.root.path, candidate.path)
                )
                    throw new CaxriError('PATH_DENIED', 'Symbolic links cannot be opened');
                const kind =
                    candidate.kind === 'symlink'
                        ? (
                              await options.getServer().request('files.authorizeOpen', {
                                  sessionId: context.browseSessionId,
                                  path: candidate.path,
                              })
                          ).kind
                        : candidate.kind;
                return kind === 'file'
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
