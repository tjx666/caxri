import { isDelegationActive } from '@caxri/protocol';

import type { CaxriDatabase, StoredAgentDelegation } from '../db';
import { restoredDelegationFor } from './restored-task';

/**
 * Fences a Terminal's earlier tasks before a launch that belongs to none of them, PTY or Chat.
 *
 * Owner-initiated restart can retain the native session without PTY input. Persist the generation fence before that
 * launch so Server restart cannot make the earlier delegation eligible to resume again.
 *
 * Except a launch resuming the conversation of the Terminal's newest settled task (Session selection after a Caxri
 * restart, the user's own Restart and Resume, or a Chat starting again after idle suspension): the same conversation
 * with nothing new typed, so the task adopts it and stays `--resume`-able. Human input revokes that durably
 * (`hasHumanIntervention`), and a fresh restart clears the Terminal's native session first, so it never matches.
 */
export function fenceTerminalLaunch(
    host: {
        database: CaxriDatabase;
        inputEpoch(terminalId: string): number | undefined;
        save(record: StoredAgentDelegation): StoredAgentDelegation;
    },
    terminalId: string,
    launchId: string,
): void {
    const adopted = restoredDelegationFor(host.database, terminalId);
    if (adopted) host.save({ ...adopted, launchId, inputEpoch: host.inputEpoch(terminalId) });
    // Re-read: the adopted task now carries this launch, so the fence skips it.
    for (const task of host.database.agentDelegations.forTerminal(terminalId))
        if (task.launchId !== launchId && !task.hasLostTarget)
            host.save({
                ...task,
                hasLostTarget: true,
                receipt: isDelegationActive(task.receipt)
                    ? { ...task.receipt, status: 'interrupted', failure: 'target_changed' }
                    : task.receipt,
            });
}
