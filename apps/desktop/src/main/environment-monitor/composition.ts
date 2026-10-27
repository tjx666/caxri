import type { StructuredLogger } from '@caxri/system';
import { net, powerMonitor, session } from 'electron';

import type { DesktopServerConnection } from '../server-connection';
import type { EnvironmentMonitor } from './monitor';
import { createEnvironmentMonitor } from './monitor';
import { createE2EEnvironmentMonitorProbe, createLiveEnvironmentMonitorProbe } from './probe';
import { environmentMonitorSignalsFromSettings } from './types';

interface DesktopEnvironmentMonitorOptions {
    e2eFixture?: string;
    isE2E: boolean;
    logger: () => StructuredLogger | undefined;
    supervisor: DesktopServerConnection;
}

/**
 * Binds the pure monitor to Desktop settings and Electron's network stack. Probe targets come only from the neutral
 * source catalog; Agent service domains never enter this composition boundary.
 */
export function createDesktopEnvironmentMonitor({
    e2eFixture,
    isE2E,
    logger,
    supervisor,
}: DesktopEnvironmentMonitorOptions): EnvironmentMonitor {
    const monitor = createEnvironmentMonitor({
        loadSignals: async () =>
            environmentMonitorSignalsFromSettings((await supervisor.request('settings.get')).value),
        logger,
        probe:
            e2eFixture && isE2E
                ? createE2EEnvironmentMonitorProbe(e2eFixture)
                : createLiveEnvironmentMonitorProbe({
                      fetch: (url, init) => net.fetch(url instanceof URL ? url.href : url, init),
                      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
                  }),
    });
    const onResume = (): void => monitor.settingsChanged();
    powerMonitor.on('resume', onResume);
    return {
        ...monitor,
        dispose() {
            powerMonitor.off('resume', onResume);
            monitor.dispose();
        },
    };
}
