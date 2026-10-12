import type {
    AgentChatPermission,
    AgentChatPermissionRequest,
    AgentProvider,
} from '@caxri/protocol';
import { CaxriError, resolveAgentChatPermissionChange } from '@caxri/protocol';

import { requireChatTerminal } from './chat-launch';
import { chatPermissionState } from './chat-permissions';
import type { AgentChatSessionHost } from './chat-provider';
import type { ChatState, ChatStateDelivery } from './chat-states';
import type { AgentChatServiceOptions } from './service-options';

export interface ChatPermissionSwitchHost {
    options: Pick<AgentChatServiceOptions, 'database'>;
    /**
     * Appends to the Chat's send chain directly. The service holds new input back until the switch settles (see
     * `AgentChatService.setPermission`), so this must not wait behind that hold itself.
     */
    enqueue: (terminalId: string, deliver: ChatStateDelivery) => Promise<void>;
    /**
     * Restarts the provider on the same conversation, keeping its approval mode (see `AgentRunAutonomy`).
     */
    restart: (terminalId: string) => Promise<unknown>;
    /**
     * Whether the Chat has a provider process or a start in flight.
     */
    isLive: (terminalId: string) => boolean;
    /**
     * The Chat's in-memory state after the admission fence passed it, so a detached, closing, or archived Chat refuses
     * a switch it could not start with.
     */
    admit: (terminalId: string) => ChatState;
}

/**
 * Per Chat, the permission switch that new input waits behind. A switch registers synchronously, before it reaches the
 * send chain, so input sent right after it waits for the whole switch, including a Grok Build restart that runs after
 * its chain entry settles, and then joins the chain of the state the switch left instead of the stopped process's.
 * Input already in the chain still runs first; a second switch waits for the first.
 */
export class ChatPermissionSwitches {
    private readonly pending = new Map<string, Promise<unknown>>();

    constructor(private readonly host: ChatPermissionSwitchHost) {}

    /**
     * Switches the Chat's permission; see {@link switchChatPermission}.
     */
    async switch(terminalId: string, request: AgentChatPermissionRequest): Promise<void> {
        const previous = this.pending.get(terminalId);
        const switching = (async () => {
            if (previous) await Promise.allSettled([previous]);
            await switchChatPermission(this.host, terminalId, request);
        })();
        this.pending.set(terminalId, switching);
        try {
            await switching;
        } finally {
            if (this.pending.get(terminalId) === switching) this.pending.delete(terminalId);
        }
    }

    /**
     * Waits for the Chat's pending switch, whether it succeeded or failed.
     */
    async settled(terminalId: string): Promise<void> {
        const switching = this.pending.get(terminalId);
        if (switching) await Promise.allSettled([switching]);
    }
}

/**
 * Switches a Chat's permission level or plan mode and saves it as the Chat's choice, so a later restart starts with it.
 * The switch waits its turn in the Chat's send chain like a model switch, so it lands between the messages sent around
 * it. A provider that switches in place (Claude Code, Codex) applies it from the next turn on; one that fixes it at
 * launch (Grok Build) restarts on the same conversation, which a running turn would cut short, so that fails with
 * `CONFLICT` instead. The service holds input sent after the switch until the restart finishes, so it reaches the
 * restarted provider instead of a process the restart is about to stop.
 *
 * A Chat with no provider process only saves the choice: its next start launches with it, so the switch neither starts
 * the provider nor, for Grok Build, starts it twice (once to switch, once to restart).
 */
