/**
 * The window a Chat Terminal is mounted in. The Workbench offers every Chat action; the Caxri Bot window runs its own
 * Chat under Main's Caxri Bot policy (`apps/desktop/src/main/caxri-bot-policy.ts`), which has no Workbench to show
 * another Session in and refuses Project writes.
 */
export type AgentChatHost = 'bot' | 'workbench';

/**
 * The Chat actions a host can carry out, derived from `AgentChatHost` so every gated action reads one notion.
 */
export interface AgentChatHostCapabilities {
    /**
     * "Fork from here": a fork opens a new Session of the same Project and selects it, which only a Workbench can show.
     */
    canFork: boolean;
    /**
     * "Use as Project default" in the permission menu: saving writes the Project, which the Caxri Bot policy refuses.
     */
    canSaveProjectDefault: boolean;
    /**
     * Opening a subagent, a background shell, or a turn's review as a tab beside the Chat. The tab goes into the
     * Session's pane layout, which the Caxri Bot window never mounts: there it would be invisible and still be
     * persisted into the layout of Caxri Bot's Session, so the window offers those entries as plain, unclickable rows
     * instead.
     */
    canOpenBesideChat: boolean;
    /**
     * The context meter's Details button: it opens the Context tab, a Workbench editor tab.
     */
    canOpenContext: boolean;
    /**
     * "Continue in <Agent>" and the usage guard's "Open in another Agent": both open a new Session of the same Project,
     * which only a Workbench can show.
     */
    canContinueInAgent: boolean;
}

export function agentChatHostCapabilities(host: AgentChatHost): AgentChatHostCapabilities {
    const isWorkbench = host === 'workbench';
    return {
        canFork: isWorkbench,
        canOpenBesideChat: isWorkbench,
        canSaveProjectDefault: isWorkbench,
        canOpenContext: isWorkbench,
        canContinueInAgent: isWorkbench,
    };
}
