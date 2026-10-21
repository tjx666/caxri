import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
    FileSearchMatch,
    ServerOperationResult,
    TerminalFileLinkCandidate,
} from '@caxri/protocol';
import { CaxriError, isPathInTrustedFolder, isTopLevelProject } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { isSameOrInside } from '../path-security';

const MAX_TERMINAL_FILE_LINK_CANDIDATES = 50;
const TERMINAL_FILE_LINK_SEARCH_TIMEOUT_MS = 5_000;

interface TerminalFileLinkResolverOptions {
    searchProjectFileSuffixes?: (
        sessionId: string,
        root: string,
        suffix: string,
        signal: AbortSignal,
    ) => Promise<{
        matches: FileSearchMatch[];
        truncated: boolean;
        canceled: boolean;
    }>;
    /**
     * Normalized `security.trustedFolders` rules; a matching external target lets Main skip its confirmation prompt.
     */
    trustedFolders?: readonly string[];
    userHome?: string;
}

interface TerminalFileIdentity {
    device: string;
    inode: string;
    root: { path: string; device: string; inode: string };
}

interface ResolvedCandidate {
    candidate: TerminalFileLinkCandidate;
    identity: TerminalFileIdentity;
}

export type TerminalFileLinkResolution = ServerOperationResult<'terminal.fileLink.resolve'>;

function missingFile(error: unknown): never {
    if (isMissingFileSystemError(error)) throw new CaxriError('NOT_FOUND', 'File not found');
    throw error;
}

function isMissingFileSystemError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

function isNotFound(error: unknown): boolean {
    return error instanceof CaxriError && error.code === 'NOT_FOUND';
}

async function lstatExisting(path: string) {
    try {
        return await lstat(path, { bigint: true });
    } catch (error) {
        return missingFile(error);
    }
}

async function realpathExisting(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch (error) {
        return missingFile(error);
    }
}

/**
 * Authorizes `candidate` against `rootPath` and reports whether it is a regular file or a directory. A directory is
 * accepted only when `canBeDirectory` is set: suffix-search candidates are files by construction and must stay so.
 * Anything else (a socket, a device) is refused.
 */
async function resolveAuthorizedTarget(
    rootPath: string,
    candidate: string,
    canBeDirectory: boolean,
) {
    const rootBefore = await lstatExisting(rootPath);
    if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory())
        throw new CaxriError('PATH_DENIED', 'Selected Project root is not a directory');
    const [canonicalRoot, canonicalTarget] = await Promise.all([
        realpathExisting(rootPath),
        realpathExisting(candidate),
    ]);
    const [rootAfter, target] = await Promise.all([
        lstatExisting(rootPath),
        lstatExisting(canonicalTarget),
    ]);
    if (
        rootAfter.isSymbolicLink() ||
        !rootAfter.isDirectory() ||
        rootAfter.dev !== rootBefore.dev ||
        rootAfter.ino !== rootBefore.ino ||
        (await realpathExisting(rootPath)) !== canonicalRoot
    )
        throw new CaxriError('PATH_DENIED', 'Selected Project root changed during authorization');
    if (!isSameOrInside(canonicalRoot, canonicalTarget))
        throw new CaxriError('PATH_DENIED', 'Terminal link target is outside the selected Project');
    const kind: 'directory' | 'file' | undefined = target.isFile()
        ? 'file'
        : canBeDirectory && target.isDirectory()
          ? 'directory'
          : undefined;
    if (!kind)
        throw new CaxriError(
            'VALIDATION',
            canBeDirectory
                ? 'Terminal link target is not a regular file or directory'
                : 'Terminal link target is not a regular file',
        );
    return {
        kind,
        identity: {
            device: target.dev.toString(),
            inode: target.ino.toString(),
            root: {
                path: canonicalRoot,
                device: rootAfter.dev.toString(),
                inode: rootAfter.ino.toString(),
            },
        },
        path: canonicalTarget,
        rootPath: canonicalRoot,
    };
}

/**
 * Projects a Terminal link may open through. An auto-registered worktree Project (`ownerProjectId` set) can never own a
 * Session, so it is a target only while a live Session uses it as its Workbench Root; otherwise a link into it is
 * treated as external and Main opens a read-only snapshot instead of creating a Session nobody could see. A hidden
 * Project is excluded for the same reason.
 */
