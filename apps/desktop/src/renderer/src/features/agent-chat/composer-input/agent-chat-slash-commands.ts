import type { AgentAction, AgentChatAppCommand, AgentChatCommand } from '@caxri/protocol';
import {
    AGENT_CHAT_APP_COMMANDS,
    AGENT_CHAT_GOAL_COMMAND,
    AGENT_CHAT_SESSION_HANDOFF_COMMAND,
    agentChatAppCommandAction,
    agentChatSessionHandoffAction,
} from '@caxri/protocol';

import type { Translate } from '../../../i18n';

/**
 * The Desktop Chat composer's slash-command and skill menu helpers that are Desktop-only. Runnable commands are the
 * provider's own (`AgentChatSnapshot.commands`); the menu rows, their ranking and grouping, and reading a draft as a
 * command are shared with the phone (`agentChatMenuActions`, `agentChatDraftMatches`, `parseAgentChatCommand`).
 */

/**
 * The menu's status line for skills, or `undefined` when discovery has answered: skills are discovered only from a
 * running Agent, and the first discovery takes a moment.
 */
export function agentChatSkillDiscoveryNotice(
    state: {
        isAgentRunning: boolean;
        isLoading: boolean;
    },
    t: Translate,
): { text: string; isLoading: boolean } | undefined {
    if (!state.isAgentRunning)
        return { text: t('agentChat.slash.skillsNeedAgent'), isLoading: false };
    return state.isLoading
        ? { text: t('agentChat.slash.loadingSkills'), isLoading: true }
        : undefined;
}

/**
 * The `/name` or `$name` a sent message starts with, the only place the composer puts an invocation, split from what
 * follows it. A name starts with a letter, so `$5` or a path such as `/usr/bin` stays plain text.
 */
export function agentChatLeadingInvocation(
    text: string,
): { invocation: string; rest: string } | undefined {
    const match = /^([/$][A-Za-z][\w:.-]*)(?=\s|$)/u.exec(text);
    const invocation = match?.[1];
    return invocation ? { invocation, rest: text.slice(invocation.length) } : undefined;
}

/**
 * Whether the provider has a native goal command (Codex's `/goal`), which the composer's Goal mode and Add menu Goal
 * need. A custom command that only shares the name is not one.
 */
export function isAgentChatGoalOffered(commands: readonly AgentChatCommand[] | undefined): boolean {
    return (
        commands?.some(
            (command) => command.goal === true && command.name === AGENT_CHAT_GOAL_COMMAND,
        ) === true
    );
}

/**
 * Whether choosing `action` from the slash menu enters Goal mode instead of completing `/goal ` in the draft, as the
 * Codex app's `/goal` does.
 */
export function isAgentChatGoalAction(action: AgentAction): boolean {
    return action.kind === 'command' && action.invocation === `/${AGENT_CHAT_GOAL_COMMAND}`;
}

/**
 * The draft once Goal mode takes it: what is typed becomes the goal's text, so a leading `/goal` the user already typed
 * is dropped rather than becoming part of the objective.
 */
export function agentChatGoalModeDraft(draft: string): string {
    const match = new RegExp(String.raw`^\s*/${AGENT_CHAT_GOAL_COMMAND}(?:\s+|$)`, 'u').exec(draft);
    return match ? draft.slice(match[0].length) : draft;
}

/**
 * What the Chat can do right now, which decides which app commands can run: a row whose control this Chat lacks (a
 * provider without plan mode or side chats, a Chat with no conversation to fork yet) stays in the menu, disabled with
 * its reason (`agentChatAppCommandUnavailable`), rather than vanishing and leaving a typed `/fork` to read as "no such
 * command".
 */
export interface AgentChatAppCommandState {
    canChangeModel: boolean;
    canTogglePlanMode: boolean;
    canOpenSideChat: boolean;
    canFork: boolean;
    /**
     * Whether the Chat belongs to a Session, which `/new`, `/rename`, `/archive`, and `/pin` act on.
     */
    hasSession: boolean;
    isPinned: boolean;
}

