import type { TerminalRecord, UsageLimit } from '@caxri/protocol';

import { agentProviderStateRoot, readAntigravityUsage } from '../../../agents';
import { prepareChatLaunch } from '../../chat-launch';
import type { AgentChatProviderSession } from '../../chat-provider';
import type { AgentChatServiceOptions } from '../../service-options';
import { AntigravityPlanLimits } from './plan-limits';

type PlanLimitsReading = Omit<UsageLimit, 'provider'>;

type StandingOptions = Pick<
    AgentChatServiceOptions,
    'agentEnvironment' | 'environment' | 'resolveExecutable' | 'launchSettings'
>;

/**
 * Antigravity's plan windows for an Antigravity Terminal with no running Chat: a PTY `agy`, or a Chat that stopped or
 * never started. `agy -p /usage` answers without a conversation and spends no quota, so the status bar keeps showing
 * the account's limits instead of only while a Chat runs. One reader serves every such Terminal, since the windows
 * belong to the account; it reuses a reading as {@link AntigravityPlanLimits} does and runs nothing but that command.
 */
class AntigravityStandingPlanLimits {
    /**
     * The Terminal the next `/usage` run takes its launch settings and directory from: the one last asked about.
     */
    private terminal: TerminalRecord | undefined;

    private readonly limits = new AntigravityPlanLimits(() => this.run());

    constructor(private readonly options: StandingOptions) {}

    private async run() {
        const { terminal } = this;
        if (!terminal) return { status: 'unknown' as const };
        try {
            const prepared = await prepareChatLaunch(
                this.options,
                'antigravity',
                this.options.launchSettings('antigravity', terminal),
                agentProviderStateRoot(terminal),
            );
            return await readAntigravityUsage({
                executable: prepared.executable,
                cwd: prepared.cwd,
                env: prepared.environment,
            });
        } catch {
            // No `agy` to run, or a directory that moved: the quota stays unknown and is read again shortly.
            return { status: 'unknown' as const };
        }
    }

    read(terminal: TerminalRecord): Promise<PlanLimitsReading | undefined> {
        this.terminal = terminal;
        return this.limits.read();
    }
}

/**
 * One standing reader per Chat service, so its reuse window spans every Terminal the status bar asks about.
 */
const standingReaders = new WeakMap<object, AntigravityStandingPlanLimits>();

/**
 * Plan rate limits for one Terminal: from its running Chat when it has one, never starting one; otherwise, for an
 * Antigravity Terminal, from `/usage` directly ({@link AntigravityStandingPlanLimits}).
 */
export function readChatPlanLimits(
    options: StandingOptions & Pick<AgentChatServiceOptions, 'database'>,
    session: AgentChatProviderSession | undefined,
    terminalId: string,
): Promise<PlanLimitsReading | undefined> {
    if (session?.isOpen) return session.readPlanLimits?.() ?? Promise.resolve(undefined);
    const terminal = options.database.getTerminal(terminalId);
    if (terminal?.provider !== 'antigravity') return Promise.resolve(undefined);
    let reader = standingReaders.get(options);
    if (!reader) {
        reader = new AntigravityStandingPlanLimits(options);
        standingReaders.set(options, reader);
    }
    return reader.read(terminal);
}