function fileLinkProjects(database: CaxriDatabase) {
    return database
        .listVisibleProjects()
        .filter(
            (project) =>
                isTopLevelProject(project) ||
                database
                    .listSessionsUsingWorkbenchProject(project.id)
                    .some((session) => session.archivedAt === undefined),
        );
}

function projectContainingPath(database: CaxriDatabase, path: string) {
    return fileLinkProjects(database)
        .filter(({ rootPath }) => isSameOrInside(rootPath, path))
        .toSorted((left, right) => right.rootPath.length - left.rootPath.length)
        .at(0);
}

function projectRelativePath(root: string, path: string): string {
    return relative(root, path).split(sep).join('/');
}

async function resolveAuthorizedCandidate(
    database: CaxriDatabase,
    sourceSessionId: string,
    candidatePath: string,
): Promise<TerminalFileLinkResolution | undefined> {
    const project = projectContainingPath(database, candidatePath);
    if (!project) return;
    try {
        const authorized = await resolveAuthorizedTarget(project.rootPath, candidatePath, true);
        return {
            status: 'authorized',
            kind: authorized.kind,
            identity: authorized.identity,
            path: authorized.path,
            projectId: project.id,
            sourceSessionId,
        };
    } catch (error) {
        if (isNotFound(error)) return;
        throw error;
    }
}

function fileUrlPath(target: string): string {
    try {
        const url = new URL(target);
        if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost'))
            throw new CaxriError('VALIDATION', 'Only local file URLs can be opened');
        return fileURLToPath(url);
    } catch (error) {
        if (error instanceof CaxriError) throw error;
        throw new CaxriError('VALIDATION', 'Terminal file URL is invalid');
    }
}

