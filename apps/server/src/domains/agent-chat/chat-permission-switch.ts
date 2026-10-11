import type { AgentChatPermission, AgentChatPermissionRequest } from '@caxri/protocol';
import { CaxriError, resolveAgentChatPermissionChange } from '@caxri/protocol';

import { requireChatTerminal } from './chat-launch';
import type { ChatStateDelivery } from './chat-states';
import type { AgentChatServiceOptions } from './service-options';

export interface ChatPermissionSwitchHost {
    options: Pick<AgentChatServiceOptions, 'database'>;
    enqueue: (terminalId: string, deliver: ChatStateDelivery) => Promise<void>;
    /**
     * Restarts the provider on the same conversation, keeping its approval mode (see `AgentRunAutonomy`).
     */
    restart: (terminalId: string) => Promise<unknown>;
}

/**
 * Switches a Chat's permission level or plan mode and saves it as the Chat's choice, so a later restart starts with it.
 * The switch waits its turn in the Chat's send chain like a model switch, so it lands between the messages sent around
 * it. A provider that switches in place (Claude Code, Codex) applies it from the next turn on; one that fixes it at
 * launch (Grok Build) restarts on the same conversation, which a running turn would cut short, so that fails with
 * `CONFLICT` instead.
 */
export async function switchChatPermission(
    host: ChatPermissionSwitchHost,
    terminalId: string,
    request: AgentChatPermissionRequest,
): Promise<void> {
    const { database } = host.options;
    const { provider } = requireChatTerminal(database, terminalId);
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
