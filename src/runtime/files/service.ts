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
import { FileOperationQueue } from './operation-queue';
import { SearchService, type SearchServiceOptions } from './search';
import { WatcherService, type WatcherServiceOptions } from './watcher';

const MAXIMUM_DOCUMENT_QUEUE_WAIT_MS = 15_000;
const COPY_OPERATION_GROUP = 'files.copy';

export interface FileServiceOptions extends WatcherServiceOptions {
    fileTreeExcludes?: () => AppSettings['files.exclude'];
    maximumPendingOperations?: number;
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
        params: RuntimeMethodParams<'files.create'>,
    ): Promise<RuntimeMethodResult<'files.create'>> {
        const { path: directory } = await this.projectRoots.resolveSessionPath(
            params.sessionId,
            params.directory,
        );
        return this.operations.run(() => this.mutations.create(params), {
            paths: [resolve(directory, params.name)],
        });
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
        params: RuntimeMethodParams<'files.rename'>,
    ): Promise<RuntimeMethodResult<'files.rename'>> {
        const { path: source } = await this.projectRoots.resolveSessionPath(
            params.sessionId,
            params.path,
        );
        return this.operations.run(() => this.mutations.rename(params), {
            paths: [source, resolve(dirname(source), params.name)],
        });
    }

    async move(
        params: RuntimeMethodParams<'files.move'>,
    ): Promise<RuntimeMethodResult<'files.move'>> {
        const [source, directory] = await Promise.all([
            this.projectRoots.resolveSessionPath(params.sessionId, params.path),
            this.projectRoots.resolveSessionPath(params.sessionId, params.directory),
        ]);
        return this.operations.run(() => this.mutations.move(params), {
            paths: [source.path, resolve(directory.path, basename(source.path))],
        });
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

    close(): Promise<void> {
        return this.watcher.close();
    }
}
