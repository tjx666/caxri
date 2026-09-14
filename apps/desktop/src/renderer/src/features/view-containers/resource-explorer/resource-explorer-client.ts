import type {
    CaxriMethod,
    FileEntry,
    FileMutationOperation,
    MethodResult,
    MovedFileEntry,
    MutableFileEntry,
    ParametersArgument,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { caxri } from '../../../lib/caxri';

type FileSearchResult = MethodResult<'files.search'>;
type FileDirectoryListing = MethodResult<'files.list'>;

export interface ResourceExplorerClient {
    readonly viewId: string;
    acknowledgeOperation(operationId: string, signal?: AbortSignal): Promise<null>;
    cancelOperation(operationId: string, signal?: AbortSignal): Promise<FileMutationOperation>;
    copy(path: string, directory: string, signal?: AbortSignal): Promise<MutableFileEntry>;
    create(
        options: {
            operationId: string;
            directory: string;
            name: string;
            kind: 'file' | 'directory';
        },
        signal?: AbortSignal,
    ): Promise<MutableFileEntry>;
    getOperation(operationId: string, signal?: AbortSignal): Promise<FileMutationOperation | null>;
    list(directory?: string, signal?: AbortSignal): Promise<FileEntry[]>;
    listDirectory(directory?: string, signal?: AbortSignal): Promise<FileDirectoryListing>;
    listOperations(signal?: AbortSignal): Promise<FileMutationOperation[]>;
    move(
        options: {
            operationId: string;
            path: string;
            directory: string;
            conflict?: 'reject' | 'rename' | 'replace';
        },
        signal?: AbortSignal,
    ): Promise<MovedFileEntry>;
    rename(
        options: { operationId: string; path: string; name: string },
        signal?: AbortSignal,
    ): Promise<MovedFileEntry>;
    search(
        options: {
            mode: 'name' | 'content';
            query: string;
            caseSensitive?: boolean;
            wholeWord?: boolean;
            regex?: boolean;
            include?: string;
            exclude?: string;
        },
        signal?: AbortSignal,
    ): Promise<FileSearchResult>;
    trash(
        path: string,
        options?: { hasUnsavedChanges?: boolean },
        signal?: AbortSignal,
    ): Promise<MutableFileEntry | { canceled: true }>;
    /**
     * Drops a trashed path's editor tabs from the Workbench Root's durable snapshot, which is the only copy for the
     * Sessions parked on another root (issue #909).
     */
    forgetEditorPath(workbenchProjectId: string, path: string, signal?: AbortSignal): Promise<null>;
}

function requireSessionId(sessionId: string | undefined): string {
    if (!sessionId) throw new CaxriError('UNAVAILABLE', 'No Session is selected');
    return sessionId;
}

type ResourceExplorerMethod = Extract<
    CaxriMethod,
    | 'files.operation.acknowledge'
    | 'files.operation.cancel'
    | 'files.operation.get'
    | 'files.operation.list'
    | 'files.copy'
    | 'files.create'
    | 'files.list'
    | 'files.move'
    | 'files.rename'
    | 'files.search'
    | 'files.trash'
    | 'session.workbenchRoot.forgetEditorPath'
>;

function request<M extends ResourceExplorerMethod>(
    method: M,
    parameters: ParametersArgument<M>[0],
    signal?: AbortSignal,
): Promise<MethodResult<M>> {
    const arguments_ = [parameters] as ParametersArgument<M>;
    return signal
        ? caxri.requestWithSignal(method, signal, ...arguments_)
        : caxri.request(method, ...arguments_);
}

/**
 * Files Core uses the public typed IPC table directly. The submitted Session id is only a scope selector: Server
 * resolves and validates that Session's authorized Workbench Project root before touching the filesystem.
 */
export function createResourceExplorerClient(
    viewId: string,
    sessionId?: string,
): ResourceExplorerClient {
    return {
        viewId,
        acknowledgeOperation: (operationId, signal) =>
            request(
                'files.operation.acknowledge',
                { operationId, sessionId: requireSessionId(sessionId) },
                signal,
            ),
        cancelOperation: (operationId, signal) =>
            request(
                'files.operation.cancel',
                { operationId, sessionId: requireSessionId(sessionId) },
                signal,
            ),
        copy: (path, directory, signal) =>
            request(
                'files.copy',
                { sessionId: requireSessionId(sessionId), path, directory },
                signal,
            ),
        create: (options, signal) =>
            request('files.create', { sessionId: requireSessionId(sessionId), ...options }, signal),
        getOperation: (operationId, signal) =>
            request(
                'files.operation.get',
                { operationId, sessionId: requireSessionId(sessionId) },
                signal,
            ),
        list: async (directory, signal) =>
            (
                await request(
                    'files.list',
                    {
                        sessionId: requireSessionId(sessionId),
                        ...(directory !== undefined && { directory }),
                    },
                    signal,
                )
            ).entries,
        listDirectory: (directory, signal) =>
            request(
                'files.list',
                {
                    sessionId: requireSessionId(sessionId),
                    ...(directory !== undefined && { directory }),
                },
                signal,
            ),
        listOperations: (signal) =>
            request('files.operation.list', { sessionId: requireSessionId(sessionId) }, signal),
        move: (options, signal) =>
            request('files.move', { sessionId: requireSessionId(sessionId), ...options }, signal),
        rename: (options, signal) =>
            request('files.rename', { sessionId: requireSessionId(sessionId), ...options }, signal),
        search: (options, signal) =>
            request('files.search', { sessionId: requireSessionId(sessionId), ...options }, signal),
        forgetEditorPath: (workbenchProjectId, path, signal) =>
            request(
                'session.workbenchRoot.forgetEditorPath',
                { sessionId: requireSessionId(sessionId), workbenchProjectId, path },
                signal,
            ),
        trash: (path, options, signal) =>
            request(
                'files.trash',
                { sessionId: requireSessionId(sessionId), path, ...options },
                signal,
            ),
    };
}
