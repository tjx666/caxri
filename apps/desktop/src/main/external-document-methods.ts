import type { MainRequest, ServerEvent } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { shell } from 'electron';

import {
    openLinkedExternalDocument,
    readExternalDocument,
    readExternalDocumentAsset,
} from './external-document-reads';
import type { ExternalDocumentWatcher } from './external-document-watcher';
import { createExternalDocumentWatcher } from './external-document-watcher';
import {
    externalDocumentDirectory,
    externalDocumentPath,
    writeExternalDocument,
} from './external-documents';
import type { DesktopServerConnection } from './server-connection';

type ExternalDocumentRequest = Extract<MainRequest, { method: `externalDocument.${string}` }>;

export function isExternalDocumentRequest(
    request: MainRequest,
): request is ExternalDocumentRequest {
    return request.method.startsWith('externalDocument.');
}

/**
 * The watcher behind `externalDocument.watch`, reporting changes through `sendEvent`. Without a sender (a unit-test
 * handler) watch requests are accepted and ignored.
 */
export function createExternalDocumentChangeWatcher(
    sendEvent: ((event: ServerEvent) => void) | undefined,
): Pick<ExternalDocumentWatcher, 'setWatched'> {
    if (!sendEvent) return { setWatched: () => {} };
    return createExternalDocumentWatcher({
        emit: (documentId) =>
            sendEvent({ event: 'externalDocument.changed', payload: { documentId } }),
    });
}

/**
 * Main's half of every `externalDocument.*` method. `openInTerminal` crosses into Server Core through the Main-only
 * `terminal.createInExternalDirectory`, carrying the folder Main resolved from the ID.
 */
export async function handleExternalDocumentRequest(
    request: ExternalDocumentRequest,
    server: Pick<DesktopServerConnection, 'request'>,
    watcher: Pick<ExternalDocumentWatcher, 'setWatched'>,
): Promise<unknown> {
    switch (request.method) {
        case 'externalDocument.write':
            return writeExternalDocument(request.params.documentId, request.params.content);
        case 'externalDocument.read':
            return readExternalDocument(request.params.documentId);
        case 'externalDocument.watch':
            watcher.setWatched(request.params.documentIds);
            return null;
        case 'externalDocument.readAsset':
            return readExternalDocumentAsset(request.params.documentId, request.params.path);
        case 'externalDocument.openLinked':
            return openLinkedExternalDocument(request.params.documentId, request.params.path);
        case 'externalDocument.reveal':
            shell.showItemInFolder(await externalDocumentPath(request.params.documentId));
            return null;
        case 'externalDocument.openWithDefaultApp': {
            // `shell.openPath` resolves with an error message instead of rejecting; see `createDesktopActions`.
            const failure = await shell.openPath(
                await externalDocumentPath(request.params.documentId),
            );
            if (failure) throw new CaxriError('IO', failure);
            return null;
        }
        case 'externalDocument.openInTerminal':
            return server.request('terminal.createInExternalDirectory', {
                sessionId: request.params.sessionId,
                cwd: await externalDocumentDirectory(request.params.documentId),
            });
    }
}
