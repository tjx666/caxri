import type { TerminalKind } from '@caxri/protocol';
import { terminalKindSchema } from '@caxri/protocol';

import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
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

export const useLastAgentChoiceStore = createStore<LastAgentChoice>('last-agent-choice', () =>
    parseLastAgentChoice(readLocalStorageJson(LAST_AGENT_CHOICE_STORAGE_KEY)),
);

/**
 * Records an explicit pick. `null` (an Empty Session) is not recorded: it is the escape hatch, not a Terminal the
 * button could start next time.
 */
export function rememberLastAgentChoice(kind: TerminalKind | null): void {
    if (kind === null || useLastAgentChoiceStore.getState().kind === kind) return;
    useLastAgentChoiceStore.setState({ kind });
    writeLocalStorageJson(LAST_AGENT_CHOICE_STORAGE_KEY, kind);
}
