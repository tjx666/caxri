import { isCaxriError } from '../shared/ipc/errors';
import { CAXRI_PROTOCOL_VERSION } from '../shared/ipc/version';

export interface LegacyV1HostControl {
    close: (this: void) => void;
    status: (this: void) => Promise<{ activePtyCount: number }>;
    stop: (this: void, confirmLivePtys: boolean) => Promise<void>;
    /** Waits for the Host identity used to establish this control connection to be released. */
    waitForRelease: (this: void) => Promise<void>;
}

export interface LegacyV1HostRecoveryDependencies {
    connectLegacyControl: (this: void) => Promise<LegacyV1HostControl>;
    /** Returning false includes cancellation, window close, and an explicit quit choice. */
    prompt: (this: void, activePtyCount: number) => Promise<boolean>;
}

export type LegacyV1HostRecoveryResult =
    | { outcome: 'not-applicable' }
    | { outcome: 'retry' }
    | { outcome: 'quit'; reason: 'cancelled' | 'failed' };

export interface HostUpgradeStartupDependencies extends LegacyV1HostRecoveryDependencies {
    onAttached: (this: void, recoveredLegacyV1Host: boolean) => void;
    onAttachFailed: (this: void, error: unknown) => void;
    onUpgradeQuit: (this: void, reason: 'cancelled' | 'failed') => void;
    startHost: (this: void) => Promise<void>;
}

/** Recognizes only the previous v1 Host rejected by the current v2 Desktop protocol. */
function isLegacyV1HostConflict(error: unknown): boolean {
    if (!isCaxriError(error) || error.code !== 'CONFLICT') return false;
    return (
        error.details?.clientProtocolVersion === CAXRI_PROTOCOL_VERSION &&
        error.details.hostProtocolVersion === 1
    );
}

/**
 * Replaces only a positively identified v1 Host after explicit user confirmation. The legacy
 * control connection binds its release wait to the identity observed before `host.stop`, so a
 * replacement Host can never satisfy the wait by itself.
 */
export async function recoverLegacyV1Host(
    error: unknown,
    dependencies: LegacyV1HostRecoveryDependencies,
): Promise<LegacyV1HostRecoveryResult> {
    if (!isLegacyV1HostConflict(error)) return { outcome: 'not-applicable' };

    let control: LegacyV1HostControl | undefined;
    let result: LegacyV1HostRecoveryResult;
    try {
        control = await dependencies.connectLegacyControl();
        const status = await control.status();
        if (!Number.isSafeInteger(status.activePtyCount) || status.activePtyCount < 0)
            throw new Error('Legacy Host returned an invalid active PTY count');
        if (!(await dependencies.prompt(status.activePtyCount))) {
            result = { outcome: 'quit', reason: 'cancelled' };
        } else {
            await control.stop(status.activePtyCount > 0);
            await control.waitForRelease();
            result = { outcome: 'retry' };
        }
    } catch (error) {
        /** The positively identified legacy Host can disappear before control connects or while
         * the confirmation is open. Re-run normal Host detection in that case; identity, schema,
         * and permission failures still stop startup rather than weakening the migration fence. */
        result =
            isCaxriError(error) && (error.code === 'NOT_FOUND' || error.code === 'UNAVAILABLE')
                ? { outcome: 'retry' }
                : { outcome: 'quit', reason: 'failed' };
    }

    try {
        control?.close();
    } catch {
        return { outcome: 'quit', reason: 'failed' };
    }
    return result;
}

/**
 * Starts the current Desktop attachment and retries once only after a confirmed, released legacy
 * v1 Host. Non-upgrade attachment errors preserve the existing degraded-Workbench behavior.
 */
export async function startHostWithLegacyV1Recovery(
    dependencies: HostUpgradeStartupDependencies,
): Promise<boolean> {
    try {
        await dependencies.startHost();
        dependencies.onAttached(false);
        return true;
    } catch (error) {
        const recovery = await recoverLegacyV1Host(error, dependencies);
        if (recovery.outcome === 'not-applicable') {
            dependencies.onAttachFailed(error);
            return true;
        }
        if (recovery.outcome === 'quit') {
            dependencies.onUpgradeQuit(recovery.reason);
            return false;
        }
        try {
            await dependencies.startHost();
            dependencies.onAttached(true);
        } catch (retryError) {
            dependencies.onAttachFailed(retryError);
        }
        return true;
    }
}
