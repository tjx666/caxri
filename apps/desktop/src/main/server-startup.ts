import { CAXRI_PROTOCOL_VERSION, errorMessage, isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { translateMain } from './locale';
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
        title: translateMain('desktop.reset.title'),
        content:
            `${translateMain('desktop.reset.intro')}\n\n` +
            `bun run uninstall:caxri\nbun run uninstall:caxri -- --yes\n\n${translateMain('desktop.reset.outro')}`,
    };
}

/**
 * Starts one current-protocol Server attempt and preserves degraded startup for unrelated failures.
 */
export async function shouldContinueStartup(options: ServerStartupOptions): Promise<boolean> {
    const startedAt = performance.now();
    try {
        await options.supervisor.start();
        options.logger?.write('info', logEventCatalog.serverConnection.attached, {
            durationMs: performance.now() - startedAt,
        });
        return true;
    } catch (error) {
        options.logger?.write('error', logEventCatalog.serverConnection.attachFailed, {
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
