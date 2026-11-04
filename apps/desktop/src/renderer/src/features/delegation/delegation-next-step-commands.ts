import type { AgentProvider } from '@caxri/protocol';

import { useDialogStore } from '../../stores/dialogs';
import { agentSignInCommand } from '../terminal/new-terminal-agent';

/**
 * The command that signs the delegated Agent in, or `undefined` when Caxri does not know how that Agent signs in (the
 * row then offers no "Sign in", exactly as the New Session menu shows none).
 */
export function delegationSignInCommand(provider: AgentProvider | undefined): string | undefined {
    return provider === undefined ? undefined : agentSignInCommand(provider, 'signInRequired');
}

/**
 * A failed delegation's "Enable hooks": opens Settings on the provider's lifecycle hooks row, the same toggle the
 * Terminal pane's hook suggestion writes.
 */
export function openDelegatedAgentHooksSettings(provider: AgentProvider): void {
    useDialogStore.getState().openSettings('agent-hooks', provider);
}
