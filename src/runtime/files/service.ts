import type { RuntimeEvent } from '../../shared/ipc/events';
import type { RuntimeMethodParams, RuntimeMethodResult } from '../../shared/ipc/methods';
import type { StructuredLogger } from '../../shared/node/logger';
import type { AppSettings, FileDocument, FileEntry } from '../../shared/types';
import type { CaxriDatabase } from '../db/repository';
import { ProjectRootResolver, type ResolvedSessionPath } from '../project-roots';
import { DocumentService, type OpenFile } from './documents';
import { ListingService } from './listing';
import { FileMutationService, type FileMutationServiceOptions } from './mutations';
import { FileOperationQueue } from './operation-queue';
import { SearchService, type SearchServiceOptions } from './search';
import { WatcherService, type WatcherServiceOptions } from './watcher';

const MAXIMUM_DOCUMENT_QUEUE_WAIT_MS = 15_000;

export interface FileServiceOptions extends WatcherServiceOptions {
    fileTreeExcludes?: () => AppSettings['files.exclude'];
    maximumPendingOperations?: number;
    mutations?: FileMutationServiceOptions;
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

    create(
        params: RuntimeMethodParams<'files.create'>,
    ): Promise<RuntimeMethodResult<'files.create'>> {
        return this.operations.run(() => this.mutations.create(params));
    }

    copy(params: RuntimeMethodParams<'files.copy'>): Promise<RuntimeMethodResult<'files.copy'>> {
        return this.operations.run(() => this.mutations.copy(params));
    }

    rename(
        params: RuntimeMethodParams<'files.rename'>,
    ): Promise<RuntimeMethodResult<'files.rename'>> {
        return this.operations.run(() => this.mutations.rename(params));
    }

    move(params: RuntimeMethodParams<'files.move'>): Promise<RuntimeMethodResult<'files.move'>> {
        return this.operations.run(() => this.mutations.move(params));
    }

    authorizeTrash(
        params: RuntimeMethodParams<'files.authorizeTrash'>,
    ): Promise<RuntimeMethodResult<'files.authorizeTrash'>> {
        return this.operations.run(() => this.mutations.authorizeTrash(params));
    }

    authorizeOpen(
        params: RuntimeMethodParams<'files.authorizeOpen'>,
    ): Promise<RuntimeMethodResult<'files.authorizeOpen'>> {
        return this.operations.run(() => this.mutations.authorizeOpen(params));
    }

    read(sessionId: string, path: string): Promise<FileDocument> {
        return this.operations.run(() => this.documents.read(sessionId, path), {
            maximumWaitMs: MAXIMUM_DOCUMENT_QUEUE_WAIT_MS,
        });
    }

    write(sessionId: string, path: string, content: string): Promise<FileDocument> {
        return this.operations.run(() => this.documents.write(sessionId, path, content), {
            maximumWaitMs: MAXIMUM_DOCUMENT_QUEUE_WAIT_MS,
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
