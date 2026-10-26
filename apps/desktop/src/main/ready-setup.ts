import process from 'node:process';

import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { app } from 'electron';

import { shouldEnableAcceptanceAccessibility } from './acceptance-accessibility';
import { resolveDevelopmentDockIconPath } from './app-icon';
import type { DesktopProfile } from './desktop-profile';
import { setMainLanguage } from './locale';

/**
 * Applies the process-level appearance and accessibility setup that must run as soon as Electron is ready, before the
 * first window exists.
 */
export function applyReadyAppearance(currentDirectory: string): void {
    setMainLanguage(null, [app.getLocale()]); // Dialogs shown before the first menu read follow the system.
    if (
        shouldEnableAcceptanceAccessibility({
            environment: process.env,
            platform: process.platform,
        })
    )
        app.setAccessibilitySupportEnabled(true);
    const developmentDockIconPath = resolveDevelopmentDockIconPath({
        currentDirectory,
        isPackaged: app.isPackaged,
    });
    if (developmentDockIconPath && app.dock) app.dock.setIcon(developmentDockIconPath);
}

/**
 * Records that Electron is ready, with how long boot took and which profile and debugging transport this instance runs.
 */
export function logAppReady(
    logger: StructuredLogger,
    options: {
        bootStartedAt: number;
        profile: DesktopProfile;
    },
): void {
    const { profile } = options;
    logger.write('info', logEventCatalog.app.ready, {
        durationMs: performance.now() - options.bootStartedAt,
        fields: {
            profileId: profile.id,
            profileKind: profile.kind,
            remoteDebuggingPort:
                profile.remoteDebugging.transport === 'port' ? profile.remoteDebugging.port : null,
            remoteDebuggingTransport: profile.remoteDebugging.transport,
        },
    });
}
