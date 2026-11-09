import type {
    AgentDelegationCreate,
    AgentDelegationReceipt,
    DelegationSelection,
} from '@caxri/protocol';
import { CaxriError, isDelegationActive } from '@caxri/protocol';

import type { StoredAgentDelegation } from '../db';
import type { DelegationAuthority } from './admission';
import { delegationPaneCaller } from './admission';
import { delegationChildLaunch, dispatchLaunchFailure } from './chat-child';
import { prepareDelegationLaunch } from './launch';
import { assertDelegationLayout, delegationLayout } from './layout';
import type { ExactResumeHost } from './resume';
import { delegationTaskBody } from './task-body';

/**
 * Starts a newly admitted task in a fresh Agent Terminal: writes its private task file, records `launching`, and
 * dispatches the launch. Returns the receipt only when the task stopped being active before the launch, so the caller
 * reports that instead of re-reading it; a refused or failed launch settles the task through `host.fail`.
 */
export async function startFreshTask(
    host: ExactResumeHost,
    startingRecord: StoredAgentDelegation,
    authority: DelegationAuthority,
    input: AgentDelegationCreate,
    config: { selection: DelegationSelection; frozenLaunch: StoredAgentDelegation['frozenLaunch'] },
): Promise<AgentDelegationReceipt | undefined> {
    const id = startingRecord.receipt.delegationId;
    let record = startingRecord;
    const pane = delegationPaneCaller(host.options.database, authority, input);
    const prepared = await prepareDelegationLaunch(
        host.options.userDataPath,
        id,
        config.selection.provider,
        record.providerSessionId,
        delegationTaskBody(host.options.database, record),
        config.frozenLaunch,
    );
    record = host.owned(id);
    if (!isDelegationActive(record.receipt)) return record.receipt;
    record = host.save({
        ...record,
        promptDigest: prepared.promptDigest,
        receipt: { ...record.receipt, status: 'launching' },
    });
    const dispatched = await host.options.dispatch.start(
        id,
        authority.principal,
        {
            projectId: input.projectId,
            sessionId: input.sessionId,
            provider: config.selection.provider,
        },
        {
            delegationId: id,
            ...delegationChildLaunch(host.options, record, prepared),
            shouldStart: () => {
                const current = host.options.database.agentDelegations.get(id);
                return (
                    current !== undefined &&
                    isDelegationActive(current.receipt) &&
                    !host.isDeleting(input.sessionId)
                );
            },
            beforeCreate: () => {
                host.beforeStart?.();
                if (!isDelegationActive(host.owned(id).receipt))
                    throw new CaxriError('CANCELLED', 'Delegation was stopped before launch');
                assertDelegationLayout(
                    host.options.database.getSessionState(input.sessionId).paneLayout,
                    pane?.id,
                );
            },
            cwd: pane?.cwd,
            prepared: (terminal) => {
                record = host.owned(id);
                if (!isDelegationActive(record.receipt))
                    throw new CaxriError('CANCELLED', 'Delegation was stopped before launch');
                record = host.save({
                    ...record,
                    receipt: { ...record.receipt, terminalId: terminal.id },
                });
                const state = host.options.database.getSessionState(input.sessionId);
                host.options.database.updateSessionState({
                    ...state,
                    paneLayout: delegationLayout(
                        state.paneLayout,
                        terminal.id,
                        pane?.id,
                        pane && host.options.dimensions?.(pane.id),
                    ),
                });
            },
        },
    );
    if (dispatched.status === 'failed') host.fail(id, dispatchLaunchFailure(dispatched.failure));
    return undefined;
}
