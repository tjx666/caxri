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

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { getSelectedSession } from '../../../stores/selectors';

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
    trash(
        path: string,
        options?: { hasUnsavedChanges?: boolean },
        signal?: AbortSignal,
    ): Promise<(MutableFileEntry & { undoToken?: string }) | { canceled: true }>;
    /**
     * Puts an item `trash` reported an `undoToken` for back at its original path; rejects with `CONFLICT` rather than
     * overwrite something that now occupies it.
     */
    restoreTrashed(undoToken: string, signal?: AbortSignal): Promise<MutableFileEntry>;
    /**
     * Drops a trashed path's editor tabs from the Workbench Root's durable snapshot, which is the only copy for the
     * Sessions parked on another root (issue #909).
     */
    forgetEditorPath(
        workbenchRootProjectId: string,
        path: string,
        signal?: AbortSignal,
    ): Promise<null>;
}

/**
 * Resolved per call rather than captured when the client is built. A captured id would make the client (and with it the
 * controlled-view context value carrying it) a new object on every Session switch, which re-renders every context
 * consumer including all 49 visible file-tree rows. The id is only a scope selector for Server, so reading the current
 * selection at request time is equivalent.
 */
function requireSessionId(): string {
    const sessionId = getSelectedSession()?.id;
    if (!sessionId)
        throw new CaxriError('UNAVAILABLE', translate('viewContainers.files.noSession'));
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
    | 'files.trash'
    | 'files.restoreTrashed'
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
export function createResourceExplorerClient(viewId: string): ResourceExplorerClient {
    return {
        viewId,
        acknowledgeOperation: (operationId, signal) =>
            request(
                'files.operation.acknowledge',
                { operationId, sessionId: requireSessionId() },
                signal,
            ),
        cancelOperation: (operationId, signal) =>
            request(
                'files.operation.cancel',
                { operationId, sessionId: requireSessionId() },
                signal,
            ),
        copy: (path, directory, signal) =>
            request('files.copy', { sessionId: requireSessionId(), path, directory }, signal),
        create: (options, signal) =>
            request('files.create', { sessionId: requireSessionId(), ...options }, signal),
        getOperation: (operationId, signal) =>
            request('files.operation.get', { operationId, sessionId: requireSessionId() }, signal),
        list: async (directory, signal) =>
            (
                await request(
                    'files.list',
                    {
                        sessionId: requireSessionId(),
                        ...(directory !== undefined && { directory }),
                    },
                    signal,
                )
            ).entries,
        listDirectory: (directory, signal) =>
            request(
                'files.list',
                {
                    sessionId: requireSessionId(),
                    ...(directory !== undefined && { directory }),
                },
                signal,
            ),
        listOperations: (signal) =>
            request('files.operation.list', { sessionId: requireSessionId() }, signal),
        move: (options, signal) =>
            request('files.move', { sessionId: requireSessionId(), ...options }, signal),
        rename: (options, signal) =>
            request('files.rename', { sessionId: requireSessionId(), ...options }, signal),
        forgetEditorPath: (workbenchRootProjectId, path, signal) =>
            request(
                'session.workbenchRoot.forgetEditorPath',
                { sessionId: requireSessionId(), workbenchRootProjectId, path },
                signal,
            ),
        restoreTrashed: (undoToken, signal) =>
            request('files.restoreTrashed', { sessionId: requireSessionId(), undoToken }, signal),
        trash: (path, options, signal) =>
            request('files.trash', { sessionId: requireSessionId(), path, ...options }, signal),
    };
}
