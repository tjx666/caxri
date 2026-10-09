import { randomUUID } from 'node:crypto';

import type {
    AgentChatFailureReason,
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentLaunchSettings,
    ServerEvent,
    TerminalFailureReason,
    TerminalRecord,
} from '@caxri/protocol';
import {
    agentChatSnapshotSchema,
    applyAgentChatOperation,
    CaxriError,
    emptyAgentChatSnapshot,
    errorMessage,
    isChatTerminal,
    MAX_AGENT_CHAT_PATCH_OPERATIONS,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, readE2EAgentPolicy } from '@caxri/system';

import type { AgentLifecycleSignal } from '../agents';
import type { CaxriDatabase } from '../db';
import { SingleFlight } from '../single-flight';
import type { TerminalManagerOptions } from '../terminal';
import { resolveTerminalExecutable } from '../terminal';
import type { CodexChatSessionOptions } from './codex-chat-session';
import { CodexChatSession } from './codex-chat-session';
import type { ChatLifecycleEvent, CodexChatExit } from './codex-chat-types';
import { AgentChatStartError } from './codex-chat-types';
import { codexChatSettings } from './launch-settings';

/**
 * Streaming deltas are coalesced into one patch per frame-sized window so a fast provider does not flood every Client
 * with one event per token.
 */
const PATCH_FLUSH_MS = 16;

export interface AgentChatServiceOptions {
    database: CaxriDatabase;
    logger: StructuredLogger;
    send(event: ServerEvent): void;
    environment(): Promise<NodeJS.ProcessEnv>;
    launchSettings(provider: 'codex'): AgentLaunchSettings;
    resolveExecutable?: TerminalManagerOptions['resolveExecutable'];
    coordinator: {
        beginTerminalLaunch(terminalId: string, launchId: string): void;
        endTerminalLaunch(terminalId: string): void;
        probeTerminal(terminalId: string): void;
    };
    observeLifecycleSignal(signal: AgentLifecycleSignal): Promise<unknown>;
    clientVersion: string;
    spawnProcess?: CodexChatSessionOptions['spawnProcess'];
}

interface ChatState {
    snapshot: AgentChatSnapshot;
    /**
     * Operations Clients have not seen yet; `snapshot.revision` advances only when they are flushed.
     */
    queued: AgentChatPatchOperation[];
    flushTimer?: NodeJS.Timeout;
    session?: CodexChatSession;
    launchId?: string;
    /**
     * Settles after the last accepted send. Serializes sends so two quick messages cannot both start a turn.
     */
    sendQueue: Promise<unknown>;
}

const TERMINAL_FAILURE_REASONS: Record<AgentChatFailureReason, TerminalFailureReason> = {
    executable_not_found: 'executable_not_found',
    spawn_failed: 'spawn_failed',
    handshake_failed: 'spawn_failed',
    process_exited: 'spawn_failed',
    resume_failed: 'agent_session_unavailable',
    unsupported_version: 'spawn_failed',
};

/**
 * Owns every Chat Terminal's provider process and in-memory conversation projection. Processes start lazily on the
 * first read or message, so Server Core restart never relaunches idle Chats; the provider's own record is the source of
 * truth and comes back on resume. See `docs/agent-chat.md`.
 */
export class AgentChatService {
    private readonly states = new Map<string, ChatState>();
    /**
     * One provider start in flight per Terminal; concurrent reads and sends join it.
     */
    private readonly starts = new SingleFlight<string, void>();

    /**
     * The revision a Chat's next projection starts from after its state was dropped (restart, close). Clients keep
     * their cached snapshot across both, so a projection that restarted at 0 would have every new patch discarded as
     * already applied. Starting one past the last revision instead leaves a gap that makes each Client re-read.
     */
    private readonly revisionFloors = new Map<string, number>();

    private isShuttingDown = false;

    constructor(private readonly options: AgentChatServiceOptions) {}

    private async stop(terminalId: string): Promise<void> {
        const state = this.states.get(terminalId);
        if (!state) return;
        await Promise.allSettled([this.starts.get(terminalId)]);
        await state.session?.close();
        state.session = undefined;
    }

    private requireChatTerminal(terminalId: string): TerminalRecord {
        const terminal = this.options.database.getTerminal(terminalId);
        if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
        if (!isChatTerminal(terminal) || terminal.provider !== 'codex')
            throw new CaxriError('UNAVAILABLE', 'This Terminal does not use Chat');
        return terminal;
    }

