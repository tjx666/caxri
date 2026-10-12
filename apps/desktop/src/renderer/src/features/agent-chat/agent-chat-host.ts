/**
 * The window a Chat Terminal is mounted in. The Workbench offers every Chat action; the Agent Commander window runs its
 * own Chat under Main's Commander policy (`apps/desktop/src/main/agent-commander-policy.ts`), which has no Workbench to
 * show another Session in and refuses Project writes.
 */
export type AgentChatHost = 'commander' | 'workbench';

/**
 * The Chat actions a host can carry out, derived from `AgentChatHost` so every gated action reads one notion.
 */
export interface AgentChatHostCapabilities {
    /**
     * "Fork from here": a fork opens a new Session of the same Project and selects it, which only a Workbench can show.
     */
    canFork: boolean;
    /**
     * "Use as Project default" in the permission menu: saving writes the Project, which the Commander policy refuses.
     */
    canSaveProjectDefault: boolean;
}

export function agentChatHostCapabilities(host: AgentChatHost): AgentChatHostCapabilities {
    const isWorkbench = host === 'workbench';
    return { canFork: isWorkbench, canSaveProjectDefault: isWorkbench };
}
