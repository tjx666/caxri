/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

/**
 * Members a workflow lists; a script that fans out further keeps its first members.
 */
export const MAX_AGENT_CHAT_WORKFLOW_MEMBERS = 200;

export const MAX_AGENT_CHAT_WORKFLOW_PHASES = 50;

/**
 * One subagent a workflow run started. `taskId` is the key `agentChat.readTask` opens its own conversation under
 * (`agentChatWorkflowMemberTaskId`); it is unset while the provider has not named the run or the member yet, and such a
 * member cannot be opened.
 */
const agentChatWorkflowMemberSchema = z.strictObject({
    /**
     * The provider's position of this member in the run, unique within it.
     */
    index: z.number().int().nonnegative(),
    taskId: z.string().min(1).max(200).optional(),
    /**
     * The name the script gave the member, such as `review:security`.
     */
    label: z.string().max(200),
    /**
     * Title of the phase the member ran in; unset when the script declared no phases.
     */
    phase: z.string().max(200).optional(),
    /**
     * `queued` waits for a free slot; `stopped` was interrupted with its run.
     */
    status: z.enum(['queued', 'running', 'completed', 'failed', 'stopped']),
    /**
     * Provider agent type: a built-in such as `Explore`, a custom agent's name, or unset for an ordinary member.
     */
    agentType: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    startedAt: z.number().optional(),
    /**
     * When the member last reported a step, so a member that went quiet can be told from a busy one.
     */
    lastProgressAt: z.number().optional(),
    lastToolName: z.string().max(200).optional(),
    /**
     * The provider's one-line digest of that tool call, such as the command it ran.
     */
    lastToolSummary: z.string().max(500).optional(),
    /**
     * The opening of the member's task, for its tooltip.
     */
    promptPreview: z.string().max(500).optional(),
    resultPreview: z.string().max(2_000).optional(),
    error: z.string().max(2_000).optional(),
    usage: z
        .strictObject({
            totalTokens: z.number().int().nonnegative().optional(),
            toolUses: z.number().int().nonnegative().optional(),
            durationMs: z.number().nonnegative().optional(),
        })
        .optional(),
});

/**
 * What a workflow run (Claude Code's `Workflow` tool) is made of: the phases its script declared, the subagents it
 * started, and how it ended. Carried by the run's task while the Chat lists it, and by the run's task snapshot when it
 * was rebuilt from the provider's run record (after a restart).
 */
export const agentChatWorkflowSchema = z.strictObject({
    /**
     * The provider's run id; members' conversations are read under it.
     */
    runId: z.string().min(1).max(200).optional(),
    phases: z
        .array(
            z.strictObject({
                title: z.string().max(200),
                detail: z.string().max(500).optional(),
            }),
        )
        .max(MAX_AGENT_CHAT_WORKFLOW_PHASES),
    members: z.array(agentChatWorkflowMemberSchema).max(MAX_AGENT_CHAT_WORKFLOW_MEMBERS),
    /**
     * What the script returned, as text; set once the run completed.
     */
    result: z.string().max(8_000).optional(),
    /**
     * Why the script failed, when it threw rather than a member failing.
     */
    error: z.string().max(4_000).optional(),
    /**
     * Set on a run rebuilt from a record that never ended: its process went away (Caxri or the provider restarted)
     * while it ran.
     */
    isInterrupted: z.boolean().optional(),
});

export type AgentChatWorkflow = z.infer<typeof agentChatWorkflowSchema>;
export type AgentChatWorkflowMember = z.infer<typeof agentChatWorkflowMemberSchema>;
/* eslint-enable unicorn/max-nested-calls */
