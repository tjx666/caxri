import type { TerminalKind } from '@caxri/protocol';
import { terminalKindSchema } from '@caxri/protocol';

import { createSharedLocalState } from '../../lib/local-storage';
import { createStore } from '../../lib/store';

const LAST_AGENT_CHOICE_STORAGE_KEY = 'caxri.session.lastAgentChoice';

/**
 * The Terminal kind the user last picked from a New Session list, remembered on this device so a press on the Project
 * heading's New Session button can repeat it without reopening the list. Presentation state only: unlike
 * `session.defaultAgent` it is never written to `settings.jsonc`, and a configured default Agent always wins over it.
 */
export interface LastAgentChoice {
    kind: TerminalKind | undefined;
}

/**
 * A stored kind Caxri no longer ships, or a corrupt entry, reads as no choice so the button falls back to the list.
 */
export function parseLastAgentChoice(stored: unknown): LastAgentChoice {
    const parsed = terminalKindSchema.safeParse(stored);
    return { kind: parsed.success ? parsed.data : undefined };
}

/**
 * The Agent row of the heading's list that a press of the split button repeats and that is not already marked
 * `Default`: the remembered pick when no default Agent is configured. A configured default wins over the remembered
 * pick and carries the `Default` marker, so it never also reads "Last used".
 */
export function isLastUsedAgentRow(
    kind: TerminalKind,
    { isDefault, repeatedKind }: { isDefault: boolean; repeatedKind: TerminalKind | undefined },
): boolean {
    return !isDefault && repeatedKind !== undefined && kind === repeatedKind;
}

/**
 * Shared by every window of the profile (docs/client-local-data.md): the last pick follows the user, not a window.
 */
const sharedChoice = createSharedLocalState(LAST_AGENT_CHOICE_STORAGE_KEY, parseLastAgentChoice);

export const useLastAgentChoiceStore = createStore<LastAgentChoice>('last-agent-choice', (set) => {
    // Lives as long as the store. It updates memory only, so another window's change never writes back.
    sharedChoice.subscribe((choice) => set(choice));
    return sharedChoice.read();
});

/**
 * Records an explicit pick. `null` (an Empty Session) is not recorded: it is the escape hatch, not a Terminal the
 * button could start next time.
 */
export function rememberLastAgentChoice(kind: TerminalKind | null): void {
    if (kind === null || useLastAgentChoiceStore.getState().kind === kind) return;
    useLastAgentChoiceStore.setState({ kind });
    sharedChoice.write(kind);
}
