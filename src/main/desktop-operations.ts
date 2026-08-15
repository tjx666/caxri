import { assertNever } from '../shared/ipc';
import type { DesktopOperation, DesktopTargetPayload } from '../shared/ipc/local-transport';

export interface DesktopOperationHandlers {
    focus(): Promise<void>;
    open(target: DesktopTargetPayload): void;
    reveal(path: string): void;
    status(): 'background' | 'window';
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
        default:
            return assertNever(operation, 'Unhandled Desktop operation');
    }
}

export function createDesktopOperationHandler(handlers: DesktopOperationHandlers) {
    return (operation: DesktopOperation, consumeTarget: () => Promise<DesktopTargetPayload>) =>
        handleDesktopOperation(operation, consumeTarget, handlers);
}
