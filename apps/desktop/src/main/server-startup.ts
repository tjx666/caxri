import { CAXRI_PROTOCOL_VERSION, errorMessage, isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { DesktopServerConnection } from './server-connection';

interface ServerStartupDialog {
    showErrorBox(title: string, content: string): void;
}

export interface ServerStartupOptions {
    dialog: ServerStartupDialog;
    logger?: StructuredLogger;
    quit(): void;
    supervisor: Pick<DesktopServerConnection, 'start'>;
}

function isIncompatibleServer(error: unknown): boolean {
    if (!isCaxriError(error) || error.code !== 'CONFLICT') return false;
    return (
        error.details?.clientProtocolVersion === CAXRI_PROTOCOL_VERSION &&
        typeof error.details.hostProtocolVersion === 'number' &&
        error.details.hostProtocolVersion !== CAXRI_PROTOCOL_VERSION
    );
}

function incompatibleServerFailureMessage(): { content: string; title: string } {
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
 * Starts one current-protocol Server attempt and preserves degraded startup for unrelated failures.
 */
export async function shouldContinueStartup(options: ServerStartupOptions): Promise<boolean> {
    const startedAt = performance.now();
    try {
        await options.supervisor.start();
        options.logger?.write('info', logEventCatalog.host.attached, {
            durationMs: performance.now() - startedAt,
        });
        return true;
    } catch (error) {
        options.logger?.write('error', logEventCatalog.host.attachFailed, {
            durationMs: performance.now() - startedAt,
            fields: { error: errorMessage(error, 'unknown') },
        });
        if (!isIncompatibleServer(error)) return true;
        const failure = incompatibleServerFailureMessage();
        try {
            options.dialog.showErrorBox(failure.title, failure.content);
        } finally {
            options.quit();
        }
        return false;
    }
}
