import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';

import type {
    AppSettings,
    FileDocument,
    FileEntry,
    ServerEvent,
    ServerOperationParameters as ServerOperationParameters,
    ServerOperationResult,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import type { ResolvedSessionPath } from '../project-roots';
import { ProjectRootResolver } from '../project-roots';
import type { OpenFile } from './documents';
import { DocumentService } from './documents';
import type { GitIgnoreDecorator, OpenDirectory } from './listing';
import { ListingService } from './listing';
import type { FileMutationJournalOptions, FileMutationOperationScope } from './mutation-journal';
import { FileMutationJournal } from './mutation-journal';
import type { FileMutationServiceOptions } from './mutations';
import { FileMutationService } from './mutations';
import { FileOperationQueue } from './operation-queue';
import type { SearchServiceOptions } from './search';
import { SearchService } from './search';
import type { WatcherServiceOptions } from './watcher';
import { WatcherService } from './watcher';

const MAXIMUM_DOCUMENT_QUEUE_WAIT_MS = 15_000;
const COPY_OPERATION_GROUP = 'files.copy';

export interface FileServiceOptions extends WatcherServiceOptions {
    decorateGitIgnored?: GitIgnoreDecorator;
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
 * Composes Session-root resolution, document read/write, directory listing, and watching into the Runtime's file
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
    private readonly watcher: WatcherService;

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
        this.operations = new FileOperationQueue(options.maximumPendingOperations);
        this.mutationJournal = new FileMutationJournal(
            options.mutationJournalPath,
            emit,
            logger,
            options.mutationJournal,
        );
        this.documents = new DocumentService(resolveSessionPath, logger, maxFileBytes, options);
        this.watcher = new WatcherService(resolveSessionPath, emit, logger, options);
        this.listing = new ListingService(
            resolveSessionPath,
            logger,
            options.fileTreeExcludes ?? (() => ({})),
            (sessionId, path) => this.watcher.noteDirectoryListed(sessionId, path),
            options.decorateGitIgnored,
            (sessionId, paths) => this.watcher.noteGitIgnoreRulePaths(sessionId, paths),
            options.openDirectory,
        );
        this.searcher = new SearchService(
            resolveSessionPath,
            (sessionId, path, signal) => this.read(sessionId, path, signal),
            logger,
            maxFileBytes,
            options.search,
        );
        this.mutations = new FileMutationService(resolveSessionPath, logger, options.mutations);
    }

    private mutationOperationScope(sessionId: string): FileMutationOperationScope {
        return {
            sessionId,
            workbenchProjectId: this.projectRoots.getSessionWorkbenchProjectId(sessionId),
        };
    }

    resolveSessionPath(sessionId: string, input?: string): Promise<ResolvedSessionPath> {
        return this.projectRoots.resolveSessionPath(sessionId, input);
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

    async authorizeOpen(
        parameters: ServerOperationParameters<'files.authorizeOpen'>,
    ): Promise<ServerOperationResult<'files.authorizeOpen'>> {
        const { path } = await this.projectRoots.resolveSessionPath(
            parameters.sessionId,
            parameters.path,
        );
        return this.operations.run(() => this.mutations.authorizeOpen(parameters), {
            paths: [path],
        });
    }

    async read(sessionId: string, path: string, signal?: AbortSignal): Promise<FileDocument> {
        signal?.throwIfAborted();
        const operationPath = await this.projectRoots.resolveSessionPath(sessionId, path);
        return this.operations.run(() => this.documents.read(sessionId, path, signal), {
            maximumWaitMs: MAXIMUM_DOCUMENT_QUEUE_WAIT_MS,
            paths: [operationPath.path],
        });
    }

    async write(sessionId: string, path: string, content: string): Promise<FileDocument> {
        const operationPath = await this.projectRoots.resolveSessionPath(sessionId, path);
        return this.operations.run(() => this.documents.write(sessionId, path, content), {
            maximumWaitMs: MAXIMUM_DOCUMENT_QUEUE_WAIT_MS,
            paths: [operationPath.path],
        });
    }

    search(
        parameters: ServerOperationParameters<'files.search'>,
        signal?: AbortSignal,
    ): Promise<ServerOperationResult<'files.search'>> {
        return this.searcher.search(parameters, signal);
    }

    watchSession(sessionId?: string): Promise<void> {
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
    refreshWatchSession(sessionId: string): Promise<void> {
        return this.watcher.watchSession(
            {
                sessionId,
                workbenchProjectId: this.projectRoots.getSessionWorkbenchProjectId(sessionId),
            },
            true,
        );
    }

    async close(): Promise<void> {
        await Promise.all([this.watcher.close(), this.mutationJournal.close()]);
    }
}
