import type { AgentChatContinuationTarget, AgentProvider } from '@caxri/protocol';
import { sessionRenameTitleSchema } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { resetText } from '../agent-chat/agent-chat-plan-limits';
import { mobileErrorMessage } from '../connection/mobile-error-message';
import type { MobileTerminal } from './session-model';

/**
 * Validates a rename draft with the Server's own schema, so the Save button disables exactly when the Server would
 * reject the title. Returns the trimmed title to send, or null when the draft is invalid or unchanged.
 */
export const sessionRenameDraft = (draft: string, currentTitle: string): string | null => {
    const parsed = sessionRenameTitleSchema.safeParse(draft);
    if (!parsed.success || parsed.data === currentTitle) return null;
    return parsed.data;
};

export const sessionManagementErrorMessage = (error: unknown, fallback: string): string =>
    mobileErrorMessage(error, fallback);

/**
 * Why Fork Session and Continue in Another Agent cannot act on a Session, as Desktop's `sessionForkBlocker` decides:
 * both copy the primary Agent's Chat conversation. The phone does not learn the Agent's conversation id, so a Chat with
 * no turn yet is left to Server Core, which refuses it with `CONFLICT`.
 */
export type SessionForkBlocker = 'noAgent' | 'notChat';

export const sessionForkBlocker = (
    terminal: Pick<MobileTerminal, 'provider' | 'surface'> | undefined,
): SessionForkBlocker | undefined => {
    if (!terminal?.provider) return 'noAgent';
    if (terminal.surface !== 'chat') return 'notChat';
    return undefined;
};

/**
 * One row of the Continue in Another Agent list: every other provider, the unavailable ones carrying their reason, as
 * Desktop's submenu lists them. The Chat's own provider is left out.
 */
export interface ContinuationChoice {
    provider: AgentProvider;
    /**
     * Why the provider cannot take the work over, or `undefined` when it can.
     */
    reason: string | undefined;
}

const continuationUnavailableReason = (
    target: AgentChatContinuationTarget,
    now: number,
    t: Translate,
): string | undefined => {
    switch (target.unavailable) {
        case undefined:
        case 'current': {
            return undefined;
        }
        case 'notInstalled': {
            return t('sessions.continue.notInstalled');
        }
        case 'unsupported': {
            return t('sessions.continue.unsupported');
        }
        case 'usageLimited': {
            return target.resetsAt === undefined
                ? t('sessions.continue.usageLimited')
                : t('sessions.continue.usageLimitedUntil', {
                      reset: resetText(target.resetsAt, now, t),
                  });
        }
    }
};

export const continuationChoices = (
    targets: readonly AgentChatContinuationTarget[],
    now: number,
    t: Translate,
): ContinuationChoice[] =>
    targets
        .filter((target) => target.unavailable !== 'current')
        .map((target) => ({
            provider: target.provider,
            reason: continuationUnavailableReason(target, now, t),
        }));

/**
 * The step a Session actions sheet shows: its action list, or one action's own step that the Session menu can open
 * directly.
 */
export type SessionActionsMode =
    'continue' | 'delete' | 'detach' | 'menu' | 'rename' | 'reopen' | 'restart';

/**
 * A Session menu entry: Fork and the Agent group's Resume, Hand Over, and Take Back run at once, Go to Creating Session
 * opens that Session, and the rest open their step of the Session actions sheet.
 */
export type SessionMenuAction =
    | 'continue'
    | 'delete'
    | 'detach'
    | 'fork'
    | 'goToCreator'
    | 'handOver'
    | 'reopen'
    | 'restart'
    | 'resume'
    | 'takeBack';

/**
 * What the Session menu needs to offer Fork Session, Continue in Another Agent, Delete Session, and the Agent group.
 * Only a control device receives it; the actions themselves run where the Session actions sheet lives.
 */
export interface SessionMenuActions {
    /**
     * The last failure of an action started from the menu, shown under the header because no sheet is open for it.
     */
    error: string | null;
    /**
     * Whether an action that runs at once (Fork, Resume, Hand Over, Take Back) is still in flight.
     */
    isBusy: boolean;
    onAction: (action: SessionMenuAction) => void;
}
