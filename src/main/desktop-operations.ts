import { assertNever } from '../shared/ipc';
import type { DesktopOperation, DesktopTargetPayload } from '../shared/ipc/local-transport';

export interface DesktopOperationHandlers {
    confirmFilesTrash(item: {
        name: string;
        path: string;
        hasUnsavedChanges?: boolean;
    }): Promise<boolean>;
    confirmGitDiscard(target: {
        repositoryName: string;
        scope:
            { kind: 'all'; fileCount: number } | { kind: 'file'; path: string; untracked: boolean };
    }): Promise<boolean>;
    focus(): Promise<void>;
    open(target: DesktopTargetPayload): void;
    openInEditor(path: string): Promise<void>;
    reveal(path: string): void;
    status(): 'background' | 'window';
    trash(path: string): Promise<void>;
}

/**
 * Executes only the bounded native operation carried by an authenticated Host command.
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
        case 'open': {
            const target = await consumeTarget();
            await handlers.focus();
            handlers.open(target);
            return null;
        }
        case 'openInEditor': {
            const target = await consumeTarget();
            await handlers.openInEditor(target.path);
            return null;
        }
        case 'confirmFilesTrash':
            return { confirmed: await handlers.confirmFilesTrash(operation.item) };
        case 'trash': {
            const target = await consumeTarget();
            await handlers.trash(target.path);
            return null;
        }
        case 'confirmGitDiscard':
            return { confirmed: await handlers.confirmGitDiscard(operation.target) };
        default:
            return assertNever(operation, 'Unhandled Desktop operation');
    }
}

export function createDesktopOperationHandler(handlers: DesktopOperationHandlers) {
    return (operation: DesktopOperation, consumeTarget: () => Promise<DesktopTargetPayload>) =>
        handleDesktopOperation(operation, consumeTarget, handlers);
}
