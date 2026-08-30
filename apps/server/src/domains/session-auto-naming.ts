import type {
    AgentAutomaticNamingHealth,
    AgentProvider,
    AppSettings,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { AsyncSemaphore, logEventCatalog } from '@caxri/system';

import type { AgentLifecycleSignal, AgentService } from './agents';
import {
    buildAgentTitlePrompt,
    normalizeGeneratedAgentTitle,
    readAgentTitleGitBranch,
} from './agents/title-generation';
import type { CaxriDatabase } from './db';
import type { SessionRenameService } from './session-rename';

const MAX_SESSION_SLOTS = 128;
const MINIMUM_TRANSCRIPT_GROWTH_BYTES = 512;
const MINIMUM_GENERATION_INTERVAL_MS = 60_000;
const FAILURE_COOLDOWN_MS = 60_000;
const MAX_CONCURRENT_TITLE_GENERATIONS = 2;

interface NamingTrigger {
    agentSessionId: string;
    launchId: string;
    provider: AgentProvider;
    revision: number;
    sessionId: string;
    terminalId: string;
}

interface NamingSlot {
    controller?: AbortController;
    lastAttemptAt?: number;
    lastAttemptBytes?: number;
    lastFailureAt?: number;
    latest?: NamingTrigger;
    revision: number;
    running?: Promise<void>;
}

interface NamingTarget {
    session: SessionRecord;
    terminal: TerminalRecord & { agentSessionId: string; provider: AgentProvider };
}

export interface SessionAutoNamingOptions {
    hasForeignHookConflict: (provider: AgentProvider) => boolean;
    isCurrentLaunch: (terminalId: string, launchId: string) => boolean;
    onHealthChanged?: (provider: AgentProvider, health: AgentAutomaticNamingHealth) => void;
    now?: () => number;
}

function errorKind(error: unknown): string {
    if (error instanceof CaxriError) return error.code;
    return error instanceof Error ? error.name : 'unknown';
}

function failureHealth(error: unknown): AgentAutomaticNamingHealth {
    if (error instanceof CaxriError && error.code === 'TIMEOUT')
        return {
            kind: 'lastAttemptFailed',
            message: 'The naming model timed out. Caxri will retry later.',
        };
    if (error instanceof CaxriError && error.code === 'UNAVAILABLE')
        return {
            kind: 'unavailable',
            message: 'The installed Agent CLI does not support automatic naming.',
        };
    return {
        kind: 'lastAttemptFailed',
        message: 'Automatic naming failed. Caxri will retry later.',
    };
}

/**
 * Owns background Session naming generations. Provider transcript text stays within `AgentService` and the generated
 * prompt is sent only to a provider CLI over stdin; this coordinator persists and emits titles and enum state only.
 */
export class SessionAutoNamingService {
    private closed = false;
    private readonly executions = new AsyncSemaphore(MAX_CONCURRENT_TITLE_GENERATIONS);
    private readonly now: () => number;
    private readonly slots = new Map<string, NamingSlot>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly agents: AgentService,
        private readonly renames: SessionRenameService,
        private readonly settings: () => AppSettings,
        private readonly emit: (event: ServerEvent) => void,
        private readonly logger: StructuredLogger,
        private readonly options: SessionAutoNamingOptions,
    ) {
        this.now = options.now ?? Date.now;
    }

    private target(trigger: NamingTrigger, canUseStopped = true): NamingTarget | undefined {
        if (this.closed) return;
        const session = this.database.getSession(trigger.sessionId);
        const terminal = this.database.getTerminal(trigger.terminalId);
        const providerSettings = this.settings()['agents.providers'][trigger.provider];
        if (
            !session ||
            !terminal ||
            session.archivedAt !== undefined ||
            session.primaryAgentTerminalId !== trigger.terminalId ||
            session.titleMode !== 'automatic' ||
            (!canUseStopped && session.autoNamingState !== 'active') ||
            terminal.provider !== trigger.provider ||
            terminal.agentSessionId !== trigger.agentSessionId ||
            !this.options.isCurrentLaunch(trigger.terminalId, trigger.launchId) ||
            !providerSettings.naming.enabled ||
            !providerSettings.hooks.enabled ||
            this.options.hasForeignHookConflict(trigger.provider)
        ) {
            return;
        }
        return {
            session,
            terminal: terminal as NamingTarget['terminal'],
        };
    }

    private isLatest(sessionId: string, slot: NamingSlot, trigger: NamingTrigger): boolean {
        return this.slots.get(sessionId) === slot && slot.revision === trigger.revision;
    }

    private emitSession(sessionId: string): void {
        this.emit({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
        });
    }

    private stopForProviderTitle(sessionId: string): void {
        if (!this.database.sessionNaming.stop(sessionId))
            throw new CaxriError('NOT_FOUND', 'Session not found');
        this.emitSession(sessionId);
    }

    private async execute(
        slot: NamingSlot,
        trigger: NamingTrigger,
        signal: AbortSignal,
    ): Promise<void> {
        const initial = this.target(trigger);
        if (!initial || signal.aborted) return;
        const now = this.now();
        if (slot.lastFailureAt && now - slot.lastFailureAt < FAILURE_COOLDOWN_MS) return;
        if (slot.lastAttemptAt && now - slot.lastAttemptAt < MINIMUM_GENERATION_INTERVAL_MS) return;
        const source = await this.agents.readTitleSource(trigger.provider, {
            agentSessionId: trigger.agentSessionId,
            rootPath: initial.terminal.cwd,
        });
        if (!source) {
            this.options.onHealthChanged?.(trigger.provider, {
                kind: 'lastAttemptBlocked',
                message: 'The bound Agent Session history is unavailable.',
            });
            return;
        }
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while source IO awaits
        if (signal.aborted || !this.isLatest(trigger.sessionId, slot, trigger)) return;
        const current = this.target(trigger);
        if (!current || source.userMessages.length === 0) return;
        const ownership = this.database.sessionNaming.get(trigger.sessionId);
        if (!ownership) return;
        if (source.providerTitleState === 'unknown') {
            this.options.onHealthChanged?.(trigger.provider, {
                kind: 'lastAttemptBlocked',
                message: 'The provider Session name could not be verified safely.',
            });
            return;
        }
        if (source.providerTitleState === 'explicit') {
            if (
                !source.currentProviderTitle ||
                source.currentProviderTitle !== ownership.lastAutoTitle
            ) {
                this.stopForProviderTitle(trigger.sessionId);
                return;
            }
        } else if (ownership.state === 'stopped' || ownership.lastAutoTitle) {
            const resumed = await this.renames.resumeAutomaticNaming(
                trigger.sessionId,
                async () => {
                    if (!this.isLatest(trigger.sessionId, slot, trigger) || !this.target(trigger))
                        return false;
                    const latest = await this.agents.readTitleOwnership(trigger.provider, {
                        agentSessionId: trigger.agentSessionId,
                        rootPath: current.terminal.cwd,
                    });
                    return latest.providerTitleState === 'absent';
                },
            );
            if (!resumed) return;
        }
        if (!this.target(trigger, false)) return;
        if (
            slot.lastAttemptBytes !== undefined &&
            source.byteLength >= slot.lastAttemptBytes &&
            source.byteLength - slot.lastAttemptBytes < MINIMUM_TRANSCRIPT_GROWTH_BYTES
        ) {
            return;
        }
        slot.lastAttemptAt = now;
        slot.lastAttemptBytes = source.byteLength;
        source.currentProviderTitle ??=
            current.session.displayTitle === 'Untitled' ? undefined : current.session.displayTitle;
        source.gitBranch ??= await readAgentTitleGitBranch(current.terminal.cwd);
        if (!this.isLatest(trigger.sessionId, slot, trigger)) return;
        const generated = await this.agents.generateSessionTitle(trigger.provider, {
            cwd: current.terminal.cwd,
            prompt: buildAgentTitlePrompt(source),
            signal,
        });
        if (!this.isLatest(trigger.sessionId, slot, trigger) || !this.target(trigger, false))
            return;
        const title = normalizeGeneratedAgentTitle(generated);
        if (!title || title === source.currentProviderTitle) return;
        const applied = await this.renames.renameAutomatically(
            trigger.sessionId,
            title,
            () =>
                this.isLatest(trigger.sessionId, slot, trigger) &&
                Boolean(this.target(trigger, false)),
            signal,
            async () => {
                if (
                    !this.isLatest(trigger.sessionId, slot, trigger) ||
                    !this.target(trigger, false)
                )
                    return false;
                const latest = await this.agents.readTitleOwnership(trigger.provider, {
                    agentSessionId: trigger.agentSessionId,
                    rootPath: current.terminal.cwd,
                });
                if (latest.providerTitleState === 'unknown') return false;
                if (
                    latest.providerTitleState === 'explicit' &&
                    (source.providerTitleState !== 'explicit' ||
                        latest.currentProviderTitle !== source.currentProviderTitle)
                ) {
                    this.stopForProviderTitle(trigger.sessionId);
                    return false;
                }
                return true;
            },
        );
        if (applied) {
            slot.lastFailureAt = undefined;
            this.options.onHealthChanged?.(trigger.provider, { kind: 'ready' });
        }
    }

    private async drain(slot: NamingSlot): Promise<void> {
        try {
            while (!this.closed && slot.latest) {
                const trigger = slot.latest;
                slot.latest = undefined;
                const controller = new AbortController();
                slot.controller = controller;
                try {
                    // eslint-disable-next-line no-await-in-loop -- one valid task per Session is the concurrency contract
                    await this.executions.run(() => this.execute(slot, trigger, controller.signal));
                } catch (error) {
                    if (!controller.signal.aborted) {
                        slot.lastFailureAt = this.now();
                        this.logger.write('warn', logEventCatalog.agent.autoNamingFailed, {
                            fields: { errorKind: errorKind(error), provider: trigger.provider },
                        });
                        this.options.onHealthChanged?.(trigger.provider, failureHealth(error));
                    }
                } finally {
                    if (slot.controller === controller) slot.controller = undefined;
                }
            }
        } finally {
            slot.running = undefined;
            if (slot.latest && !this.closed) this.run(slot);
        }
    }

    private run(slot: NamingSlot): void {
        slot.running = this.drain(slot);
    }

    private slot(sessionId: string): NamingSlot {
        let slot = this.slots.get(sessionId);
        if (!slot) {
            slot = { revision: 0 };
            this.slots.set(sessionId, slot);
            if (this.slots.size > MAX_SESSION_SLOTS) {
                const oldest = [...this.slots].find(([, candidate]) => !candidate.running);
                if (oldest) this.slots.delete(oldest[0]);
            }
        }
        return slot;
    }

    private invalidateSession(sessionId: string): void {
        const slot = this.slots.get(sessionId);
        if (!slot) return;
        slot.revision += 1;
        slot.latest = undefined;
        slot.controller?.abort();
    }

    observe(signal: AgentLifecycleSignal): void {
        const terminal = this.database.getTerminal(signal.terminalId);
        if (!terminal) return;
        const session = this.database.getSession(terminal.sessionId);
        if (!session || session.primaryAgentTerminalId !== terminal.id) return;
        if (signal.phase !== 'turnFinished') {
            if (signal.phase === 'turnStarted' || signal.phase === 'sessionIdentified')
                this.invalidateSession(session.id);
            return;
        }
        if (!terminal.provider || !terminal.agentSessionId) return;
        const slot = this.slot(session.id);
        slot.revision += 1;
        slot.controller?.abort();
        slot.latest = {
            agentSessionId: terminal.agentSessionId,
            launchId: signal.launchId,
            provider: terminal.provider,
            revision: slot.revision,
            sessionId: session.id,
            terminalId: terminal.id,
        };
        if (!slot.running) this.run(slot);
    }

    pauseSession(sessionId: string): void {
        this.invalidateSession(sessionId);
    }

    forgetSession(sessionId: string): void {
        this.invalidateSession(sessionId);
        this.slots.delete(sessionId);
    }

    forgetTerminal(terminalId: string): void {
        const sessionId = this.database.getTerminal(terminalId)?.sessionId;
        if (sessionId) this.invalidateSession(sessionId);
    }

    async resumeSession(sessionId: string): Promise<SessionRecord> {
        this.invalidateSession(sessionId);
        const resumed = await this.renames.resumeAutomaticNaming(sessionId);
        if (!resumed) throw new CaxriError('NOT_FOUND', 'Session not found');
        return resumed;
    }

    reconcile(settings: AppSettings['agents.providers']): void {
        for (const [sessionId, slot] of this.slots) {
            const session = this.database.getSession(sessionId);
            const terminal = session?.primaryAgentTerminalId
                ? this.database.getTerminal(session.primaryAgentTerminalId)
                : undefined;
            if (
                !terminal?.provider ||
                !settings[terminal.provider].naming.enabled ||
                !settings[terminal.provider].hooks.enabled ||
                this.options.hasForeignHookConflict(terminal.provider)
            ) {
                slot.revision += 1;
                slot.latest = undefined;
                slot.controller?.abort();
            }
        }
    }

    async close(): Promise<void> {
        if (this.closed) {
            await Promise.allSettled(
                this.slots.values().flatMap((slot) => (slot.running ? [slot.running] : [])),
            );
            return;
        }
        this.closed = true;
        const running = this.slots.values().flatMap((slot) => (slot.running ? [slot.running] : []));
        for (const slot of this.slots.values()) {
            slot.latest = undefined;
            slot.controller?.abort();
        }
        await Promise.allSettled(running);
        this.slots.clear();
    }
}
