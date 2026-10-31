import type { AgentAction, AgentChatAppCommand } from '@caxri/protocol';
import { agentChatAppCommandAction, agentChatSessionHandoffAction } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * Desktop's app commands the phone has a control for: the Session usage sheet, the model sheet, the plan mode switch,
 * and the Session's Rename, Archive, and Pin actions. `/status`, `/btw`, `/fork`, and `/new` have no phone control
 * yet.
 */
type MobileAgentChatAppCommand = Extract<
    AgentChatAppCommand,
    'archive' | 'model' | 'pin' | 'plan' | 'rename' | 'usage'
>;

/**
 * Session actions the composer hands to the Session screen, which owns the Rename sheet and the Session list.
 */
export type MobileAgentChatSessionCommand = Extract<
    MobileAgentChatAppCommand,
    'archive' | 'pin' | 'rename'
>;

const SESSION_COMMANDS: ReadonlySet<AgentChatAppCommand> = new Set(['archive', 'pin', 'rename']);

export const isMobileAgentChatSessionCommand = (
    command: AgentChatAppCommand,
): command is MobileAgentChatSessionCommand => SESSION_COMMANDS.has(command);

/**
 * What the phone can do right now, so the menu offers only commands that would work, as Desktop hides one it cannot
 * run.
 */
export interface MobileAgentChatAppCommandState {
    /**
     * The device may change the model (`agentChatDisabledReason` with `action: 'configure'` is empty).
     */
    canConfigure: boolean;
    /**
     * The device may rename, archive, and pin Sessions (`control` access).
     */
    canManageSession: boolean;
    /**
     * The device may switch permissions and the provider reports plan mode.
     */
    canPlan: boolean;
    /**
     * The Session usage sheet has something to show.
     */
    hasUsage: boolean;
    isPinned: boolean;
}

/**
 * The phone's built-in `/` rows, Caxri's own before the provider's: `/new-session`, which every provider offers since
 * Caxri runs it, then the app commands the device can run now, in Desktop's order and words.
 */
export function mobileAgentChatBuiltInActions(
    state: MobileAgentChatAppCommandState,
    t: Translate = translate,
): AgentAction[] {
    const offered: Array<[MobileAgentChatAppCommand, boolean, string]> = [
        ['usage', state.hasUsage, t('chat.commands.app.usage')],
        ['model', state.canConfigure, t('chat.commands.app.model')],
        ['plan', state.canPlan, t('chat.commands.app.plan')],
        ['rename', state.canManageSession, t('chat.commands.app.rename')],
        ['archive', state.canManageSession, t('chat.commands.app.archive')],
        [
            'pin',
            state.canManageSession,
            t(state.isPinned ? 'chat.commands.app.unpin' : 'chat.commands.app.pin'),
        ],
    ];
    return [
        agentChatSessionHandoffAction({
            argumentHint: t('chat.commands.newSessionHint'),
            description: t('chat.commands.newSessionDescription'),
        }),
        ...offered
            .filter(([, isOffered]) => isOffered)
            .map(([command, , description]) => agentChatAppCommandAction(command, description)),
    ];
}