function isAgentChatAppCommandAvailable(
    command: AgentChatAppCommand,
    state: AgentChatAppCommandState,
): boolean {
    switch (command) {
        case 'model': {
            return state.canChangeModel;
        }
        case 'plan': {
            return state.canTogglePlanMode;
        }
        case 'btw': {
            return state.canOpenSideChat;
        }
        case 'fork': {
            return state.canFork;
        }
        case 'new':
        case 'rename':
        case 'archive':
        case 'pin': {
            return state.hasSession;
        }
        default: {
            return true;
        }
    }
}

function agentChatAppCommandDescription(
    command: AgentChatAppCommand,
    state: AgentChatAppCommandState,
    t: Translate,
): string {
    switch (command) {
        case 'status': {
            return t('agentChat.slash.app.status');
        }
        case 'usage': {
            return t('agentChat.slash.app.usage');
        }
        case 'model': {
            return t('agentChat.slash.app.model');
        }
        case 'plan': {
            return t('agentChat.slash.app.plan');
        }
        case 'btw': {
            return t('agentChat.slash.app.btw');
        }
        case 'fork': {
            return t('agentChat.slash.app.fork');
        }
        case 'new': {
            return t('agentChat.slash.app.new');
        }
        case 'rename': {
            return t('agentChat.slash.app.rename');
        }
        case 'archive': {
            return t('agentChat.slash.app.archive');
        }
        case 'pin': {
            return t(state.isPinned ? 'agentChat.slash.app.unpin' : 'agentChat.slash.app.pin');
        }
    }
}

function agentChatAppCommandUnavailableReason(command: AgentChatAppCommand, t: Translate): string {
    switch (command) {
        case 'model':
        case 'plan':
        case 'btw': {
            return t('agentChat.slash.app.unavailableAgent');
        }
        case 'fork': {
            return t('agentChat.slash.app.unavailableFork');
        }
        default: {
            return t('agentChat.slash.app.unavailableSession');
        }
    }
}

/**
 * Why each app command this Chat cannot run right now is unavailable, by invocation (`/fork`). Their rows stay in the
 * menu with the reason as their description and choosing one does nothing.
 */
export function agentChatAppCommandUnavailable(
    state: AgentChatAppCommandState,
    t: Translate,
): ReadonlyMap<string, string> {
    return new Map(
        AGENT_CHAT_APP_COMMANDS.filter(
            (command) => !isAgentChatAppCommandAvailable(command, state),
        ).map((command) => [`/${command}`, agentChatAppCommandUnavailableReason(command, t)]),
    );
}

/**
 * Every app command row, in {@link AGENT_CHAT_APP_COMMANDS} order, including the ones this Chat cannot run now
 * (`agentChatAppCommandUnavailable`). `/btw` keeps its `[question]` hint: a bare `/btw` opens the side chat, and `/btw
 * <question>` asks it straight away.
 */
export function agentChatAppCommandActions(
    state: AgentChatAppCommandState,
    t: Translate,
): AgentAction[] {
    return AGENT_CHAT_APP_COMMANDS.map((command) =>
        agentChatAppCommandAction(
            command,
            agentChatAppCommandDescription(command, state, t),
            command === 'btw' ? t('agentChat.slash.app.btwHint') : undefined,
        ),
    );
}

/**
 * Caxri's own rows a Desktop Chat menu leads with (`withAgentChatBuiltInActions`): `/new-session`, which every provider
 * offers because Caxri runs it (see `parseAgentChatSessionHandoffCommand`), then the app commands
 * (`agentChatAppCommandActions`).
 */
export function agentChatBuiltInActions(
    t: Translate,
    appActions: readonly AgentAction[] = [],
): AgentAction[] {
    return [
        agentChatSessionHandoffAction({
            argumentHint: t('agentChat.slash.newSessionHint'),
            description: t('agentChat.slash.newSessionDescription'),
        }),
        ...appActions,
    ];
}

/**
 * The invocations Caxri itself runs (`/new-session` and the app commands), which the menu tags so they read apart from
 * the provider's own commands.
 */
export function agentChatCaxriInvocations(appActions: readonly AgentAction[]): ReadonlySet<string> {
    return new Set([
        `/${AGENT_CHAT_SESSION_HANDOFF_COMMAND}`,
        ...appActions.map((a) => a.invocation),
    ]);
}
