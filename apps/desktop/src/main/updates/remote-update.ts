import type {
    DesktopOperation,
    RemoteUpdateBlockReason,
    RemoteUpdateInstallResult,
    UpdateState,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { UpdateService } from './updates';

type RemoteUpdateOperation = Extract<DesktopOperation, { kind: 'update' }>;
type RemoteUpdateService = Pick<
    UpdateService,
    'check' | 'download' | 'getState' | 'install' | 'isRestartReady'
>;

/**
 * Why a paired phone's restart into `version` cannot start now, or `undefined` when it can. A data-resetting update is
 * refused because only the computer offers the export before it clears the Project and Session list, and a `manual` one
 * because only the computer can open the DMG.
 */
export function remoteInstallBlock(
    service: RemoteUpdateService,
    version: string,
): RemoteUpdateBlockReason | undefined {
    const state = service.getState();
    if (state.status !== 'ready') return 'not-ready';
    if (state.version !== version) return 'version-changed';
    if (state.resetsData) return 'resets-data';
    if (!service.isRestartReady()) return 'manual-install';
    return undefined;
}

export interface RemoteUpdateControlOptions {
    /**
     * Unset until Main is ready; a phone that asks before then gets `UNAVAILABLE` and asks again.
     */
    service: () => RemoteUpdateService | undefined;
    /**
     * Saves what auto save can and resolves how many Editor buffers are still unsaved, without a prompt.
     */
    unsavedEditors: { countForRemoteUpdate(): Promise<number> };
    /**
     * Receives one `updates.remote_install` record per install request, with a closed `outcome` and `reason`.
     */
    logger: () => Pick<StructuredLogger, 'write'> | undefined;
    /**
     * Starts the restart only after the reply has been sent. The restart's quit flow asks Server Core for running work,
     * and an ordinary request issued while this Desktop command is still unanswered queues behind it and deadlocks both
     * sides until the Desktop command timeout fires.
     */
    schedule?: (run: () => void) => void;
}

/**
 * Answers the `update` Desktop operation a paired phone drives through Server Core. Every step answers at once: a check
 * or download continues in Main and the phone polls `read`, because a download outlives the Desktop command timeout.
 */
export function createRemoteUpdateControl(options: RemoteUpdateControlOptions) {
    const schedule = options.schedule ?? ((run: () => void) => setImmediate(run));
    const log = (outcome: RemoteUpdateInstallResult['outcome'], reason?: RemoteUpdateBlockReason) =>
        options
            .logger()
            ?.write(
                outcome === 'blocked' ? 'warn' : 'info',
                logEventCatalog.updates.remoteInstall,
                { fields: { outcome, ...(reason && { reason }) } },
            );
    return async (
        operation: RemoteUpdateOperation,
    ): Promise<RemoteUpdateInstallResult | UpdateState> => {
        const service = options.service();
        if (!service) throw new CaxriError('UNAVAILABLE', 'App updates are not ready yet');
        switch (operation.action) {
            case 'read':
                return service.getState();
            case 'check':
                // `check` publishes `checking` before it returns, so the state read below already shows it.
                void service.check({ manual: true }).catch(() => {});
                return service.getState();
            case 'download':
                // Like `check`, `download` publishes `downloading` before it returns.
                void service.download().catch(() => {});
                return service.getState();
            case 'install': {
                const { version } = operation;
                if (!version)
                    throw new CaxriError('VALIDATION', 'A remote install needs a version');
                const block = remoteInstallBlock(service, version);
                if (block) {
                    log('blocked', block);
                    return { outcome: 'blocked', reason: block };
                }
                const unsaved = await options.unsavedEditors.countForRemoteUpdate();
                if (unsaved > 0) {
                    log('blocked', 'unsaved-editors');
                    return {
                        outcome: 'blocked',
                        reason: 'unsaved-editors',
                        unsavedEditorCount: unsaved,
                    };
                }
                log('restarting');
                schedule(() => {
                    // The staged update can change before this runs; restart only into the version the phone confirmed.
                    if (!remoteInstallBlock(service, version))
                        void service.install({ remote: true });
                });
                return { outcome: 'restarting', version };
            }
        }
    };
}
