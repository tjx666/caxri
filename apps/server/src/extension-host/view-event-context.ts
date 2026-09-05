import { AsyncLocalStorage } from 'node:async_hooks';

import type { ExtensionViewEventScope } from './protocol';

const viewEventContext = new AsyncLocalStorage<ExtensionViewEventScope>();

/**
 * Keeps provider events emitted while a Server notification or extension command is running tied to that request's
 * Workbench Root. Events without an active scope are deliberately dropped instead of becoming global UI broadcasts.
 */
export function withViewEventContext<Result>(
    context: ExtensionViewEventScope,
    callback: () => Result,
): Result {
    return viewEventContext.run(context, callback);
}

/**
 * The view event context Server Core supplied for the running request, or `undefined` when extension code runs outside
 * any host-supplied scope: `activate()`, a timer, or an event handler of the extension's own.
 */
export function currentViewEventContext(): ExtensionViewEventScope | undefined {
    return viewEventContext.getStore();
}
