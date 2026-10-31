import type { DesktopOperation, DesktopTargetPayload } from '@caxri/protocol';
import { assertNever } from '@caxri/protocol';

export interface DesktopOperationHandlers {
    confirmGitDiscard(target: {
        repositoryName: string;
        scope:
            { kind: 'all'; fileCount: number } | { kind: 'file'; path: string; untracked: boolean };
    }): Promise<boolean>;
    focus(): Promise<void>;
    open(target: DesktopTargetPayload & { sessionId: string }): void;
    openInEditor(path: string, editorCommand: string | undefined): Promise<void>;
    openWithDefaultApp(path: string): Promise<void>;
    reveal(path: string): void;
    status(): 'background' | 'window';
    /**
     * The app update a paired phone drives. Absent where this Desktop does not own the app update (an SSH Host window),
     * which answers `unsupported`.
     */
    update?(operation: Extract<DesktopOperation, { kind: 'update' }>): Promise<unknown>;
}

/**
 * Executes only the bounded native operation carried by an authenticated Server command.
 */
async function handleDesktopOperation(
    operation: DesktopOperation,
    consumeTarget: () => Promise<DesktopTargetPayload>,
    handlers: DesktopOperationHandlers,
): Promise<unknown> {
    switch (operation.kind) {
        case 'status':
            return { state: handlers.status() };
        case 'focus':
            await handlers.focus();
            return null;
        case 'reveal': {
            const target = await consumeTarget();
            handlers.reveal(target.path);
            return null;
        }
        case 'openWithDefaultApp': {
            const target = await consumeTarget();
            await handlers.openWithDefaultApp(target.path);
            return null;
        }
        case 'open': {
            const target = await consumeTarget();
            if (!target.sessionId) throw new Error('Opening a document requires a Session target');
            await handlers.focus();
            handlers.open({ ...target, sessionId: target.sessionId });
            return null;
        }
        case 'openInEditor': {
            const target = await consumeTarget();
            await handlers.openInEditor(target.path, operation.editorCommand);
            return null;
        }
        case 'confirmGitDiscard':
            return { confirmed: await handlers.confirmGitDiscard(operation.target) };
        case 'update':
            return handlers.update ? handlers.update(operation) : { unsupported: true };
        default:
            return assertNever(operation, 'Unhandled Desktop operation');
    }
}

export function createDesktopOperationHandler(handlers: DesktopOperationHandlers) {
    return (operation: DesktopOperation, consumeTarget: () => Promise<DesktopTargetPayload>) =>
        handleDesktopOperation(operation, consumeTarget, handlers);
}
