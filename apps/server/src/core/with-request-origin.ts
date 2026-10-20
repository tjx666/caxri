import type { CommandAdapter } from '@caxri/protocol';

import { runWithRequestOrigin } from '../domains/window-presence';

/**
 * Scopes each request to its connection so handlers that must tell connections apart (per-window presence) can read it
 * without the domain layer growing a connection parameter on every method.
 */
export function withRequestOrigin(adapter: CommandAdapter): CommandAdapter {
    return {
        invoke: (request, context, invocation) =>
            runWithRequestOrigin(context.connection?.connectionId, () =>
                adapter.invoke(request, context, invocation),
            ),
    };
}
