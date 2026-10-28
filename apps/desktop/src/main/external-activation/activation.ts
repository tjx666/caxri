import type { ServerEvent } from '@caxri/protocol';
import { errorMessage, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { App } from 'electron';

import { installSecondInstanceFocus } from '../desktop-profile';
import { consumeOpenFileRequests } from './open-file-requests';
import { installShareInbox } from './share-inbox';

export interface ExternalActivationOptions {
    app: App;
    focusMainWindow: () => Promise<unknown>;
    logger: () => StructuredLogger | undefined;
    profileId: string;
    sendEvent: (event: ServerEvent) => void;
}

/**
 * Requests from outside Caxri to bring its Workbench forward: a second launch of the same profile, and a document macOS
 * asks Caxri to open, which is how the bundled share extension hands over what the Share menu gave it
 * (`share-inbox.ts`). Both are held until `ready()`, once the primary window's Renderer can receive them.
 */
export function installExternalActivation(options: ExternalActivationOptions): { ready(): void } {
    const { app, focusMainWindow, logger } = options;
    const secondInstanceFocus = installSecondInstanceFocus(
        app,
        async () => {
            await focusMainWindow();
            logger()?.write('info', logEventCatalog.app.secondInstanceFocused, {
                fields: { profileId: options.profileId },
            });
        },
        (error) =>
            logger()?.write('error', logEventCatalog.app.secondInstanceFocusFailed, {
                fields: { error: errorMessage(error, 'unknown') },
            }),
    );
    let isReady = false;
    return {
        ready: () => {
            secondInstanceFocus.ready();
            const readyLogger = logger();
            if (isReady || !readyLogger) return;
            isReady = true;
            installShareInbox({
                homeDirectory: app.getPath('home'),
                isPackaged: app.isPackaged,
                logger: readyLogger,
                onOpenFile: consumeOpenFileRequests,
                deliver: async (payload) => {
                    await focusMainWindow();
                    options.sendEvent({ event: 'desktop.shareReceived', payload });
                },
            });
        },
    };
}
