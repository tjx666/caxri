import { errorMessage, isCaxriError } from '../shared/ipc/errors';
import { CAXRI_PROTOCOL_VERSION } from '../shared/ipc/version';
import type { StructuredLogger } from '../shared/node/logger';
import type { DesktopHostConnection } from './host-connection';

interface HostStartupDialog {
    showErrorBox(title: string, content: string): void;
}

export interface HostStartupOptions {
    dialog: HostStartupDialog;
    logger?: StructuredLogger;
    quit(): void;
    supervisor: Pick<DesktopHostConnection, 'start'>;
}

function isIncompatibleHost(error: unknown): boolean {
    if (!isCaxriError(error) || error.code !== 'CONFLICT') return false;
    return (
        error.details?.clientProtocolVersion === CAXRI_PROTOCOL_VERSION &&
        typeof error.details.hostProtocolVersion === 'number' &&
        error.details.hostProtocolVersion !== CAXRI_PROTOCOL_VERSION
    );
}

function incompatibleHostFailureMessage(): { content: string; title: string } {
    return {
        title: 'Caxri requires a local reset',
        content:
            'This pre-release build does not migrate unpublished Host protocols. Quit Caxri, preview the reset plan, then apply it:\n\n' +
            'bun run uninstall:caxri\n' +
            'bun run uninstall:caxri -- --yes\n\n' +
            'The reset removes Caxri application state and running Terminals, but never Project directories or user files.',
    };
}

/**
Starts one current-protocol Host attempt and preserves degraded startup for unrelated failures.
 */
export async function shouldContinueStartup(options: HostStartupOptions): Promise<boolean> {
    const startedAt = performance.now();
    try {
        await options.supervisor.start();
        options.logger?.write('info', 'host.attached', {
            durationMs: performance.now() - startedAt,
        });
        return true;
    } catch (error) {
        options.logger?.write('error', 'host.attach_failed', {
            durationMs: performance.now() - startedAt,
            fields: { error: errorMessage(error, 'unknown') },
        });
        if (!isIncompatibleHost(error)) return true;
        const failure = incompatibleHostFailureMessage();
        try {
            options.dialog.showErrorBox(failure.title, failure.content);
        } finally {
            options.quit();
        }
        return false;
    }
}