    private state(terminalId: string): ChatState {
        let state = this.states.get(terminalId);
        if (!state) {
            state = {
                snapshot: {
                    ...emptyAgentChatSnapshot(terminalId),
                    revision: this.revisionFloors.get(terminalId) ?? 0,
                },
                queued: [],
                sendQueue: Promise.resolve(),
            };
            this.states.set(terminalId, state);
        }
        return state;
    }

    private apply(terminalId: string, operations: AgentChatPatchOperation[]): void {
        const state = this.states.get(terminalId);
        if (!state || operations.length === 0) return;
        for (const operation of operations)
            state.snapshot = applyAgentChatOperation(state.snapshot, operation);
        state.queued.push(...operations);
        if (state.queued.length >= MAX_AGENT_CHAT_PATCH_OPERATIONS) this.flush(terminalId, state);
        else
            state.flushTimer ??= setTimeout(() => {
                state.flushTimer = undefined;
                this.flush(terminalId, state);
            }, PATCH_FLUSH_MS);
    }

    /**
     * Emits queued operations as one patch. A Client whose copy is at `baseRevision` applies them; any other Client
     * re-reads. Called before every read so a snapshot never contains operations a later patch would apply again.
     */
    /**
     * Drops a Chat's projection without letting its pending patches reach Clients after a replacement chain began.
     */
    private forget(terminalId: string): void {
        const state = this.states.get(terminalId);
        if (!state) return;
        if (state.flushTimer) clearTimeout(state.flushTimer);
        this.revisionFloors.set(terminalId, state.snapshot.revision + 1);
        this.states.delete(terminalId);
    }

    private flush(terminalId: string, state: ChatState): void {
        if (state.flushTimer) {
            clearTimeout(state.flushTimer);
            state.flushTimer = undefined;
        }
        while (state.queued.length > 0) {
            const operations = state.queued.splice(0, MAX_AGENT_CHAT_PATCH_OPERATIONS);
            const baseRevision = state.snapshot.revision;
            state.snapshot = { ...state.snapshot, revision: baseRevision + 1 };
            this.options.send({
                event: 'agentChat.patch',
                payload: { terminalId, baseRevision, revision: baseRevision + 1, operations },
            });
        }
    }

    private setStatus(
        terminalId: string,
        status: AgentChatSnapshot['status'],
        failure?: { reason: AgentChatFailureReason; detail?: string },
    ): void {
        this.apply(terminalId, [{ op: 'state', state: { status, failure: failure ?? null } }]);
    }

