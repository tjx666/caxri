import type { PowerMonitor } from 'electron';

import type { DesktopServerConnection } from './server-connection';

/**
 * Wires the two `powerMonitor` events Main's bootstrap needs at startup. `shutdown` marks the pending quit as an OS
 * shutdown rather than a user action; `resume`/`unlock-screen` force an immediate lease renewal (see
 * `DesktopServerConnection.renewLeaseNow`) instead of waiting on the connection's background renew interval.
 */
export function wirePowerWake(
    powerMonitor: Pick<PowerMonitor, 'on'>,
    onShutdown: () => void,
    connection: Pick<DesktopServerConnection, 'renewLeaseNow'>,
): void {
    powerMonitor.on('shutdown', onShutdown);
    powerMonitor.on('resume', () => connection.renewLeaseNow());
    powerMonitor.on('unlock-screen', () => connection.renewLeaseNow());
}
