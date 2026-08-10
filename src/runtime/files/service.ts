import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';

import type { RuntimeEvent } from '../../shared/ipc/events';
import type { RuntimeMethodParams, RuntimeMethodResult } from '../../shared/ipc/methods';
import type { StructuredLogger } from '../../shared/node/logger';
import type { AppSettings, FileDocument, FileEntry } from '../../shared/types';
import type { CaxriDatabase } from '../db/repository';
import { ProjectRootResolver, type ResolvedSessionPath } from '../project-roots';
import { DocumentService, type OpenFile } from './documents';
import { ListingService, type OpenDirectory } from './listing';
import { FileMutationService, type FileMutationServiceOptions } from './mutations';
import { FileMutationJournal, type FileMutationJournalOptions } from './mutation-journal';
import { FileOperationQueue } from './operation-queue';
import { SearchService, type SearchServiceOptions } from './search';
import { WatcherService, type WatcherServiceOptions } from './watcher';

const MAXIMUM_DOCUMENT_QUEUE_WAIT_MS = 15_000;
const COPY_OPERATION_GROUP = 'files.copy';

export interface FileServiceOptions extends WatcherServiceOptions {
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
 * Composes Session-root resolution, document read/write, directory listing, and watching into the
 * Runtime's file surface. Each concern lives in its own module under `files/`; this class only
 * wires them together and preserves the public API bootstrap.ts and tests depend on.
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
        emit: (event: RuntimeEvent) => void,
        logger: StructuredLogger,
        maxFileBytes: () => number,
        options: FileServiceOptions = {},
    ) {
        this.projectRoots = new ProjectRootResolver(database);
        /**
         * Sub-services call back through `this.resolveSessionPath` (a real prototype method) rather
         * than `projectRoots` directly, so a test spying on `service.resolveSessionPath` still
         * observes every internal call.
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
            options.openDirectory,
        );
        this.searcher = new SearchService(
            resolveSessionPath,
            (sessionId, path) => this.read(sessionId, path),
            logger,
            maxFileBytes,
            options.search,
        );
        this.mutations = new FileMutationService(resolveSessionPath, logger, options.mutations);
    }

    resolveSessionPath(sessionId: string, input?: string): Promise<ResolvedSessionPath> {
        return this.projectRoots.resolveSessionPath(sessionId, input);
    }

    initialize(): Promise<void> {
        return this.mutationJournal.initialize();
    }

    /** Returns durable Project roots that the user explicitly granted to Caxri. */
    listApprovedProjectRoots(): string[] {
        return this.projectRoots.listApprovedProjectRoots();
    }

    list(sessionId: string, directory?: string): Promise<FileEntry[]> {
        return this.listing.list(sessionId, directory);
    }

    browse(
        params: RuntimeMethodParams<'files.browse'>,
    ): Promise<RuntimeMethodResult<'files.browse'>> {
        return this.listing.browse(params);
    }

    async create(
        params: Omit<RuntimeMethodParams<'files.create'>, 'operationId'> & {
            operationId?: string;
        },
    ): Promise<RuntimeMethodResult<'files.create'>> {
        const now = Date.now();
        return this.mutationJournal.run(
            {
                id: params.operationId ?? randomUUID(),
                kind: 'create',
                sessionId: params.sessionId,
                phase: 'pre_stage',
                input: { directory: params.directory, kind: params.kind, name: params.name },
                startedAt: now,
                updatedAt: now,
            },
            async (stage) => {
                const { path: directory } = await this.projectRoots.resolveSessionPath(
                    params.sessionId,
                    params.directory,
                );
                return this.operations.run(() => this.mutations.create(params, stage), {
                    paths: [resolve(directory, params.name)],
                });
            },
        );
    }

    async copy(
        params: RuntimeMethodParams<'files.copy'>,
    ): Promise<RuntimeMethodResult<'files.copy'>> {
        const [source, directory] = await Promise.all([
            this.projectRoots.resolveSessionPath(params.sessionId, params.path),
            this.projectRoots.resolveSessionPath(params.sessionId, params.directory),
        ]);
        return this.operations.run(() => this.mutations.copy(params), {
            group: `${COPY_OPERATION_GROUP}:${source.root}`,
            paths: [source.path, resolve(directory.path, basename(source.path))],
        });
    }

    async rename(
        params: Omit<RuntimeMethodParams<'files.rename'>, 'operationId'> & {
            operationId?: string;
        },
    ): Promise<RuntimeMethodResult<'files.rename'>> {
        const now = Date.now();
        return this.mutationJournal.run(
            {
                id: params.operationId ?? randomUUID(),
                kind: 'rename',
                sessionId: params.sessionId,
                phase: 'pre_stage',
                input: { name: params.name, path: params.path },
                startedAt: now,
                updatedAt: now,
            },
            async (stage) => {
                const { path: source } = await this.projectRoots.resolveSessionPath(
                    params.sessionId,
                    params.path,
                );
                return this.operations.run(() => this.mutations.rename(params, stage), {
                    paths: [source, resolve(dirname(source), params.name)],
                });
            },
        );
    }

    async move(
        params: Omit<RuntimeMethodParams<'files.move'>, 'operationId'> & {
            operationId?: string;
        },
    ): Promise<RuntimeMethodResult<'files.move'>> {
        const now = Date.now();
        return this.mutationJournal.run(
            {
                id: params.operationId ?? randomUUID(),
                kind: 'move',
                sessionId: params.sessionId,
                phase: 'pre_stage',
                input: {
                    conflict: params.conflict,
                    directory: params.directory,
                    path: params.path,
                },
                startedAt: now,
                updatedAt: now,
            },
            async (stage) => {
                const [source, directory] = await Promise.all([
                    this.projectRoots.resolveSessionPath(params.sessionId, params.path),
                    this.projectRoots.resolveSessionPath(params.sessionId, params.directory),
                ]);
                return this.operations.run(() => this.mutations.move(params, stage), {
                    paths: [source.path, resolve(directory.path, basename(source.path))],
                });
            },
        );
    }

    getMutationOperation(operationId: string) {
        return this.mutationJournal.get(operationId);
    }

    listMutationOperations() {
        return this.mutationJournal.list();
    }

    cancelMutationOperation(operationId: string) {
        return this.mutationJournal.cancel(operationId);
    }

    acknowledgeMutationOperation(operationId: string): Promise<void> {
        return this.mutationJournal.acknowledge(operationId);
    }

    async authorizeTrash(
        params: RuntimeMethodParams<'files.authorizeTrash'>,
    ): Promise<RuntimeMethodResult<'files.authorizeTrash'>> {
        const { path } = await this.projectRoots.resolveSessionPath(params.sessionId, params.path);
        return this.operations.run(() => this.mutations.authorizeTrash(params), { paths: [path] });
    }

    async authorizeOpen(
        params: RuntimeMethodParams<'files.authorizeOpen'>,
    ): Promise<RuntimeMethodResult<'files.authorizeOpen'>> {
        const { path } = await this.projectRoots.resolveSessionPath(params.sessionId, params.path);
        return this.operations.run(() => this.mutations.authorizeOpen(params), { paths: [path] });
    }

    async read(sessionId: string, path: string): Promise<FileDocument> {
        const operationPath = await this.projectRoots.resolveSessionPath(sessionId, path);
        return this.operations.run(() => this.documents.read(sessionId, path), {
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
        params: RuntimeMethodParams<'files.search'>,
    ): Promise<RuntimeMethodResult<'files.search'>> {
        return this.searcher.search(params);
    }

    watchSession(sessionId?: string): Promise<void> {
        return this.watcher.watchSession(sessionId);
    }

    async close(): Promise<void> {
        await Promise.all([this.watcher.close(), this.mutationJournal.close()]);
    }
}