    private sendTerminalChange(terminalId: string): void {
        this.options.send({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: [terminalId] },
        });
    }

    private async ensureStarted(terminal: TerminalRecord): Promise<CodexChatSession> {
        const state = this.state(terminal.id);
        /**
         * `start()` publishes its session as soon as the process spawns, before the thread exists, so an open session
         * alone does not mean it can take a turn. Join an in-flight start instead of sending into it early.
         */
        if (this.starts.has(terminal.id) || !state.session?.isOpen)
            await this.starts.run(terminal.id, () => this.start(terminal, state));
        if (!state.session?.isOpen)
            throw new CaxriError(
                'UNAVAILABLE',
                state.snapshot.failure?.detail ?? 'Codex Chat is not running',
            );
        return state.session;
    }

    /**
     * Starts the provider for a caller that does not need the session. A failed start is already recorded in the
     * projection, where every Client sees it.
     */
    private async startQuietly(terminal: TerminalRecord): Promise<void> {
        try {
            await this.ensureStarted(terminal);
        } catch {
            // Recorded in the projection by start().
        }
    }

    private async start(terminal: TerminalRecord, state: ChatState): Promise<void> {
        const { database, logger } = this.options;
        const terminalId = terminal.id;
        const launchId = randomUUID();
        const startedAt = Date.now();
        state.launchId = launchId;
        this.setStatus(terminalId, 'starting');
        database.updateTerminalState(terminalId, 'starting');
        database.updateAgentProcessState(terminalId, 'starting');
        this.sendTerminalChange(terminalId);
        this.options.coordinator.beginTerminalLaunch(terminalId, launchId);
        const isCurrent = () =>
            state.launchId === launchId && this.states.get(terminalId) === state;
        let session: CodexChatSession | undefined;
        try {
            /**
             * Real-Agent E2E authority covers exactly one ephemeral `codex exec`; a Chat would be a second, broader
             * launch, so only fake-executable E2E may drive it.
             */
            if (readE2EAgentPolicy()?.mode === 'real')
                throw new AgentChatStartError(
                    'spawn_failed',
                    'Chat is unavailable in real-Agent E2E',
                );
            const launch = this.options.launchSettings('codex');
            let executable: string;
            try {
                executable = await resolveTerminalExecutable(
                    'codex',
                    launch,
                    this.options.resolveExecutable,
                );
            } catch {
                throw new AgentChatStartError('executable_not_found', 'Codex CLI was not found');
            }
            const environment = await this.options.environment();
            session = new CodexChatSession({
                terminalId,
                cwd: terminal.cwd,
                executable,
                environment,
                settings: codexChatSettings(launch),
                threadId: database.getTerminal(terminalId)?.agentSessionId,
                clientVersion: this.options.clientVersion,
                spawnProcess: this.options.spawnProcess,
                read: () => state.snapshot,
                apply: (operations) => {
                    if (isCurrent()) this.apply(terminalId, operations);
                },
                lifecycle: (event) => {
                    if (isCurrent()) this.lifecycle(terminalId, launchId, event);
                },
                onThreadBound: (threadId) => {
                    if (!isCurrent()) return;
                    if (database.rebindAgentSession(terminalId, 'codex', threadId))
                        this.sendTerminalChange(terminalId);
                },
                onTurnFinished: (status, durationMs) =>
                    logger.write('info', logEventCatalog.agentChat.turnFinished, {
                        fields: { terminalId, status, durationMs: durationMs ?? null },
                    }),
                onProtocolRejected: (reason, method) =>
                    logger.write('warn', logEventCatalog.agentChat.protocolRejected, {
                        fields: { terminalId, reason, method: method.slice(0, 100) },
                    }),
                onExit: (exit) => this.onExit(terminalId, state, launchId, exit),
            });
            state.session = session;
            const mode = await session.start();
            if (!isCurrent()) {
                await session.close();
                return;
            }
            this.setStatus(terminalId, 'ready');
            database.updateTerminalState(terminalId, 'running');
            database.updateAgentProcessState(terminalId, 'running');
            this.sendTerminalChange(terminalId);
            if (database.getTerminal(terminalId)?.agentSessionId)
                this.options.coordinator.probeTerminal(terminalId);
            logger.write('info', logEventCatalog.agentChat.processStarted, {
                fields: { terminalId, outcome: 'ready', mode, durationMs: Date.now() - startedAt },
            });
        } catch (error) {
            if (state.session === session) state.session = undefined;
            await session?.close();
            const failure =
                error instanceof AgentChatStartError
                    ? { reason: error.reason, detail: error.detail }
                    : { reason: 'spawn_failed' as const, detail: 'Codex Chat could not start' };
            logger.write('warn', logEventCatalog.agentChat.processStarted, {
                fields: {
                    terminalId,
                    outcome: 'failed',
                    reason: failure.reason,
                    durationMs: Date.now() - startedAt,
                    ...(!(error instanceof AgentChatStartError) && {
                        error: errorMessage(error, 'unknown'),
                    }),
                },
            });
            if (!isCurrent() || this.isShuttingDown) return;
            this.setStatus(terminalId, 'failed', failure);
            this.options.coordinator.endTerminalLaunch(terminalId);
            if (database.getTerminal(terminalId)) {
                database.updateTerminalState(
                    terminalId,
                    'failed',
                    TERMINAL_FAILURE_REASONS[failure.reason],
                    failure.detail,
                );
                database.updateAgentProcessState(terminalId, 'failed');
                this.sendTerminalChange(terminalId);
            }
        }
    }

    private lifecycle(terminalId: string, launchId: string, event: ChatLifecycleEvent): void {
        const signal: AgentLifecycleSignal = {
            ...event,
            launchId,
            provider: 'codex',
            terminalId,
        };
        // eslint-disable-next-line no-void -- lifecycle delivery is ordered by the coordinator, not by this caller.
        void this.observeLifecycleSignal(signal);
    }

    private async observeLifecycleSignal(signal: AgentLifecycleSignal): Promise<void> {
        try {
            await this.options.observeLifecycleSignal(signal);
        } catch (error: unknown) {
            this.options.logger.write('warn', logEventCatalog.agentChat.protocolRejected, {
                fields: {
                    terminalId: signal.terminalId,
                    reason: 'lifecycleFailed',
                    error: errorMessage(error, 'unknown'),
                },
            });
        }
    }

    private onExit(
        terminalId: string,
        state: ChatState,
        launchId: string,
        exit: CodexChatExit,
    ): void {
        const { database, logger } = this.options;
        logger.write(exit.requested ? 'info' : 'warn', logEventCatalog.agentChat.processExited, {
            fields: {
                terminalId,
                reason: exit.end.reason,
                requested: exit.requested,
                ...(exit.end.reason === 'exited' && {
                    exitCode: exit.end.exitCode,
                    signal: exit.end.signal,
                }),
                turns: exit.turns,
                serverRequests: exit.serverRequests,
                rejectedRequests: exit.rejectedRequests,
                droppedFrames: exit.droppedFrames,
            },
        });
        // A start in progress reports its own closed failure reason.
        if (state.launchId !== launchId || this.isShuttingDown || this.starts.has(terminalId))
            return;
        /**
         * The projection already marked the running turn interrupted; end it for Session Activity too. A requested stop
         * (Restart, close) ends the turn the way an interrupt does; an unrequested one is a provider failure.
         */
        if (exit.activeTurnId)
            this.lifecycle(
                terminalId,
                launchId,
                exit.requested
                    ? { phase: 'turnFinished', agentTurnId: exit.activeTurnId }
                    : {
                          phase: 'turnFailed',
                          agentTurnId: exit.activeTurnId,
                          agentFailure: 'provider_failed',
                      },
            );
        state.session = undefined;
        state.launchId = undefined;
        this.options.coordinator.endTerminalLaunch(terminalId);
        if (!database.getTerminal(terminalId)) return;
        if (exit.requested) {
            this.setStatus(terminalId, 'stopped');
            database.updateTerminalState(terminalId, 'stopped');
            database.updateAgentProcessState(terminalId, 'stopped');
        } else {
            // No detail: the closed reason's own copy already says everything Caxri knows about the exit.
            this.setStatus(terminalId, 'failed', { reason: 'process_exited' });
            database.updateTerminalExitState(terminalId, 'dead');
            database.updateAgentProcessExitState(terminalId, 'dead');
        }
        this.sendTerminalChange(terminalId);
    }

    /**
     * Number of live provider processes. Counted as busy work so Server Core idle exit cannot stop a running Chat.
     */
    liveCount(): number {
        let count = 0;
        for (const state of this.states.values()) if (state.session?.isOpen) count += 1;
        return count;
    }

    read(terminalId: string): AgentChatSnapshot {
        const terminal = this.requireChatTerminal(terminalId);
        const state = this.state(terminalId);
        this.flush(terminalId, state);
        if (!state.session && !this.starts.has(terminalId) && state.snapshot.status !== 'failed')
            // eslint-disable-next-line no-void -- the read returns the starting projection; patches follow.
            void this.startQuietly(terminal);
        this.flush(terminalId, state);
        return agentChatSnapshotSchema.parse(state.snapshot);
    }

    async send(terminalId: string, text: string): Promise<void> {
        const terminal = this.requireChatTerminal(terminalId);
        const state = this.state(terminalId);
        const previous = state.sendQueue;
        const run = (async () => {
            await previous;
            const session = await this.ensureStarted(terminal);
            await session.send(text);
        })();
        state.sendQueue = Promise.allSettled([run]);
        await run;
    }

    async interrupt(terminalId: string): Promise<void> {
        this.requireChatTerminal(terminalId);
        await this.states.get(terminalId)?.session?.interrupt();
    }

    respond(
        terminalId: string,
        requestId: string,
        response: Parameters<CodexChatSession['respond']>[1],
    ): void {
        this.requireChatTerminal(terminalId);
        const session = this.states.get(terminalId)?.session;
        if (!session) throw new CaxriError('CONFLICT', 'This request is no longer pending');
        session.respond(requestId, response);
    }

    /**
     * Stops the provider and starts it again on the same Agent Session. Clears a previous failure.
     */
    async restart(terminalId: string): Promise<TerminalRecord> {
        const terminal = this.requireChatTerminal(terminalId);
        await this.stop(terminalId);
        this.forget(terminalId);
        await this.startQuietly(terminal);
        return this.options.database.getTerminal(terminalId) ?? terminal;
    }

    /**
     * Stops a Chat whose Terminal is being closed, deleted, or archived, and forgets its projection.
     */
    async close(terminalId: string): Promise<void> {
        await this.stop(terminalId);
        this.forget(terminalId);
    }

    async closeSession(sessionId: string): Promise<void> {
        const ids = this.options.database
            .listTerminals(sessionId)
            .filter((terminal) => this.states.has(terminal.id))
            .map((terminal) => terminal.id);
        await Promise.all(ids.map((id) => this.close(id)));
    }

    /**
     * Server Core shutdown. Durable process state is stamped by the shared shutdown path, so exits here write nothing.
     */
    async shutdown(): Promise<void> {
        this.isShuttingDown = true;
        await Promise.all(this.states.keys().map((id) => this.stop(id)));
        for (const state of this.states.values())
            if (state.flushTimer) clearTimeout(state.flushTimer);
        this.states.clear();
    }
}
