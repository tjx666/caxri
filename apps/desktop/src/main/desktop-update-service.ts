import { join } from 'node:path';
import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { app, shell } from 'electron';

import { createAcceptanceUpdateFixture } from './acceptance-update';
import { UpdateService, updateStateLogFields } from './updates';

/**
 * Builds the app's update service: enabled only when packaged, downloading into the profile, logging every state but
 * download progress, and publishing each state to the Workbench as `updates.state`.
 */
export function createDesktopUpdateService(options: {
    currentVersion: string;
    logger: () => StructuredLogger | undefined;
    sendEvent: (event: ServerEvent) => void;
    userDataPath: string;
}): UpdateService {
    const { userDataPath } = options;
    return new UpdateService({
        acceptanceDiscovery: createAcceptanceUpdateFixture({
            environment: process.env,
            isPackaged: app.isPackaged,
            userDataPath,
        }),
        currentVersion: options.currentVersion,
        downloadDirectory: join(userDataPath, 'updates'),
        enabled: app.isPackaged,
        openPath: (path) => shell.openPath(path),
        onState: (state) => {
            if (state.status !== 'downloading')
                options
                    .logger()
                    ?.write(
                        state.status === 'error' ? 'error' : 'info',
                        logEventCatalog.updates.state,
                        { fields: updateStateLogFields(state) },
                    );
            options.sendEvent({ event: 'updates.state', payload: state });
        },
    });
}
