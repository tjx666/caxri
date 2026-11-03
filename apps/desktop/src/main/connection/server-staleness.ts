import type { ServerClient } from '@caxri/client/supervise';
import type { MethodResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { DesktopServerConnectionOptions } from './server-attachment';

/**
 * Build identity of one side of the Desktop↔Server attachment. Fields are compared only when both sides report a real
 * value; `undefined` and the `'unknown'` build-time fallback mean "cannot tell", never "different".
 */
export interface ServerBuildIdentity {
    buildId?: string;
    commit?: string;
    version?: string;
}

function knownValue(value: string | undefined): string | undefined {
    return value && value !== 'unknown' ? value : undefined;
}

/**
 * Decides whether a discovered Server process was built from different code than the connecting Desktop and must be
 * replaced before serving requests. A detached Server survives Desktop restarts, so after a rebuild (dev) or an app
 * upgrade (packaged) the adopted Server can silently keep running an older build, exactly the failure this check
 * closes.
 *
 * The per-build `buildId` is authoritative when both sides carry one: it is the only identity that distinguishes two
 * dev builds of the same (possibly dirty) checkout, where version and commit are identical. Version/commit remain as
 * the fallback for Servers built before the buildId existed.
 */
export function isServerBuildStale(
    desktop: ServerBuildIdentity,
    server: ServerBuildIdentity,
): boolean {
    const desktopBuildId = knownValue(desktop.buildId);
    const serverBuildId = knownValue(server.buildId);
    if (desktopBuildId && serverBuildId) return desktopBuildId !== serverBuildId;
    const desktopVersion = knownValue(desktop.version);
    const serverVersion = knownValue(server.version);
    if (desktopVersion && serverVersion && desktopVersion !== serverVersion) return true;
    const desktopCommit = knownValue(desktop.commit);
    const serverCommit = knownValue(server.commit);
    return Boolean(desktopCommit && serverCommit && desktopCommit !== serverCommit);
}

interface ServerBuildVetting {
    confirm: DesktopServerConnectionOptions['confirmStaleReplacement'];
    desktop: ServerBuildIdentity;
    /**
     * This connection already replaced one stale Server, so another mismatch only warns.
     */
    hasReplaced: boolean;
    isFinalAttempt: boolean;
    logger: Pick<StructuredLogger, 'write'>;
    operator: ServerClient;
    status: MethodResult<'host.status'>;
}

/**
 * Decides whether the attached Server may serve this Desktop or must be stopped first. A stale Server is replaced at
 * most once per connection and never on a connect's final attempt, so a persistent mismatch (including two ping-ponging
 * Desktops of different builds) degrades to a logged warning instead of an endless kill/spawn loop. When the connection
 * has a `confirm` hook and the stale Server still runs work, the user decides; declining throws `CANCELLED` and leaves
 * that Server and its work running.
 */
export async function vetServerBuild(input: ServerBuildVetting): Promise<'replace' | 'serve'> {
    const { desktop, logger, status } = input;
    if (!isServerBuildStale(desktop, status)) return 'serve';
    const skewFields = {
        desktopBuildId: desktop.buildId ?? 'unknown',
        desktopCommit: desktop.commit ?? 'unknown',
        desktopVersion: desktop.version ?? 'unknown',
        hostBuildId: status.buildId ?? 'unknown',
        hostCommit: status.commit ?? 'unknown',
        serverPid: status.pid,
        hostVersion: status.version,
    };
    if (input.isFinalAttempt || input.hasReplaced) {
        logger.write('warn', logEventCatalog.serverConnection.versionMismatch, {
            fields: skewFields,
        });
        return 'serve';
    }
    if (!(await isReplacementConfirmed(input)))
        throw new CaxriError('CANCELLED', 'Server update deferred');
    /**
     * Live PTYs die with the stale Server, which is the intended trade once nobody objects: silently serving Terminals
     * from an older build is the failure mode this replaces. The count is kept so Main can tell the user.
     */
    logger.write('warn', logEventCatalog.serverConnection.staleBuildReplaced, {
        fields: { ...skewFields, stoppedTerminalCount: status.activePtyCount },
    });
    return 'replace';
}

/**
 * Asks the `confirm` hook whether a stale Server that still runs work may be stopped. Nothing running needs no
 * question. A Server too old to count its work by kind reports only its live PTYs.
 */
async function isReplacementConfirmed({
    confirm,
    logger,
    operator,
    status,
}: ServerBuildVetting): Promise<boolean> {
    if (!confirm) return true;
    let running: MethodResult<'terminal.runningCount'>;
    try {
        running = await operator.request('terminal.runningCount');
    } catch {
        running = { terminals: status.activePtyCount, chats: 0 };
    }
    if (running.terminals + running.chats === 0) return true;
    const isConfirmed = await confirm(running);
    logger.write('info', logEventCatalog.serverConnection.staleBuildConfirmed, {
        fields: {
            outcome: isConfirmed ? 'replace' : 'keep',
            runningTerminalCount: running.terminals,
            runningChatCount: running.chats,
        },
    });
    return isConfirmed;
}
