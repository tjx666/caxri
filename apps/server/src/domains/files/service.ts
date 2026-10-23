import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import type {
    AppSettings,
    FileAsset,
    FileDocument,
    FileEntry,
    ServerEvent,
    ServerOperationParameters,
    ServerOperationResult,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import type { ResolvedSessionPath } from '../project';
import { ProjectRootResolver } from '../project';
import type { OpenFile } from './documents';
import { DocumentService } from './documents';
import { moveToHostTrash } from './host-trash';
import {
    importCandidatePaths,
    ImportConfigFiles,
    isRelativeImportSpecifier,
    PackageImports,
    relativeImportCandidatePaths,
    TsconfigImports,
    tsconfigImportTargets,
} from './import-resolution';
import type { GitIgnoreDecorator, ListingServiceOptions, OpenDirectory } from './listing';
import { ListingService } from './listing';
import type { FileMutationJournalOptions, FileMutationOperationScope } from './mutation-journal';
import { FileMutationJournal } from './mutation-journal';
import type { FileMutationServiceOptions } from './mutations';
import { FileMutationService } from './mutations';
import { FileOperationQueue } from './operation-queue';
import type {
    ProjectFileSuffixSearchResult,
    ProjectSuffixLeafKind,
    SearchServiceOptions,
} from './search';
import { SearchService } from './search';
import { shallowestProjectPath } from './shallowest-project-path';
import type { WatcherServiceOptions } from './watcher';
import { WatcherService } from './watcher';

const MAXIMUM_DOCUMENT_QUEUE_WAIT_MS = 15_000;
const COPY_OPERATION_GROUP = 'files.copy';

export interface FileServiceOptions extends WatcherServiceOptions {
    decorateGitIgnored?: GitIgnoreDecorator;
    /**
     * Symlink follow budget factory shared by listing and browsing; see `ListingServiceOptions`.
     */
    listing?: ListingServiceOptions;
    fileTreeExcludes?: () => AppSettings['files.exclude'];
    maximumPendingOperations?: number;
    mutationJournal?: FileMutationJournalOptions;
    mutationJournalPath?: string;
    mutations?: FileMutationServiceOptions;
    openDirectory?: OpenDirectory;
    openFile?: OpenFile;
    search?: SearchServiceOptions;
}

/**
 * Composes Session-root resolution, document read/write, directory listing, and watching into the Server's file
 * surface. Each concern lives in its own module under `files/`; this class only wires them together and preserves the
 * public API composition root and tests depend on.
 */
export class FileService {
    private readonly projectRoots: ProjectRootResolver;
    private readonly documents: DocumentService;
    private readonly listing: ListingService;
    private readonly mutations: FileMutationService;
    private readonly mutationJournal: FileMutationJournal;
    private readonly operations: FileOperationQueue;
    private readonly searcher: SearchService;
    /**
     * Latest-wins per Session: a newer path-browser lookup aborts the walk still running for the previous keystroke.
     */
    private readonly activeLocates = new Map<string, AbortController>();
    private readonly watcher: WatcherService;
    private readonly importConfigs: TsconfigImports;
    private readonly importFiles: ImportConfigFiles;
    private readonly packageImports: PackageImports;

    constructor(
        database: CaxriDatabase,
        emit: (event: ServerEvent) => void,
        logger: StructuredLogger,
        maxFileBytes: () => number,
        options: FileServiceOptions = {},
    ) {
        this.projectRoots = new ProjectRootResolver(database);
        /**
         * Sub-services call back through `this.resolveSessionPath` (a real prototype method) rather than `projectRoots`
         * directly, so a test spying on `service.resolveSessionPath` still observes every internal call.
         */
        const resolveSessionPath = (sessionId: string, input?: string) =>
            this.resolveSessionPath(sessionId, input);
        const resolveWorkspacePath = (sessionId: string, input?: string) =>
            this.resolveSessionPath(sessionId, input, true);
        this.importFiles = new ImportConfigFiles(resolveWorkspacePath);
        this.packageImports = new PackageImports(this.importFiles);
        this.importConfigs = new TsconfigImports(this.importFiles, this.packageImports);
        this.operations = new FileOperationQueue(options.maximumPendingOperations);
        this.mutationJournal = new FileMutationJournal(
            options.mutationJournalPath,
            emit,
            logger,
            options.mutationJournal,
        );
        this.documents = new DocumentService(resolveWorkspacePath, logger, maxFileBytes, options);
        this.watcher = new WatcherService(resolveSessionPath, emit, logger, {
            ...options,
            resolveWorkspacePath,
        });
        this.listing = new ListingService(
            resolveWorkspacePath,
            logger,
            options.fileTreeExcludes ?? (() => ({})),
            async (sessionId, path, resolved) => {
                this.watcher.noteDirectoryListed(sessionId, path);
                await this.watcher.noteWorkspacePath(sessionId, resolved);
            },
            options.decorateGitIgnored,
            (sessionId, paths) => this.watcher.noteGitIgnoreRulePaths(sessionId, paths),
            options.openDirectory,
            options.listing,
        );
        this.searcher = new SearchService(resolveSessionPath, logger, maxFileBytes, options.search);
        this.mutations = new FileMutationService(resolveSessionPath, logger, options.mutations);
    }

    private mutationOperationScope(sessionId: string): FileMutationOperationScope {
        return {
            sessionId,
            workbenchProjectId: this.projectRoots.getSessionWorkbenchProjectId(sessionId),
        };
    }

    private async resolveImportSpecifier(
        parameters: ServerOperationParameters<'files.resolveImports'>,
        candidates: string[],
        budget: { remaining: number },
    ): Promise<string | undefined> {
        for (const candidate of candidates) {
            if (budget.remaining-- <= 0) return undefined;
            try {
                // eslint-disable-next-line no-await-in-loop -- first existing candidate wins, see resolveImports
                const resolved = await this.projectRoots.resolveSessionPath(
                    parameters.sessionId,
                    candidate,
                    true,
                );
                // eslint-disable-next-line no-await-in-loop -- first existing candidate wins, see resolveImports
                if ((await stat(resolved.path)).isFile())
                    return resolved.workspacePath ?? resolved.path;
            } catch (error) {
                /**
                 * A missing candidate is the expected answer for every extension the target does not use, so the loop
                 * moves on. Anything else (notably a path the Session is not allowed to reach) stops this specifier
                 * instead of falling through to the next guess, which would turn one refusal into a probe sequence.
                 */
                if (error instanceof CaxriError && error.code === 'NOT_FOUND') continue;
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                return undefined;
            }
        }
        return undefined;
    }

    resolveSessionPath(
        sessionId: string,
        input?: string,
        shouldFollowWorkspaceLinks = false,
    ): Promise<ResolvedSessionPath> {
        return this.projectRoots.resolveSessionPath(sessionId, input, shouldFollowWorkspaceLinks);
    }

    initialize(): Promise<void> {
        return this.mutationJournal.initialize();
    }

    /**
     * Returns durable Project roots that the user explicitly granted to Caxri.
     */
    listApprovedProjectRoots(): string[] {
        return this.projectRoots.listApprovedProjectRoots();
    }

    list(sessionId: string, directory?: string, signal?: AbortSignal): Promise<FileEntry[]> {
        return this.listing.list(sessionId, directory, signal);
    }

    listDirectory(
        sessionId: string,
        directory?: string,
        signal?: AbortSignal,
    ): Promise<ServerOperationResult<'files.list'>> {
        return this.listing.listDirectory(sessionId, directory, signal);
    }

    browse(
        parameters: ServerOperationParameters<'files.browse'>,
    ): Promise<ServerOperationResult<'files.browse'>> {
        return this.listing.browse(parameters);
    }

    async create(
        parameters: Omit<ServerOperationParameters<'files.create'>, 'operationId'> & {
            operationId?: string;
        },
    ): Promise<ServerOperationResult<'files.create'>> {
        const now = Date.now();
        const workbenchProjectId = this.projectRoots.getSessionWorkbenchProjectId(
            parameters.sessionId,
        );
        return this.mutationJournal.run(
            {
                id: parameters.operationId ?? randomUUID(),
                kind: 'create',
                sessionId: parameters.sessionId,
                workbenchProjectId,
                phase: 'pre_stage',
                input: {
                    directory: parameters.directory,
                    kind: parameters.kind,
                    name: parameters.name,
                },
                startedAt: now,
                updatedAt: now,
            },
            async (stage) => {
                const { path: directory } = await this.projectRoots.resolveSessionPath(
                    parameters.sessionId,
                    parameters.directory,
                );
                return this.operations.run(() => this.mutations.create(parameters, stage), {
                    paths: [resolve(directory, parameters.name)],
                });
            },
        );
    }

    async copy(
        parameters: ServerOperationParameters<'files.copy'>,
    ): Promise<ServerOperationResult<'files.copy'>> {
        const [source, directory] = await Promise.all([
            this.projectRoots.resolveSessionPath(parameters.sessionId, parameters.path),
            this.projectRoots.resolveSessionPath(parameters.sessionId, parameters.directory),
        ]);
        return this.operations.run(() => this.mutations.copy(parameters), {
            group: `${COPY_OPERATION_GROUP}:${source.root}`,
            paths: [source.path, resolve(directory.path, basename(source.path))],
        });
    }

    async rename(
        parameters: Omit<ServerOperationParameters<'files.rename'>, 'operationId'> & {
            operationId?: string;
        },
    ): Promise<ServerOperationResult<'files.rename'>> {
        const now = Date.now();
        const workbenchProjectId = this.projectRoots.getSessionWorkbenchProjectId(
            parameters.sessionId,
        );
        return this.mutationJournal.run(
            {
                id: parameters.operationId ?? randomUUID(),
                kind: 'rename',
                sessionId: parameters.sessionId,
                workbenchProjectId,
                phase: 'pre_stage',
                input: { name: parameters.name, path: parameters.path },
                startedAt: now,
                updatedAt: now,
            },
            async (stage) => {
                const { path: source } = await this.projectRoots.resolveSessionPath(
                    parameters.sessionId,
                    parameters.path,
                );
                return this.operations.run(() => this.mutations.rename(parameters, stage), {
                    paths: [source, resolve(dirname(source), parameters.name)],
                });
            },
        );
    }

    async move(
        parameters: Omit<ServerOperationParameters<'files.move'>, 'operationId'> & {
            operationId?: string;
        },
    ): Promise<ServerOperationResult<'files.move'>> {
        const now = Date.now();
        const workbenchProjectId = this.projectRoots.getSessionWorkbenchProjectId(
            parameters.sessionId,
        );
        return this.mutationJournal.run(
            {
                id: parameters.operationId ?? randomUUID(),
                kind: 'move',
                sessionId: parameters.sessionId,
                workbenchProjectId,
                phase: 'pre_stage',
                input: {
                    conflict: parameters.conflict,
                    directory: parameters.directory,
                    path: parameters.path,
                },
                startedAt: now,
                updatedAt: now,
            },
            async (stage) => {
                const [source, directory] = await Promise.all([
                    this.projectRoots.resolveSessionPath(parameters.sessionId, parameters.path),
                    this.projectRoots.resolveSessionPath(
                        parameters.sessionId,
                        parameters.directory,
                    ),
                ]);
                return this.operations.run(() => this.mutations.move(parameters, stage), {
                    paths: [source.path, resolve(directory.path, basename(source.path))],
                });
            },
        );
    }

    getMutationOperation(operationId: string) {
        return this.mutationJournal.get(operationId);
    }

    getScopedMutationOperation(sessionId: string, operationId: string) {
        return this.mutationJournal.getScoped(operationId, this.mutationOperationScope(sessionId));
    }

    listScopedMutationOperations(sessionId: string) {
        return this.mutationJournal.listScoped(this.mutationOperationScope(sessionId));
    }

    cancelScopedMutationOperation(sessionId: string, operationId: string) {
        return this.mutationJournal.cancelScoped(
            operationId,
            this.mutationOperationScope(sessionId),
        );
    }

    acknowledgeMutationOperation(operationId: string): Promise<void> {
        return this.mutationJournal.acknowledge(operationId);
    }

    acknowledgeScopedMutationOperation(sessionId: string, operationId: string): Promise<void> {
        return this.mutationJournal.acknowledgeScoped(
            operationId,
            this.mutationOperationScope(sessionId),
        );
    }

    async authorizeTrash(
        parameters: ServerOperationParameters<'files.authorizeTrash'>,
    ): Promise<ServerOperationResult<'files.authorizeTrash'>> {
        const { path } = await this.projectRoots.resolveSessionPath(
            parameters.sessionId,
            parameters.path,
        );
        return this.operations.run(() => this.mutations.authorizeTrash(parameters), {
            paths: [path],
        });
    }

    async trashOnHost(parameters: ServerOperationParameters<'files.trashOnHost'>): Promise<void> {
        const { path } = await this.projectRoots.resolveSessionPath(
            parameters.sessionId,
            parameters.path,
        );
        await this.operations.run(
            async () => {
                const entry = await this.mutations.authorizeTrash(parameters);
                if (entry.device !== parameters.device || entry.inode !== parameters.inode)
                    throw new CaxriError(
                        'CONFLICT',
                        'File or folder changed before it reached Trash',
                    );
                await moveToHostTrash(entry.path);
            },
            { paths: [path] },
        );
    }

    async authorizeOpen(
        parameters: ServerOperationParameters<'files.authorizeOpen'>,
    ): Promise<ServerOperationResult<'files.authorizeOpen'>> {
        const resolved = await this.projectRoots.resolveSessionPath(
            parameters.sessionId,
            parameters.path,
            true,
        );
        return this.operations.run(
            () => this.documents.authorizeOpen(parameters.sessionId, parameters.path, resolved),
            {
                paths: [resolved.path],
            },
        );
    }

    /**
     * Resolves relative and tsconfig-mapped module specifiers in one open document to authorized files.
     *
     * Candidates are built from the document's own entry path rather than its canonical path, so a document reached
     * through a workspace link resolves its siblings the way the user sees them. Every candidate still goes through
     * `resolveSessionPath`, so a specifier that climbs out of the Session's Project (`'../../../../etc/passwd'`) is
     * refused by the same check every other file read uses. A specifier that resolves to nothing is simply left out:
     * the editor then shows no link. Configuration lookup stays inside the same authorized Project.
     */
    async resolveImports(
        parameters: ServerOperationParameters<'files.resolveImports'>,
    ): Promise<ServerOperationResult<'files.resolveImports'>> {
        const from = await this.projectRoots.resolveSessionPath(
            parameters.sessionId,
            parameters.from,
            true,
        );
        const resolved: Array<{ path: string; specifier: string }> = [];
        const uniqueSpecifiers = new Set(parameters.specifiers);
        const budget = { remaining: 4096 };
        const config = parameters.specifiers.some(
            (specifier) => !isRelativeImportSpecifier(specifier),
        )
            ? await this.importConfigs.load(parameters.sessionId, from)
            : undefined;
        for (const specifier of uniqueSpecifiers) {
            if (budget.remaining <= 0) break;
            // Candidates are probed in order and the first regular file wins, so these awaits are intentionally
            // sequential: a parallel probe would do the filesystem work of every fallback for every hit.
            const candidates = isRelativeImportSpecifier(specifier)
                ? relativeImportCandidatePaths(from.workspacePath ?? from.path, specifier)
                : tsconfigImportTargets(config, specifier).flatMap(importCandidatePaths);
            // oxlint-disable-next-line react-doctor/async-await-in-loop
            let path = await this.resolveImportSpecifier(parameters, candidates, budget); // eslint-disable-line no-await-in-loop -- see above
            if (!path && !isRelativeImportSpecifier(specifier) && budget.remaining > 0) {
                // oxlint-disable-next-line react-doctor/async-await-in-loop
                // eslint-disable-next-line no-await-in-loop -- package fallback follows alias resolution
                const packageCandidates = await this.packageImports.candidates(
                    parameters.sessionId,
                    from,
                    specifier,
                );
                // oxlint-disable-next-line react-doctor/async-await-in-loop
                path = await this.resolveImportSpecifier(parameters, packageCandidates, budget); // eslint-disable-line no-await-in-loop -- first authorized target wins
            }
            if (path) resolved.push({ path, specifier });
        }
        return { resolved };
    }

    async read(sessionId: string, path: string, signal?: AbortSignal): Promise<FileDocument> {
        signal?.throwIfAborted();
        const operationPath = await this.projectRoots.resolveSessionPath(sessionId, path, true);
        await this.watcher.noteWorkspacePath(sessionId, operationPath);
        return this.operations.run(
            () => this.documents.read(sessionId, path, signal, operationPath),
            {
                maximumWaitMs: MAXIMUM_DOCUMENT_QUEUE_WAIT_MS,
                paths: [operationPath.path],
            },
        );
    }

    async readAsset(sessionId: string, path: string, signal?: AbortSignal): Promise<FileAsset> {
        signal?.throwIfAborted();
        const operationPath = await this.projectRoots.resolveSessionPath(sessionId, path, true);
        await this.watcher.noteWorkspacePath(sessionId, operationPath);
        return this.operations.run(
            () => this.documents.readAsset(sessionId, path, signal, operationPath),
            {
                maximumWaitMs: MAXIMUM_DOCUMENT_QUEUE_WAIT_MS,
                paths: [operationPath.path],
            },
        );
    }

    async write(
        sessionId: string,
        path: string,
        content: string,
        expectedContentHash?: string,
    ): Promise<FileDocument> {
        const operationPath = await this.projectRoots.resolveSessionPath(sessionId, path, true);
        return this.operations.run(
            () =>
                this.documents.write(sessionId, path, content, operationPath, expectedContentHash),
            {
                maximumWaitMs: MAXIMUM_DOCUMENT_QUEUE_WAIT_MS,
                paths: [operationPath.path],
            },
        );
    }

    search(
        parameters: ServerOperationParameters<'files.search'>,
        signal?: AbortSignal,
    ): Promise<ServerOperationResult<'files.search'>> {
        return this.searcher.search(parameters, signal);
    }

    /**
     * Searches one authorized root for a complete relative suffix without scanning unrelated file names.
     */
    searchProjectFileSuffixes(
        sessionId: string,
        root: string,
        suffix: string,
        signal: AbortSignal,
        leafKind?: ProjectSuffixLeafKind,
    ): Promise<ProjectFileSuffixSearchResult> {
        return this.searcher.searchProjectFileSuffixes(sessionId, root, suffix, signal, leafKind);
    }

    /**
     * Path-browser fallback: locates the Project-local directory whose relative path ends with `suffix`, so a relative
     * path copied without its leading directories (for example from Agent output) can still be browsed. The shallowest
     * match wins, and that selection rule is owned here rather than by the caller so the returned path and the rule
     * that produced it cannot drift apart.
     */
    async locateDirectory(
        parameters: ServerOperationParameters<'files.locateDirectory'>,
        signal?: AbortSignal,
    ): Promise<ServerOperationResult<'files.locateDirectory'>> {
        const { root } = await this.resolveSessionPath(parameters.sessionId);
        this.activeLocates.get(parameters.sessionId)?.abort();
        const controller = new AbortController();
        this.activeLocates.set(parameters.sessionId, controller);
        const cancel = (): void => controller.abort();
        if (signal?.aborted) controller.abort();
        signal?.addEventListener('abort', cancel, { once: true });
        let result: ProjectFileSuffixSearchResult;
        try {
            result = await this.searcher.searchProjectFileSuffixes(
                parameters.sessionId,
                root,
                parameters.suffix,
                controller.signal,
                'directory',
            );
        } finally {
            signal?.removeEventListener('abort', cancel);
            if (this.activeLocates.get(parameters.sessionId) === controller)
                this.activeLocates.delete(parameters.sessionId);
        }
        if (result.canceled) throw new CaxriError('CANCELLED', 'Directory lookup was superseded');
        return {
            path:
                shallowestProjectPath(
                    root,
                    result.matches.map((match) => match.path),
                ) ?? null,
            truncated: result.truncated,
        };
    }

    watchSession(sessionId?: string): Promise<boolean> {
        return this.watcher.watchSession(
            sessionId
                ? {
                      sessionId,
                      workbenchProjectId: this.projectRoots.getSessionWorkbenchProjectId(sessionId),
                  }
                : undefined,
        );
    }

    /**
     * Reinstalls the selected watcher after its Session atomically changes Workbench Root.
     */
    refreshWatchSession(sessionId: string): Promise<boolean> {
        return this.watcher.watchSession(
            {
                sessionId,
                workbenchProjectId: this.projectRoots.getSessionWorkbenchProjectId(sessionId),
            },
            true,
        );
    }

    async close(): Promise<void> {
        this.importFiles.clear();
        await Promise.all([
            this.searcher.close(),
            this.watcher.close(),
            this.mutationJournal.close(),
        ]);
    }
}
