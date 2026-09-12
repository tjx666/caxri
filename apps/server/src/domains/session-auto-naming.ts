import { agentProviderCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { AsyncSemaphore, logEventCatalog } from '@caxri/system';

import type { AgentEnvironment, AgentLifecycleSignal, AgentService } from './agents';
import {
    agentProviderStateRoot,
    buildAgentTitlePrompt,
    locateAgentTranscript,
    lowCostSandboxFailureReason,
    normalizeGeneratedAgentTitle,
    readAgentTitleMessages,
} from './agents';
import type { CaxriDatabase } from './db';
import type { SessionRenameService } from './session-rename';

/**
 * Generates once after a completed main turn; persistent synchronization state, not provider title equality, ends
 * naming.
 */
export class SessionAutoNamingService {
    private readonly executions = new AsyncSemaphore(2);
    private readonly running = new Map<
        string,
        { controller: AbortController; promise: Promise<void> }
    >();
    private readonly retryAfter = new Map<string, number>();
    private readonly deferred = new Map<string, AgentLifecycleSignal>();
    private readonly retryTimers = new Map<string, NodeJS.Timeout>();
    private readonly blockedLaunches = new Map<string, string>();
    private readonly retryDeferredCounts = new Map<string, number>();
    private closed = false;

    constructor(
        private readonly database: CaxriDatabase,
        private readonly agents: AgentService,
        private readonly renames: SessionRenameService,
        private readonly environment: AgentEnvironment,
        private readonly isCurrentLaunch: (terminalId: string, launchId: string) => boolean,
        private readonly logger: StructuredLogger,
        private readonly onSandboxUnavailable?: (
            sessionId: string,
            reason: NonNullable<ReturnType<typeof lowCostSandboxFailureReason>>,
        ) => void,
    ) {}

    observe(event: AgentLifecycleSignal): void {
        if (this.closed || event.agentId) return;
        const terminal = this.database.getTerminal(event.terminalId);
        const session = terminal && this.database.getSession(terminal.sessionId);
        if (!terminal || !session || session.primaryAgentTerminalId !== terminal.id) return;
        if (event.phase !== 'turnFinished') {
            if (event.phase === 'turnStarted' || event.phase === 'sessionIdentified') {
                this.deferred.delete(session.id);
                clearTimeout(this.retryTimers.get(session.id));
                this.retryTimers.delete(session.id);
                this.running.get(session.id)?.controller.abort();
            }
            return;
        }
        if (
            session.titleMode !== 'automatic' ||
            session.archivedAt !== undefined ||
            !terminal.agentSessionId ||
            !terminal.provider ||
            !agentProviderCatalog[terminal.provider].capabilities.nativeRename
        )
            return;
        if (!this.isCurrentLaunch(terminal.id, event.launchId)) return;
        /**
         * A boundary failure cannot be repaired by retrying the same launch after every completed turn.
         */
        if (this.blockedLaunches.get(session.id) === event.launchId) return;
        this.blockedLaunches.delete(session.id);
        const state = this.database.automaticSessionNaming(session.id);
        if (this.running.has(session.id)) {
            this.deferred.set(session.id, event);
            return;
        }
        if (state?.status === 'complete' || state?.status === 'stopped') return;
        const delay = (this.retryAfter.get(session.id) ?? 0) - Date.now();
        if (delay > 0) {
            this.retryDeferredCounts.set(
                session.id,
                (this.retryDeferredCounts.get(session.id) ?? 0) + 1,
            );
            if (this.retryDeferredCounts.size > 128)
                this.retryDeferredCounts.delete(this.retryDeferredCounts.keys().next().value!);
            clearTimeout(this.retryTimers.get(session.id));
            const timer = setTimeout(() => {
                this.retryTimers.delete(session.id);
                this.observe(event);
            }, delay);
            timer.unref();
            this.retryTimers.set(session.id, timer);
            return;
        }
        const controller = new AbortController();
        const revision = this.renames.revision(session.id);
        const target = {
            terminalId: terminal.id,
            agentSessionId: terminal.agentSessionId,
            provider: terminal.provider,
            cwd: agentProviderStateRoot(terminal),
        };
        const isEligible = (): boolean => {
            const current = this.database.getSession(session.id);
            const currentTerminal = this.database.getTerminal(terminal.id);
            return (
                !this.closed &&
                !controller.signal.aborted &&
                current?.titleMode === 'automatic' &&
                current.archivedAt === undefined &&
                current.primaryAgentTerminalId === terminal.id &&
                currentTerminal?.agentSessionId === target.agentSessionId &&
                currentTerminal.provider === target.provider &&
                agentProviderStateRoot(currentTerminal) === target.cwd &&
                this.renames.revision(session.id) === revision &&
                this.isCurrentLaunch(terminal.id, event.launchId)
            );
        };
        const execute = async (): Promise<void> => {
            const startedAt = performance.now();
            let reason:
                | 'completed'
                | 'ineligible'
                | 'insufficientContext'
                | 'declined'
                | 'failed'
                | NonNullable<ReturnType<typeof lowCostSandboxFailureReason>> = 'ineligible';
            try {
                await this.executions.run(async () => {
                    if (!isEligible()) return;
                    let title = state?.title;
                    if (!title) {
                        const location = await locateAgentTranscript(
                            this.database,
                            terminal.id,
                            this.environment,
                        );
                        const messages = location ? await readAgentTitleMessages(location) : [];
                        if (!isEligible()) return;
                        if (
                            messages.every((message) => message.role !== 'user') ||
                            messages.every((message) => message.role !== 'assistant')
                        ) {
                            reason = 'insufficientContext';
                            return;
                        }
                        title = normalizeGeneratedAgentTitle(
                            await this.agents.generateTitle(target.provider, {
                                cwd: terminal.cwd,
                                prompt: buildAgentTitlePrompt(messages),
                                signal: controller.signal,
                            }),
                        );
                        if (!title) {
                            reason = 'insufficientContext';
                            return;
                        }
                    }
                    if (!isEligible()) return;
                    reason = (await this.renames.renameAutomatically(
                        session.id,
                        target,
                        title,
                        isEligible,
                        controller.signal,
                    ))
                        ? 'completed'
                        : 'declined';
                });
            } catch (error) {
                const sandboxReason = lowCostSandboxFailureReason(error);
                reason = controller.signal.aborted ? 'ineligible' : (sandboxReason ?? 'failed');
                if (sandboxReason && !controller.signal.aborted) {
                    this.blockedLaunches.set(session.id, event.launchId);
                    if (this.blockedLaunches.size > 128)
                        this.blockedLaunches.delete(this.blockedLaunches.keys().next().value!);
                    this.onSandboxUnavailable?.(session.id, sandboxReason);
                }
            } finally {
                /**
                 * Only enums and timing enter diagnostics; neither prompts, generated names nor provider error text do.
                 */
                const retryDeferredCount = this.retryDeferredCounts.get(session.id) ?? 0;
                this.retryDeferredCounts.delete(session.id);
                this.logger.write(
                    reason === 'failed' ? 'warn' : 'info',
                    logEventCatalog.agent.automaticNamingFinished,
                    {
                        durationMs: performance.now() - startedAt,
                        fields: {
                            provider: target.provider,
                            reason,
                            sessionId: session.id,
                            ...(retryDeferredCount > 0 && { retryDeferredCount }),
                        },
                    },
                );
                if (!controller.signal.aborted && !this.blockedLaunches.has(session.id))
                    this.retryAfter.set(session.id, Date.now() + 60_000);
                if (this.retryAfter.size > 128)
                    this.retryAfter.delete(this.retryAfter.keys().next().value!);
                this.running.delete(session.id);
                const deferred = this.deferred.get(session.id);
                this.deferred.delete(session.id);
                if (deferred) this.observe(deferred);
            }
        };
        this.running.set(session.id, { controller, promise: execute() });
    }

    async close(): Promise<void> {
        this.closed = true;
        for (const timer of this.retryTimers.values()) clearTimeout(timer);
        this.retryTimers.clear();
        for (const task of this.running.values()) task.controller.abort();
        await Promise.allSettled(this.running.values().map((task) => task.promise));
        this.retryAfter.clear();
        this.retryDeferredCounts.clear();
        this.deferred.clear();
        this.blockedLaunches.clear();
    }
}
