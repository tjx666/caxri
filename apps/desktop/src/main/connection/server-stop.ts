import type { ServerOperation } from '@caxri/protocol';

import type { DesktopServerSupervisor } from './server-attachment';
import { waitForServerExit } from './server-attachment';

/**
 * The two untyped requests the stop sequence sends; the attachment is already fenced from recovery, so neither may
 * start a reconnect.
 */
export interface StoppingServerClient {
    request(method: 'host.stop', parameters: { confirmLivePtys: true }): Promise<unknown>;
    requestServerOperation(
        method: ServerOperation,
        parameters?: unknown,
        timeoutMs?: number,
    ): Promise<unknown>;
}

/**
 * Ends every live Terminal, then stops Server Core and waits for its process. Both steps always run: a failed
 * termination must not keep Server alive, and each failure is reported (both together as an `AggregateError`).
 */
export async function stopAttachedServer(
    client: StoppingServerClient,
    supervisor: DesktopServerSupervisor,
    pid: number | undefined,
): Promise<void> {
    let didTerminationFail = false;
    let terminationFailure: unknown;
    let didHostStopFail = false;
    let hostStopFailure: unknown;
    try {
        await client.requestServerOperation('terminal.terminateAll', undefined, undefined);
    } catch (error) {
        didTerminationFail = true;
        terminationFailure = error;
    }
    try {
        await client.request('host.stop', { confirmLivePtys: true });
        if (pid !== undefined) {
            supervisor.releaseProcess(pid);
            await waitForServerExit(supervisor, pid);
        }
    } catch (error) {
        didHostStopFail = true;
        hostStopFailure = error;
    }
    if (didTerminationFail && didHostStopFail)
        throw new AggregateError(
            [terminationFailure, hostStopFailure],
            'Could not terminate tasks or stop Caxri Server',
        );
    if (didHostStopFail) throw hostStopFailure;
    if (didTerminationFail) throw terminationFailure;
}
