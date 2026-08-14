import type { DesktopOperation, DesktopTargetPayload } from '../shared/ipc/local-transport';

export interface DesktopOperationHandlers {
    focus(): Promise<void>;
    open(target: DesktopTargetPayload): void;
    reveal(path: string): void;
    status(): 'background' | 'window';
}

/** Executes only the bounded native operation carried by an authenticated Host command. */
async function handleDesktopOperation(
    operation: DesktopOperation,
    consumeTarget: () => Promise<DesktopTargetPayload>,
    handlers: DesktopOperationHandlers,
): Promise<unknown> {
    if (operation.kind === 'status') return { state: handlers.status() };
    if (operation.kind === 'focus') {
        await handlers.focus();
        return null;
    }
    const target = await consumeTarget();
    if (operation.kind === 'reveal') handlers.reveal(target.path);
    else {
        await handlers.focus();
        handlers.open(target);
    }
    return null;
}

export function createDesktopOperationHandler(handlers: DesktopOperationHandlers) {
    return (operation: DesktopOperation, consumeTarget: () => Promise<DesktopTargetPayload>) =>
        handleDesktopOperation(operation, consumeTarget, handlers);
}
