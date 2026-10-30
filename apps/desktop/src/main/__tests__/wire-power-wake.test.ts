import type { PowerMonitor } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { DesktopServerConnection } from '../connection/server-connection';
import { wirePowerWake } from '../power-wake';

type FakePowerMonitor = Pick<PowerMonitor, 'on'> & {
    emit(event: 'resume' | 'shutdown' | 'unlock-screen'): void;
};

/**
 * A macOS sleep suspends this process's event loop along with Server Core's, so every timer in both processes freezes
 * and fires late (in arrival order) on wake; see `DESKTOP_LEASE_GRACE_MS` in
 * `apps/server/src/core/control-server-support.ts`. `wirePowerWake` is Main's half of closing that race, so these tests
 * stand in for `powerMonitor` and the Desktop connection rather than exercising a real Electron process.
 */
function createFakePowerMonitor(): FakePowerMonitor {
    const listeners = new Map<string, Array<(...arguments_: never[]) => void>>();
    const fake: FakePowerMonitor = {
        emit(event) {
            const eventListeners = listeners.get(event) ?? [];
            for (const listener of eventListeners) listener();
        },
        on(event: string, listener: (...arguments_: never[]) => void) {
            listeners.set(event, [...(listeners.get(event) ?? []), listener]);
            return fake as unknown as PowerMonitor;
        },
    };
    return fake;
}

describe('wirePowerWake', () => {
    it('marks the quit as a system shutdown on the shutdown event', () => {
        const powerMonitor = createFakePowerMonitor();
        const onShutdown = vi.fn();
        wirePowerWake(powerMonitor, onShutdown, { renewLeaseNow: vi.fn() });

        powerMonitor.emit('shutdown');

        expect(onShutdown).toHaveBeenCalledTimes(1);
    });

    it.each(['resume', 'unlock-screen'] as const)(
        'forces an immediate lease renewal on %s',
        (event) => {
            const powerMonitor = createFakePowerMonitor();
            const connection: Pick<DesktopServerConnection, 'renewLeaseNow'> = {
                renewLeaseNow: vi.fn(),
            };
            wirePowerWake(powerMonitor, vi.fn(), connection);

            powerMonitor.emit(event);

            expect(connection.renewLeaseNow).toHaveBeenCalledTimes(1);
        },
    );
});
