import { connectLegacyV1HostControl } from '@caxri/cli';
import type { MessageBoxOptions } from 'electron';

import { errorMessage } from '../shared/ipc/errors';
import type { StructuredLogger } from '../shared/node/logger';
import { legacyHostUpgradePrompt } from './confirmations';
import type { DesktopHostConnection } from './host-connection';
import { startHostWithLegacyV1Recovery } from './host-upgrade';

interface NativeHostUpgradeDialog {
    showErrorBox(title: string, content: string): void;
    showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>;
}

export interface NativeHostUpgradeStartupOptions {
    dialog: NativeHostUpgradeDialog;
    logger?: StructuredLogger;
    quit(): void;
    supervisor: DesktopHostConnection;
    userDataPath: string;
}

/** Wires Main's native upgrade prompt into the pure legacy Host startup orchestration. */
export async function startHostWithNativeLegacyV1Recovery(
    options: NativeHostUpgradeStartupOptions,
): Promise<boolean> {
    const startedAt = performance.now();
    return startHostWithLegacyV1Recovery({
        connectLegacyControl: () => connectLegacyV1HostControl(options.userDataPath),
        onAttached: (recoveredLegacyV1Host) =>
            options.logger?.write('info', 'host.attached', {
                durationMs: performance.now() - startedAt,
                ...(recoveredLegacyV1Host ? { fields: { recoveredLegacyV1Host: true } } : {}),
            }),
        onAttachFailed: (error) =>
            options.logger?.write('error', 'host.attach_failed', {
                durationMs: performance.now() - startedAt,
                fields: { error: errorMessage(error, 'unknown') },
            }),
        onUpgradeQuit: (reason) => {
            try {
                options.logger?.write('error', 'host.legacy_upgrade_failed', {
                    durationMs: performance.now() - startedAt,
                    fields: { reason },
                });
                if (reason === 'failed') {
                    try {
                        options.dialog.showErrorBox(
                            'Caxri Host upgrade failed',
                            'Caxri could not safely replace the incompatible Host. The Workbench will not open.',
                        );
                    } catch {
                        // The Workbench must remain closed even if native error reporting fails.
                    }
                }
            } finally {
                options.quit();
            }
        },
        prompt: async (activePtyCount) => {
            const result = await options.dialog.showMessageBox(
                legacyHostUpgradePrompt(activePtyCount),
            );
            return result.response === 1;
        },
        startHost: () => options.supervisor.start(),
    });
}
