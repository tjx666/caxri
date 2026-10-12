import type { AgentActionRecentSettings } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';
import { canSendTerminalInput } from '../terminal/terminal-pane-handlers';
import type { AgentActionTerminalInputStep } from './agent-action-input';

/**
 * Input steps are intentionally serialized because the delay before a Codex skill's completion keys is part of the
 * provider contract. A failed step leaves the append-only draft visible and prevents the action from being recorded.
 */
export async function didSendAgentActionInputSteps(
    terminalId: string,
    steps: readonly AgentActionTerminalInputStep[],
): Promise<boolean> {
    for (const step of steps) {
        if (step.delayBeforeMs) {
            // eslint-disable-next-line no-await-in-loop -- the provider protocol requires ordered delays and writes
            await new Promise<void>((resolve) => setTimeout(resolve, step.delayBeforeMs));
        }
        if (!canSendTerminalInput(terminalId)) return false;
        // eslint-disable-next-line no-await-in-loop -- the next step must not overtake this PTY write
        const receipt = await tryCommand(translate('agentActions.sendFailed'), () =>
            caxri.request('terminal.input', { terminalId, data: step.data }),
        );
        if (receipt === undefined) return false;
    }
    return true;
}

/**
 * Promotes the invoked action in the provider's recents. Returns nothing when the write failed, so the picker keeps
 * showing the order the Server still holds instead of an optimistic one it never accepted.
 */
export async function recordRecentAgentAction(
    terminalId: string,
    invocation: string,
): Promise<AgentActionRecentSettings | undefined> {
    return tryCommand(translate('agentActions.saveRecentFailed'), () =>
        caxri.request('agentActions.recordRecent', { terminalId, invocation }),
    );
}