function exactCandidatePaths(target: string, cwd: string, projectRoot: string): string[] {
    if (/^file:\/\//iu.test(target)) return [fileUrlPath(target)];
    if (isAbsolute(target)) return [resolve(target)];
    if (target.startsWith('.../')) return [];
    if (target.startsWith('./') || target.startsWith('../')) return [resolve(cwd, target)];
    const candidates = [resolve(projectRoot, target), resolve(cwd, target)];
    if (/^[ab]\//u.test(target)) candidates.push(resolve(projectRoot, target.slice(2)));
    return [...new Set(candidates)];
}

interface TerminalFileLinkSearch {
    scope: 'all' | 'current';
    suffix: string;
}

function terminalFileLinkSearch(target: string): TerminalFileLinkSearch | undefined {
    /**
     * Ordinary relative paths may be incomplete Agent output, so exact misses fall back to a suffix search inside the
     * current Workbench Project. Only an explicit ellipsis opts into searching every authorized Project.
     */
    const isCrossProject = target.startsWith('.../');
    const suffix = isCrossProject ? target.slice(4) : target.replace(/^[ab][\\/]/u, '');
    const segments = suffix.split(/[\\/]/u);
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return;
    return { scope: isCrossProject ? 'all' : 'current', suffix: segments.join('/') };
}

function isMatchingSuffix(relativePath: string, suffix: string): boolean {
    const normalizedPath = relativePath.toLowerCase();
    const normalizedSuffix = suffix.toLowerCase();
    return normalizedPath === normalizedSuffix || normalizedPath.endsWith(`/${normalizedSuffix}`);
}

async function hasReachedCandidateLimit(
    project: ReturnType<CaxriDatabase['listProjects']>[number],
    matches: FileSearchMatch[],
    suffix: string,
    candidates: ResolvedCandidate[],
    canonicalPaths: Set<string>,
): Promise<boolean> {
    for (const match of matches) {
        if (!isMatchingSuffix(match.relativePath, suffix)) continue;
        let authorized: Awaited<ReturnType<typeof resolveAuthorizedTarget>>;
        try {
            // eslint-disable-next-line no-await-in-loop -- each returned path is revalidated before exposure
            authorized = await resolveAuthorizedTarget(project.rootPath, match.path, false);
        } catch (error) {
            if (isNotFound(error)) continue;
            throw error;
        }
        if (canonicalPaths.has(authorized.path)) continue;
        canonicalPaths.add(authorized.path);
        candidates.push({
            candidate: {
                path: authorized.path,
                relativePath: projectRelativePath(authorized.rootPath, authorized.path),
                projectId: project.id,
                projectTitle: project.displayTitle,
            },
            identity: authorized.identity,
        });
        if (candidates.length >= MAX_TERMINAL_FILE_LINK_CANDIDATES) return true;
    }
    return false;
}

async function searchAuthorizedProjects(
    database: CaxriDatabase,
    sourceSessionId: string,
    sourceProjectId: string,
    suffix: string,
    searchProjectFileSuffixes: NonNullable<
        TerminalFileLinkResolverOptions['searchProjectFileSuffixes']
    >,
    scope: TerminalFileLinkSearch['scope'],
): Promise<{
    candidates: ResolvedCandidate[];
    truncated: boolean;
    timedOut: boolean;
    searchLimitReached: boolean;
}> {
    const controller = new AbortController();
    let isTimedOut = false;
    const timeout = setTimeout(() => {
        isTimedOut = true;
        controller.abort();
    }, TERMINAL_FILE_LINK_SEARCH_TIMEOUT_MS);
    const sourceProject = database.getProject(sourceProjectId);
    const projects =
        scope === 'current'
            ? sourceProject
                ? [sourceProject]
                : []
            : fileLinkProjects(database).toSorted((left, right) => {
                  const leftSource = left.id === sourceProjectId ? 0 : 1;
                  const rightSource = right.id === sourceProjectId ? 0 : 1;
                  return (
                      leftSource - rightSource ||
                      left.displayTitle.localeCompare(right.displayTitle)
                  );
              });
    const candidates: ResolvedCandidate[] = [];
    const canonicalPaths = new Set<string>();
    let isTruncated = false;
    let hasReachedSearchLimit = false;
    try {
        for (const project of projects) {
            if (controller.signal.aborted) break;
            let result: Awaited<ReturnType<typeof searchProjectFileSuffixes>>;
            try {
                // eslint-disable-next-line no-await-in-loop -- one shared deadline and candidate budget bound every Project
                result = await searchProjectFileSuffixes(
                    sourceSessionId,
                    project.rootPath,
                    suffix,
                    controller.signal,
                );
            } catch (error) {
                if (isMissingFileSystemError(error)) {
                    isTruncated = true;
                    continue;
                }
                if (error instanceof CaxriError) throw error;
                throw new CaxriError('IO', 'Project files could not be searched');
            }
            isTruncated ||= result.truncated || result.canceled;
            hasReachedSearchLimit ||= result.truncated;
            // eslint-disable-next-line no-await-in-loop -- one global budget serializes Project results
            const hasReachedLimit = await hasReachedCandidateLimit(
                project,
                result.matches,
                suffix,
                candidates,
                canonicalPaths,
            );
            if (hasReachedLimit) {
                isTruncated = true;
                hasReachedSearchLimit = true;
                controller.abort();
            }
        }
    } finally {
        clearTimeout(timeout);
    }
    return {
        candidates,
        truncated: isTruncated || isTimedOut,
        timedOut: isTimedOut,
        searchLimitReached: hasReachedSearchLimit,
    };
}

async function resolveUserHome(userHomeOverride: string | undefined): Promise<string> {
    return realpathExisting(userHomeOverride ?? homedir());
}

/**
 * Shared outcome for any explicit candidate outside every added Project, whether it arrived as `~/...` text or as an
 * absolute path / `file://` URL (OSC 8 hyperlinks carry the absolute URI even when the visible label says `~/...`).
 * Server Core never reads the target here: Main decides whether to prompt, using `trusted` from the
 * `security.trustedFolders` setting, and then reads one bounded read-only snapshot itself.
 */
function externalResolution(
    sourceSessionId: string,
    candidate: string,
    trustedFolders: readonly string[],
): TerminalFileLinkResolution {
    return {
        status: 'external',
        path: candidate,
        sourceSessionId,
        trusted: isPathInTrustedFolder(candidate, trustedFolders),
    };
}

async function resolveHomeLink(
    database: CaxriDatabase,
    sourceSessionId: string,
    target: string,
    options: TerminalFileLinkResolverOptions,
): Promise<TerminalFileLinkResolution> {
    const userHome = await resolveUserHome(options.userHome);
    const candidate = resolve(userHome, target.slice(2));
    if (!isSameOrInside(userHome, candidate))
        throw new CaxriError('PATH_DENIED', 'Terminal link escapes the current user Home');
    const project = projectContainingPath(database, candidate);
    if (!project)
        return externalResolution(sourceSessionId, candidate, options.trustedFolders ?? []);
    const authorized = await resolveAuthorizedTarget(project.rootPath, candidate, true);
    return {
        status: 'authorized',
        kind: authorized.kind,
        identity: authorized.identity,
        path: authorized.path,
        projectId: project.id,
        sourceSessionId,
    };
}

/**
 * Resolves a Terminal path only through durable Project grants. Exact cwd/Project candidates are tried first; an
 * ordinary relative miss searches the current Workbench Project by suffix, while explicit `.../` searches every
 * authorized Project. Ambiguous matches return safe display metadata for the Renderer picker. A selected candidate is
 * revalidated on its next request before Main opens it.
 */
export async function resolveTerminalFileLink(
    database: CaxriDatabase,
    parameters: { terminalId: string; target: string },
    options: TerminalFileLinkResolverOptions = {},
): Promise<TerminalFileLinkResolution> {
    const terminal = database.getTerminal(parameters.terminalId);
    if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
    const session = database.getSession(terminal.sessionId);
    if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
    if (parameters.target.startsWith('~/')) {
        if (parameters.target === '~/')
            throw new CaxriError('VALIDATION', 'Home Terminal links require a file path');
        return resolveHomeLink(database, terminal.sessionId, parameters.target, options);
    }
    if (parameters.target.startsWith('~'))
        throw new CaxriError('VALIDATION', 'Only current-user ~/ Terminal links are supported');
    if (/^\$(?:HOME|\{HOME\})\//u.test(parameters.target))
        throw new CaxriError('VALIDATION', 'Shell Home variables are not supported in file links');

    const exactCandidates = exactCandidatePaths(parameters.target, terminal.cwd, session.rootPath);
    const unauthorizedExactCandidate = exactCandidates.find(
        (candidate) => !projectContainingPath(database, candidate),
    );
    for (const candidate of exactCandidates) {
        // eslint-disable-next-line no-await-in-loop -- exact candidates are ordered and bounded to three paths
        const resolved = await resolveAuthorizedCandidate(database, terminal.sessionId, candidate);
        if (resolved) return resolved;
    }
    if (
        isAbsolute(parameters.target) ||
        /^file:\/\//iu.test(parameters.target) ||
        parameters.target.startsWith('./') ||
        parameters.target.startsWith('../')
    ) {
        if (unauthorizedExactCandidate)
            return externalResolution(
                terminal.sessionId,
                unauthorizedExactCandidate,
                options.trustedFolders ?? [],
            );
        throw new CaxriError('NOT_FOUND', 'File not found');
    }

    const search = terminalFileLinkSearch(parameters.target);
    if (!search || !options.searchProjectFileSuffixes)
        throw new CaxriError('NOT_FOUND', 'File not found');
    const result = await searchAuthorizedProjects(
        database,
        terminal.sessionId,
        session.workbenchProjectId,
        search.suffix,
        options.searchProjectFileSuffixes,
        search.scope,
    );
    if (result.candidates.length === 0) {
        if (result.timedOut)
            throw new CaxriError('TIMEOUT', 'File search did not finish before its safety limit');
        if (result.searchLimitReached)
            throw new CaxriError(
                'CAPACITY',
                'File search reached its safety limit before completion',
            );
        throw new CaxriError('NOT_FOUND', 'File not found');
    }
    if (result.candidates.length === 1 && !result.truncated) {
        const [{ candidate, identity }] = result.candidates;
        return {
            status: 'authorized',
            kind: 'file',
            identity,
            path: candidate.path,
            projectId: candidate.projectId,
            sourceSessionId: terminal.sessionId,
        };
    }
    return {
        status: 'ambiguous',
        candidates: result.candidates.map(({ candidate }) => candidate),
        sourceSessionId: terminal.sessionId,
        truncated: result.truncated,
    };
}
