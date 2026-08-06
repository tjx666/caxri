import type { RuntimeEvent } from '../../shared/ipc/events';
import type { StructuredLogger } from '../../shared/node/logger';
import type { FileDocument, FileEntry } from '../../shared/types';
import type { CaxriDatabase } from '../db/repository';
import { ProjectRootResolver, type ResolvedSessionPath } from '../project-roots';
import { DocumentService, type OpenFile } from './documents';
import { ListingService } from './listing';
import { WatcherService, type WatcherServiceOptions } from './watcher';

export interface FileServiceOptions extends WatcherServiceOptions {
    openFile?: OpenFile;
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
        this.documents = new DocumentService(resolveSessionPath, logger, maxFileBytes, options);
        this.watcher = new WatcherService(resolveSessionPath, emit, logger, options);
        this.listing = new ListingService(resolveSessionPath, logger, (sessionId, path) =>
            this.watcher.noteDirectoryListed(sessionId, path),
        );
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

    read(sessionId: string, path: string): Promise<FileDocument> {
        return this.documents.read(sessionId, path);
    }

    write(sessionId: string, path: string, content: string): Promise<FileDocument> {
        return this.documents.write(sessionId, path, content);
    }

    watchSession(sessionId?: string): Promise<void> {
        return this.watcher.watchSession(sessionId);
    }

    close(): Promise<void> {
        return this.watcher.close();
    }
}
