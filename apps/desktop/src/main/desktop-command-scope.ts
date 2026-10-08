import { AsyncLocalStorage } from 'node:async_hooks';

import type { DesktopOperation } from '@caxri/protocol';

/**
 * The Desktop command whose handler the current async context is running inside, if any.
 *
 * Server Core dispatches a Desktop command and then waits for Main's reply, while every non-read-only request arriving
 * on that same connection queues behind the command still being serviced. A handler that issues an ordinary Server
 * request therefore waits on itself: neither side moves until the 15s Desktop command timeout fires, and the only thing
 * the operator sees is `Desktop command timed out`. `openInEditor` hit exactly that
 * (github.com/tjx666/caxri/issues/639) and was fixed by carrying its setting with the operation, but nothing stopped
 * the next handler from reintroducing it.
 *
 * An async-context scope rather than a plain in-flight flag, because the two look identical in wall-clock time and are
 * not remotely the same thing: a Renderer request that merely overlaps a Desktop command is ordinary workbench traffic
 * and must keep working. Only work that descends from the handler's own call is refused. The dedicated
 * `desktop-target.consume` lane is unaffected; it never travels through the request queue this guards.
 */
const activeCommand = new AsyncLocalStorage<DesktopOperation['kind']>();

/**
 * Runs one Desktop command handler with its callback guard armed.
 */
export function runDesktopCommand<Value>(
    operation: DesktopOperation,
    run: () => Promise<Value>,
): Promise<Value> {
    return activeCommand.run(operation.kind, run);
}

/**
 * The Desktop command the caller is servicing, or `undefined` when it is ordinary Main or Renderer-driven work.
 */
export function activeDesktopCommand(): DesktopOperation['kind'] | undefined {
    return activeCommand.getStore();
}
