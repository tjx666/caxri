import type {
    CanUseTool,
    PermissionMode,
    PermissionResult,
    PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatRequest, AgentChatResponse } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { answeredNotice, clip, questionAnswers } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import { claudeQuestionAnswers, mapClaudeApproval, mapClaudeQuestion } from './claude-items';
import { CLAUDE_DECLINED_MESSAGE } from './claude-tool-results';

const STOPPED: PermissionResult = {
    behavior: 'deny',
    message: 'Caxri Chat stopped',
    interrupt: true,
};

type Json = Record<string, unknown>;

interface PendingRequest {
    toolName: string;
    input: Json;
    suggestions: PermissionUpdate[];
    turnId?: string;
    resolve: (result: PermissionResult) => void;
}

interface ClaudeRequestOwner {
    host: AgentChatSessionHost;
    sessionId(): string;
    isEnded(): boolean;
    /**
     * A `cancel` decision denies the tool and interrupts the turn, which then finishes as interrupted.
     */
    onInterruptRequested(): void;
    /**
     * The mode an approved `ExitPlanMode` leaves plan mode for: the Chat's chosen level, or `undefined` to let Claude
     * Code pick (no chosen level, or plan mode is already off).
     */
    planExitMode(): PermissionMode | undefined;
}

/**
 * The permission updates an approval carries. Approving `ExitPlanMode` switches straight to the chosen level in the
 * same step (`planExitMode`), so no tool call runs under the looser mode Claude Code would otherwise pick after the
 * plan; any mode Claude Code suggested is replaced by it.
 */
function approvalUpdates(
    pending: PendingRequest,
    decision: 'accept' | 'acceptForSession',
    planExitMode: PermissionMode | undefined,
): PermissionUpdate[] {
    const suggested = decision === 'acceptForSession' ? pending.suggestions : [];
    if (!planExitMode) return suggested;
    return [
        ...suggested.filter((update) => update.type !== 'setMode'),
        { type: 'setMode', mode: planExitMode, destination: 'session' },
    ];
}

/**
 * Claude Code's `canUseTool` permission prompts and AskUserQuestion calls, held as pending Chat requests until the user
 * answers. Each SDK callback stays unresolved until `respond`, the turn ending, or the process ending settles it.
 */
export class ClaudeRequestBroker {
    private readonly pending = new Map<string, PendingRequest>();

    /**
     * Tool calls the user declined; Claude Code reports them as error results, which the timeline shows as declined.
     */
    private readonly declined = new Set<string>();

    /**
     * Requests asked over the process lifetime, for the exit diagnostic.
     */
    count = 0;

    constructor(private readonly owner: ClaudeRequestOwner) {}

    private settle(key: string): void {
        if (!this.pending.delete(key)) return;
        const { host } = this.owner;
        const { requests } = host.read();
        host.apply([
            { op: 'state', state: { requests: requests.filter((request) => request.id !== key) } },
        ]);
        host.lifecycle({
            phase: 'attentionResolved',
            agentSessionId: this.owner.sessionId(),
            agentToolUseId: key,
        });
    }

    async canUseTool(
        ...[toolName, input, context]: Parameters<CanUseTool>
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve) => {
            if (this.owner.isEnded()) {
                resolve(STOPPED);
                return;
            }
            const { host } = this.owner;
            const id = clip(context.toolUseID, 200);
            this.count += 1;
            const turnId = host.read().activeTurnId;
            const suggestions = context.suggestions ?? [];
            const request: AgentChatRequest =
                toolName === 'AskUserQuestion'
                    ? mapClaudeQuestion(id, input)
                    : mapClaudeApproval(id, toolName, input, {
                          canRemember: suggestions.length > 0,
                          reason: context.decisionReason ?? context.title,
                      });
            const isNew = !this.pending.has(id);
            this.pending.set(id, {
                toolName,
                input,
                suggestions,
                ...(turnId && { turnId }),
                resolve,
            });
            context.signal.addEventListener(
                'abort',
                () => {
                    const pending = this.pending.get(id);
                    if (pending?.resolve !== resolve) return;
                    resolve({ behavior: 'deny', message: 'Cancelled', interrupt: true });
                    this.settle(id);
                },
                { once: true },
            );
            const { requests } = host.read();
            host.apply([
                {
                    op: 'state',
                    state: {
                        requests: [
                            ...requests.filter((existing) => existing.id !== id),
                            request,
                        ].slice(-20),
                    },
                },
            ]);
            if (isNew)
                host.lifecycle({
                    phase: 'attentionRequested',
                    agentSessionId: this.owner.sessionId(),
                    agentTurnId: turnId,
                    agentToolUseId: id,
                });
        });
    }

    /**
     * Reports, once, whether the user declined the tool call behind a tool result.
     */
    takeDeclined(toolUseId: string): boolean {
        return this.declined.delete(toolUseId);
    }

    /**
     * Denies every outstanding request. Claude Code asks before each tool call, so a request can only outlive its turn
     * or process when the process ended mid-question.
     */
    settleAll(message: string): void {
        for (const [key, pending] of this.pending) {
            pending.resolve({ behavior: 'deny', message, interrupt: true });
            this.settle(key);
        }
    }

    /**
     * Denies every outstanding request without touching the projection, for a process that ended. Returns their ids so
     * the caller can resolve attention after it closes the projection.
     */
    drain(): string[] {
        const keys = this.pending.keys().toArray();
        for (const pending of this.pending.values()) pending.resolve(STOPPED);
        this.pending.clear();
        return keys;
    }

    respond(requestId: string, response: AgentChatResponse): void {
        const pending = this.pending.get(requestId);
        if (!pending) throw new CaxriError('CONFLICT', 'This request is no longer pending');
        if (pending.toolName === 'AskUserQuestion') {
            const answers = questionAnswers(response);
            const mapped = claudeQuestionAnswers(pending.input, answers);
            if (Object.keys(mapped).length === 0)
                pending.resolve({ behavior: 'deny', message: 'The user skipped the question.' });
            else
                pending.resolve({
                    behavior: 'allow',
                    updatedInput: { ...pending.input, answers: mapped },
                });
            const { host } = this.owner;
            const answered = answeredNotice(
                host.read().requests.find((request) => request.id === requestId),
                pending.turnId,
                answers,
            );
            if (answered) host.apply([{ op: 'upsertItem', item: answered }]);
        } else {
            if (response.kind !== 'decision')
                throw new CaxriError('VALIDATION', 'An approval needs a decision');
            switch (response.decision) {
                case 'accept':
                case 'acceptForSession': {
                    const updates = approvalUpdates(
                        pending,
                        response.decision,
                        pending.toolName === 'ExitPlanMode' ? this.owner.planExitMode() : undefined,
                    );
                    pending.resolve({
                        behavior: 'allow',
                        updatedInput: pending.input,
                        ...(updates.length > 0 && { updatedPermissions: updates }),
                    });
                    break;
                }
                case 'decline': {
                    this.declined.add(requestId);
                    pending.resolve({ behavior: 'deny', message: CLAUDE_DECLINED_MESSAGE });
                    break;
                }
                case 'cancel': {
                    this.declined.add(requestId);
                    this.owner.onInterruptRequested();
                    pending.resolve({
                        behavior: 'deny',
                        message: CLAUDE_DECLINED_MESSAGE,
                        interrupt: true,
                    });
                    break;
                }
            }
        }
        this.settle(requestId);
    }
}
