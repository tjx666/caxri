import { AsyncLocalStorage } from 'node:async_hooks';

import type { DesktopOperation } from '@caxri/protocol';
import { CaxriError, isConcurrentRead } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

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
 * Runs fire-and-forget work outside any Desktop command scope. A handler that shows or focuses a window synchronously
 * emits that window's native events inside its own async context, so a follow-up report those events start would
 * otherwise be refused by `desktopCommandCallbackError` and silently dropped. Such work never blocks the handler, so it
 * cannot deadlock it; only use this for work the handler does not await.
 */
export function outsideDesktopCommand<Value>(run: () => Value): Value {
    return activeCommand.exit(run);
}

/**
 * The Desktop command the caller is servicing, or `undefined` when it is ordinary Main or Renderer-driven work.
 */
export function activeDesktopCommand(): DesktopOperation['kind'] | undefined {
    return activeCommand.getStore();
}

/**
 * Refuses an ordinary Server request issued from inside a Desktop command handler, where it can only deadlock (see
 * `activeDesktopCommand`). The connection's `forward` is deliberately not guarded: it carries a Renderer-originated
 * request that already owns a request id, so it is unreachable from a handler.
 *
 * A read is exempt because the deadlock is an ordering fact, not a re-entrancy one: Server Core settles a read outside
 * the connection's ordered admission lane (`isConcurrentRead`), so it never queues behind the command being serviced
 * and answers while that command is still open. Refusing reads too would break a path Main already depends on: the
 * `focus` and `open` commands reach `openMainWindow`, which reads `app.windowState.get` to restore the window's saved
 * geometry, and a refusal there silently substitutes the hardcoded default size and then persists it over the user's
 * own on the next close.
 */
export function desktopCommandCallbackError(
    method: string,
    logger: Pick<StructuredLogger, 'write'>,
): CaxriError | undefined {
    const command = activeDesktopCommand();
    if (command === undefined || isConcurrentRead(method)) return undefined;
    logger.write('error', logEventCatalog.serverConnection.desktopCommandCallbackRejected, {
        fields: {
            method,
            operation: command,
            /**
             * Closed set; today a handler can only be refused for this one cause, and a second cause gets its own
             * member rather than widening this one.
             */
            reason: 'ordinaryRequestFromDesktopCommand',
        },
    });
    return new CaxriError(
        'INTERNAL',
        `The ${command} Desktop command handler requested ${method} from Caxri Host. A Desktop command handler may only use its own target lane; an ordinary request queues behind the command it is servicing and deadlocks both sides.`,
    );
}
