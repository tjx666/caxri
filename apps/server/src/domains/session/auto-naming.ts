import type { AutomaticNamingNotice } from '@caxri/protocol';
import { agentProviderCatalog, CaxriError, isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { AsyncSemaphore, logEventCatalog } from '@caxri/system';

import type { AgentEnvironment, AgentLifecycleSignal, AgentService } from '../agents';
import {
    agentProviderStateRoot,
    buildAgentTitlePrompt,
    hasOpeningRequestMaterial,
    hasTitleNamingMaterial,
    isBareIssueReferenceTitle,
    locateAgentTranscript,
    lowCostSandboxFailureReason,
    normalizeGeneratedAgentTitle,
    readAgentTitleMessages,
} from '../agents';
import type { CaxriDatabase } from '../db';
import { agentCommanderIdentity } from '../db';
import type { SessionRenameService } from './rename';

/**
 * Entries kept per Session-keyed bookkeeping map. A workbench holds far fewer live Sessions than this, so the bound
 * only stops a long-running Server from growing without limit; it is not the expected working-set size.
 */
const SESSION_RECORD_CAPACITY = 128;

/**
 * Waits before re-reading a transcript that lacked the finished turn. Claude Code fires its Stop hook a few
 * milliseconds before the turn's reply reaches the transcript, so a first-turn read sees only the user's prompt;
 * without these short re-reads a one-turn Session kept its placeholder name until another turn finished.
 */
const TRANSCRIPT_SETTLE_DELAYS_MS = [500, 2_000, 8_000] as const;

/**
 * One suppressed naming attempt. The Terminal is stored beside the launch because a record is only in force while the
 * Session still owns that Terminal and the Terminal is still on that launch, and the eviction path has to decide that
 * without a live turn to read it from.
 */
interface BlockedLaunch {
    launchId: string;
    reason: NonNullable<ReturnType<typeof lowCostSandboxFailureReason>>;
    terminalId: string;
}

/**
 * Generates once, from the opening request when a main turn starts or from the conversation after it completes;
 * persistent synchronization state, not provider title equality, ends naming.
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
    private readonly blockedLaunches = new Map<string, BlockedLaunch>();
    private readonly retryDeferredCounts = new Map<string, number>();
    /**
     * Transcript re-reads already spent on the current completed turn; see {@link TRANSCRIPT_SETTLE_DELAYS_MS}.
     */
    private readonly transcriptSettleAttempts = new Map<string, number>();
    private closed = false;

    constructor(
        private readonly database: CaxriDatabase,
        private readonly agents: AgentService,
        private readonly renames: SessionRenameService,
        private readonly environment: AgentEnvironment,
        private readonly isCurrentLaunch: (terminalId: string, launchId: string) => boolean,
        private readonly logger: StructuredLogger,
        private readonly onSandboxUnavailable?: (notice: AutomaticNamingNotice) => void,
    ) {}

    /**
     * Whether a suppression record still describes something that can be retried. It stops being in force the moment
     * its launch ends, its Terminal stops being the Session's primary Agent Terminal, or the Session is archived or
     * deleted: in each case the next completed turn arrives under a new identity that the record cannot match.
     */
    private isBlockedLaunchInForce(sessionId: string, blocked: BlockedLaunch): boolean {
        const session = this.database.getSession(sessionId);
        if (!session || session.archivedAt !== undefined) return false;
        return (
            session.primaryAgentTerminalId === blocked.terminalId &&
            this.isCurrentLaunch(blocked.terminalId, blocked.launchId)
        );
    }

    /**
     * Suppresses further naming attempts for one failed launch and keeps the map bounded.
     *
     * Capacity is applied to records that are still in force, never to the map as it was last left: a Session that has
     * since been retired leaves behind an entry that can never be matched again, and evicting a live entry to make room
     * for it would re-admit an attempt already known to fail: the user would be asked about the same unavailable
     * sandbox again on the very next completed turn. Re-inserting the current Session also moves it to the end of the
     * insertion order, so when every remaining record is in force the oldest one loses and the launch just recorded is
     * never the one dropped. `MAX_TERMINALS_GLOBAL` keeps the in-force set well under the bound today, which leaves
     * that last eviction as a backstop rather than the path a long session actually takes.
     */
    private blockLaunch(sessionId: string, blocked: BlockedLaunch): void {
        for (const [blockedSessionId, record] of this.blockedLaunches) {
            if (!this.isBlockedLaunchInForce(blockedSessionId, record))
                this.blockedLaunches.delete(blockedSessionId);
        }
        this.blockedLaunches.delete(sessionId);
        this.blockedLaunches.set(sessionId, blocked);
        while (this.blockedLaunches.size > SESSION_RECORD_CAPACITY)
            this.blockedLaunches.delete(this.blockedLaunches.keys().next().value!);
    }

    /**
     * Starts or schedules one naming attempt. A completed turn names the Session from the request and its reply. A
     * started turn names it from the request alone, so a long first turn does not leave the Session as `Untitled` for
     * minutes; an opening request with no subject of its own yields `SKIP` and leaves naming to the completed turn.
     * Internal replays (settle re-reads, cooldown timers, deferred events) enter here so they do not repeat the reset
     * {@link observe} applies when the signal first arrives.
     */
    private attempt(event: AgentLifecycleSignal): void {
        if (this.closed) return;
        const terminal = this.database.getTerminal(event.terminalId);
        const session = terminal && this.database.getSession(terminal.sessionId);
        if (!terminal || !session || session.primaryAgentTerminalId !== terminal.id) return;
        if (event.phase !== 'turnFinished' && event.phase !== 'turnStarted') return;
        /**
         * The Commander's own Session is hidden and carries every task in turn, so a name taken from one request only
         * mislabels the next. Claude Code would also show it on the Commander's composer after the `/rename` write.
         */
        if (agentCommanderIdentity(this.database)?.sessionId === session.id) return;
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
        if (this.blockedLaunches.get(session.id)?.launchId === event.launchId) return;
        this.blockedLaunches.delete(session.id);
        const state = this.database.automaticSessionNaming(session.id);
        if (this.running.has(session.id)) {
            this.deferred.set(session.id, event);
            return;
        }
        if (state?.status === 'complete' || state?.status === 'stopped') return;
        const delay = (this.retryAfter.get(session.id) ?? 0) - Date.now();
        /**
         * The cooldown follows a completed attempt that had the reply too; a request-only retry cannot do better, so
         * only the completed turn waits it out.
         */
        const isOpening = event.phase === 'turnStarted';
        if (isOpening && delay > 0) return;
        if (delay > 0) {
            this.retryDeferredCounts.set(
                session.id,
                (this.retryDeferredCounts.get(session.id) ?? 0) + 1,
            );
            if (this.retryDeferredCounts.size > SESSION_RECORD_CAPACITY)
                this.retryDeferredCounts.delete(this.retryDeferredCounts.keys().next().value!);
            clearTimeout(this.retryTimers.get(session.id));
            const timer = setTimeout(() => {
                this.retryTimers.delete(session.id);
                this.attempt(event);
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
            let failure: string | undefined;
            /**
             * Widened by `as` because TypeScript does not see the assignments made inside the semaphore callback.
             */
            let reason = 'ineligible' as
                | 'completed'
                | 'ineligible'
                | 'insufficientContext'
                | 'transcriptPending'
                | 'declined'
                | 'failed'
                | NonNullable<ReturnType<typeof lowCostSandboxFailureReason>>;
            try {
                await this.executions.run(async () => {
                    if (!isEligible()) return;
                    if (!state) {
                        const native = await this.agents.snapshot(target.provider, {
                            rootPath: target.cwd,
                            agentSessionId: target.agentSessionId,
                        });
                        if (!isEligible()) return;
                        if (
                            native.sessionId === target.agentSessionId &&
                            native.title &&
                            native.titleSource !== 'automatic' &&
                            (native.titleSource === 'explicit' ||
                                !isBareIssueReferenceTitle(native.title))
                        ) {
                            await this.renames.renameAutomatically(
                                session.id,
                                target,
                                native.title,
                                isEligible,
                                controller.signal,
                                native.title,
                            );
                            reason = 'declined';
                            return;
                        }
                    }
                    let title = state?.title;
                    if (!title) {
                        const location = await locateAgentTranscript(
                            this.database,
                            terminal.id,
                            this.environment,
                        );
                        const context = location
                            ? await readAgentTitleMessages(location)
                            : { opening: [], recent: [] };
                        if (!isEligible()) return;
                        if (
                            !(isOpening ? hasOpeningRequestMaterial : hasTitleNamingMaterial)(
                                context,
                            )
                        ) {
                            reason = 'transcriptPending';
                            return;
                        }
                        const candidate = await this.agents.generateTitle(target.provider, {
                            cwd: terminal.cwd,
                            prompt: buildAgentTitlePrompt(context),
                            signal: controller.signal,
                        });
                        if (!isEligible()) return;
                        title = normalizeGeneratedAgentTitle(candidate, context);
                        if (!title && candidate.trim() !== 'SKIP') {
                            title = normalizeGeneratedAgentTitle(
                                await this.agents.generateTitle(target.provider, {
                                    cwd: terminal.cwd,
                                    prompt: buildAgentTitlePrompt(context, true),
                                    signal: controller.signal,
                                }),
                                context,
                            );
                        }
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
                if (reason === 'failed') failure = automaticNamingFailure(error);
                if (sandboxReason && !controller.signal.aborted) {
                    this.blockLaunch(session.id, {
                        launchId: event.launchId,
                        reason: sandboxReason,
                        terminalId: terminal.id,
                    });
                    this.onSandboxUnavailable?.({
                        launchId: event.launchId,
                        reason: sandboxReason,
                        sessionId: session.id,
                    });
                }
            } finally {
                /**
                 * Only enums and timing enter diagnostics; neither prompts, generated names nor provider error text do.
                 */
                const retryDeferredCount = this.retryDeferredCounts.get(session.id) ?? 0;
                this.retryDeferredCounts.delete(session.id);
                const settleAttempt = this.transcriptSettleAttempts.get(session.id) ?? 0;
                /**
                 * A turn that finished while this opening attempt ran replays below with its own settle budget, so the
                 * request-only attempt does not re-read again.
                 */
                const isHandedOver =
                    isOpening && this.deferred.get(session.id)?.phase === 'turnFinished';
                const settleDelay =
                    !isHandedOver && reason === 'transcriptPending' && !controller.signal.aborted
                        ? TRANSCRIPT_SETTLE_DELAYS_MS[settleAttempt]
                        : undefined;
                if (reason === 'transcriptPending' && settleDelay === undefined)
                    reason = 'insufficientContext';
                this.logger.write(
                    reason === 'failed' ? 'warn' : 'info',
                    logEventCatalog.agent.automaticNamingFinished,
                    {
                        durationMs: performance.now() - startedAt,
                        fields: {
                            provider: target.provider,
                            reason,
                            trigger: event.phase,
                            ...(failure && { failure }),
                            sessionId: session.id,
                            ...(retryDeferredCount > 0 && { retryDeferredCount }),
                            ...(settleAttempt > 0 && { transcriptSettleAttempt: settleAttempt }),
                        },
                    },
                );
                if (settleDelay === undefined) {
                    this.transcriptSettleAttempts.delete(session.id);
                    /**
                     * A request-only attempt that found no subject must not hold back the completed turn, which names
                     * the Session from the reply as well.
                     */
                    if (
                        !isOpening &&
                        !controller.signal.aborted &&
                        !this.blockedLaunches.has(session.id)
                    )
                        this.retryAfter.set(session.id, Date.now() + 60_000);
                } else {
                    this.transcriptSettleAttempts.set(session.id, settleAttempt + 1);
                    if (this.transcriptSettleAttempts.size > SESSION_RECORD_CAPACITY)
                        this.transcriptSettleAttempts.delete(
                            this.transcriptSettleAttempts.keys().next().value!,
                        );
                    clearTimeout(this.retryTimers.get(session.id));
                    const timer = setTimeout(() => {
                        this.retryTimers.delete(session.id);
                        this.attempt(event);
                    }, settleDelay);
                    timer.unref();
                    this.retryTimers.set(session.id, timer);
                }
                if (this.retryAfter.size > SESSION_RECORD_CAPACITY)
                    this.retryAfter.delete(this.retryAfter.keys().next().value!);
                this.running.delete(session.id);
                const deferred = this.deferred.get(session.id);
                this.deferred.delete(session.id);
                if (deferred) this.attempt(deferred);
            }
        };
        this.running.set(session.id, { controller, promise: execute() });
    }

    /**
     * The suppressions a freshly connected client still has to be told about.
     *
     * The live notice is a transient event, so it is simply lost while macOS has no window open: the Server keeps
     * running turns, and the user comes back to a Session that silently kept its placeholder name. Reading the
     * suppression records the service already maintains gives the reason somewhere to wait, and reusing
     * {@link isBlockedLaunchInForce} means a launch that has since ended, changed Terminal, or been archived is never
     * replayed as if it were still true.
     */
    automaticNamingNotices(): AutomaticNamingNotice[] {
        const notices: AutomaticNamingNotice[] = [];
        for (const [sessionId, blocked] of this.blockedLaunches) {
            if (!this.isBlockedLaunchInForce(sessionId, blocked)) continue;
            notices.push({ launchId: blocked.launchId, reason: blocked.reason, sessionId });
        }
        return notices;
    }

    observe(event: AgentLifecycleSignal): void {
        if (this.closed || event.agentId) return;
        const terminal = this.database.getTerminal(event.terminalId);
        const session = terminal && this.database.getSession(terminal.sessionId);
        if (!terminal || !session || session.primaryAgentTerminalId !== terminal.id) return;
        const isTurnBoundary = event.phase === 'turnStarted' || event.phase === 'sessionIdentified';
        /**
         * A fresh signal supersedes any pending re-read or cooldown replay, including an opening attempt still waiting
         * for its request when the turn finishes; a cooldown is rescheduled by `attempt` from `retryAfter`.
         */
        if (isTurnBoundary || event.phase === 'turnFinished') {
            this.transcriptSettleAttempts.delete(session.id);
            clearTimeout(this.retryTimers.get(session.id));
            this.retryTimers.delete(session.id);
        }
        if (isTurnBoundary) {
            this.deferred.delete(session.id);
            this.running.get(session.id)?.controller.abort();
        }
        this.attempt(event);
    }

    /**
     * Generates a title on the user's request from the primary Agent's conversation, regardless of `titleMode` or the
     * automatic naming state, and returns it without applying it. The caller commits it through `session.rename`, which
     * claims manual ownership so automatic naming never replaces a name the user asked for.
     */
    async suggestTitle(sessionId: string, signal?: AbortSignal): Promise<{ displayTitle: string }> {
        const startedAt = performance.now();
        let provider: string | undefined;
        let reason:
            | 'completed'
            | 'noAgent'
            | 'insufficientContext'
            | 'cancelled'
            | 'failed'
            | NonNullable<ReturnType<typeof lowCostSandboxFailureReason>> = 'failed';
        let failure: string | undefined;
        try {
            const session = this.database.getSession(sessionId);
            if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
            const terminal =
                session.primaryAgentTerminalId &&
                this.database.getTerminal(session.primaryAgentTerminalId);
            if (!terminal || !terminal.provider) {
                reason = 'noAgent';
                throw new CaxriError(
                    'UNAVAILABLE',
                    'This Session has no Agent conversation to name',
                );
            }
            provider = terminal.provider;
            const terminalProvider = terminal.provider;
            const title = await this.executions.run(async () => {
                signal?.throwIfAborted();
                const location = await locateAgentTranscript(
                    this.database,
                    terminal.id,
                    this.environment,
                    signal,
                );
                const context = location
                    ? await readAgentTitleMessages(location)
                    : { opening: [], recent: [] };
                if (!hasTitleNamingMaterial(context)) return;
                const generate = (isRetry: boolean): Promise<string> =>
                    this.agents.generateTitle(terminalProvider, {
                        cwd: terminal.cwd,
                        prompt: buildAgentTitlePrompt(context, isRetry),
                        signal,
                    });
                const candidate = await generate(false);
                return (
                    normalizeGeneratedAgentTitle(candidate, context) ??
                    (candidate.trim() === 'SKIP'
                        ? undefined
                        : normalizeGeneratedAgentTitle(await generate(true), context))
                );
            });
            if (!title) {
                reason = 'insufficientContext';
                throw new CaxriError(
                    'UNAVAILABLE',
                    'Not enough conversation to name this Session yet',
                );
            }
            reason = 'completed';
            return { displayTitle: title };
        } catch (error) {
            if (signal?.aborted) reason = 'cancelled';
            else if (reason === 'failed') {
                const sandboxReason = lowCostSandboxFailureReason(error);
                if (sandboxReason) reason = sandboxReason;
                else failure = automaticNamingFailure(error);
            }
            throw error;
        } finally {
            this.logger.write(
                reason === 'failed' ? 'warn' : 'info',
                logEventCatalog.agent.titleSuggestionFinished,
                {
                    durationMs: performance.now() - startedAt,
                    fields: {
                        provider: provider ?? null,
                        reason,
                        ...(failure && { failure }),
                        sessionId,
                    },
                },
            );
        }
    }

    /**
     * Retires all Session-keyed naming state before its durable record is deleted.
     *
     * A running task stays in `running` until its promise settles so `close()` still owns every started task. Its
     * controller is aborted first; queued semaphore work then observes the same signal through `isEligible()` and
     * releases its slot without starting provider work. The finalizer also checks that signal before recreating any
     * retry state, so a late provider result cannot resurrect state for the retired Session.
     */
    forgetSession(sessionId: string): void {
        this.running.get(sessionId)?.controller.abort();
        clearTimeout(this.retryTimers.get(sessionId));
        this.retryTimers.delete(sessionId);
        this.retryAfter.delete(sessionId);
        this.deferred.delete(sessionId);
        this.blockedLaunches.delete(sessionId);
        this.retryDeferredCounts.delete(sessionId);
        this.transcriptSettleAttempts.delete(sessionId);
    }

    async close(): Promise<void> {
        this.closed = true;
        for (const timer of this.retryTimers.values()) clearTimeout(timer);
        this.retryTimers.clear();
        for (const task of this.running.values()) task.controller.abort();
        await Promise.allSettled(this.running.values().map((task) => task.promise));
        this.retryAfter.clear();
        this.retryDeferredCounts.clear();
        this.transcriptSettleAttempts.clear();
        this.deferred.clear();
        this.blockedLaunches.clear();
    }
}

/**
 * Closed cause of a `failed` naming attempt. Provider stderr stays out of diagnostics, but "failed" alone cannot tell a
 * missing CLI from a timeout or a signed-out account whose CLI exited non-zero.
 */
function automaticNamingFailure(error: unknown): string {
    if (isCaxriError(error)) return error.code.toLowerCase();
    const failure = error as { code?: unknown; exitCode?: unknown };
    if (failure.code === 'ENOENT' || failure.code === 'EACCES') return 'spawn';
    if (typeof failure.exitCode === 'number') return 'exit';
    return 'unknown';
}