async function switchChatPermission(
    host: ChatPermissionSwitchHost,
    terminalId: string,
    request: AgentChatPermissionRequest,
): Promise<void> {
    const { database } = host.options;
    const { provider } = requireChatTerminal(database, terminalId);
    if (!host.isLive(terminalId)) {
        saveIdleChatPermission(host, terminalId, provider, request);
        return;
    }
    // Set inside the queued switch, so read only after it ran.
    const outcome = { isRestartNeeded: false };
    await host.enqueue(terminalId, async (session, state) => {
        const { permissionMode, planMode } = state.projection.snapshot;
        const next = resolveAgentChatPermissionChange(
            provider,
            { ...(permissionMode && { permissionMode }), planMode: planMode ?? false },
            request,
        );
        if (next.permissionMode === permissionMode && next.planMode === (planMode ?? false)) return;
        if (session.setPermission) {
            await session.setPermission(next);
        } else {
            if (state.projection.snapshot.activeTurnId)
                throw new CaxriError(
                    'CONFLICT',
                    'Wait for the current turn to finish before changing permissions',
                );
            outcome.isRestartNeeded = true;
            // Refuse input that reaches the old process's chain before the restart, as a rewind does.
            state.retiring ??= 'replaced';
        }
        database.setChatPermission(
            terminalId,
            chatPermissionToStore(
                database.getChatPermission(terminalId),
                next,
                request.permissionMode !== undefined,
            ),
        );
    });
    if (outcome.isRestartNeeded) await host.restart(terminalId);
}

/**
 * Saves a switch for a Chat with no provider process and shows it on the projection a stopped or failed Chat still
 * displays, until the next start reports what it launched with.
 */
function saveIdleChatPermission(
    host: ChatPermissionSwitchHost,
    terminalId: string,
    provider: AgentProvider,
    request: AgentChatPermissionRequest,
): void {
    const { database } = host.options;
    const { projection } = host.admit(terminalId);
    const { snapshot } = projection;
    const stored = database.getChatPermission(terminalId);
    const permissionMode = snapshot.permissionMode ?? stored?.permissionMode;
    const next = resolveAgentChatPermissionChange(
        provider,
        {
            ...(permissionMode && { permissionMode }),
            planMode: snapshot.planMode ?? stored?.planMode ?? false,
        },
        request,
    );
    database.setChatPermission(
        terminalId,
        chatPermissionToStore(stored, next, request.permissionMode !== undefined),
    );
    projection.apply([
        { op: 'state', state: chatPermissionState(provider, next.permissionMode, next.planMode) },
    ]);
}

/**
 * The `onSessionBound` and `onPermissionChanged` members of a Chat host, scoped to one launch: they persist what the
 * running provider reports (its session id, or a permission it switched to on its own such as Claude Code leaving plan
 * mode). Reports from a superseded launch are dropped.
 */
export function chatReportedStateHost(
    database: ChatPermissionSwitchHost['options']['database'],
    scope: {
        terminalId: string;
        provider: AgentProvider;
        isCurrent: () => boolean;
        onRebound: () => void;
    },
): Pick<AgentChatSessionHost, 'onPermissionChanged' | 'onSessionBound'> {
    const { terminalId, provider, isCurrent, onRebound } = scope;
    return {
        onSessionBound: (agentSessionId) => {
            if (!isCurrent()) return;
            if (database.rebindAgentSession(terminalId, provider, agentSessionId)) onRebound();
        },
        onPermissionChanged: (permission) => {
            if (!isCurrent()) return;
            database.setChatPermission(
                terminalId,
                chatPermissionToStore(database.getChatPermission(terminalId), permission),
            );
        },
    };
}

/**
 * The permission a Chat stores after a change. A level the Chat only inherited from the launch settings (the Settings
 * autonomy switch) stays unstored until the user picks one, so toggling plan mode alone, or Claude Code leaving plan
 * mode on its own, does not pin that level and the Chat keeps following the launch settings.
 */
export function chatPermissionToStore(
    stored: AgentChatPermission | undefined,
    next: AgentChatPermission,
    isLevelPicked = false,
): AgentChatPermission {
    const isLevelKept = isLevelPicked || stored?.permissionMode !== undefined;
    return {
        ...(isLevelKept && next.permissionMode && { permissionMode: next.permissionMode }),
        planMode: next.planMode,
    };
}
