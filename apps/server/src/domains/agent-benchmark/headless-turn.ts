import type {
    AgentChatItem,
    AgentChatSnapshot,
    AgentChatTurn,
    AgentLaunchSettings,
    BenchmarkEntry,
    BenchmarkFailureReason,
} from '@caxri/protocol';
import {
    emptyAgentChatSnapshot,
    findAgentChatModel,
    MAX_BENCHMARK_FINAL_TEXT_LENGTH,
    resolveAgentChatModelChange,
} from '@caxri/protocol';

import type {
    AgentChatExit,
    AgentChatLaunchOptions,
    AgentChatProviderSession,
    SpawnChatProcess,
} from '../agent-chat';
import { agentChatDrivers, AgentChatStartError, prepareChatLaunch } from '../agent-chat';
import type { HeadlessHost } from './headless-host';
import { createHeadlessHost } from './headless-host';

/**
 * Timeline items that count as one Agent step: a command it ran, a file change it made, or a tool it called.
 */
const STEP_ITEM_TYPES = new Set<AgentChatItem['type']>(['command', 'fileChange', 'toolCall']);
const START_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 10_000;

export interface HeadlessTurnDependencies {
    launch: AgentChatLaunchOptions;
    clientVersion: string;
    spawnProcess?: SpawnChatProcess;
}

export interface HeadlessTurnRequest {
    /**
     * Stands in for the Terminal id a Chat driver keys its logs and projection by; never a real Terminal.
     */
    id: string;
    entry: BenchmarkEntry;
    prompt: string;
    cwd: string;
    launch: AgentLaunchSettings;
    timeoutMs: number;
    signal: AbortSignal;
    /**
     * Runs on every new step and once when the turn starts, so a live view can show progress.
     */
    onProgress?(progress: { steps: number; startedAt?: number }): void;
}

export interface HeadlessTurnOutcome {
    status: 'completed' | 'failed' | 'timedOut' | 'cancelled';
    failureReason?: BenchmarkFailureReason;
    failureMessage?: string;
    startedAt?: number;
    durationMs?: number;
    steps: number;
    finalText?: string;
    agentSessionId?: string;
    resolvedModel?: string;
    resolvedEffort?: string;
}

type TurnEnd =
    | { kind: 'turn'; status: AgentChatTurn['status'] }
    | { kind: 'exit'; exit: AgentChatExit }
    | { kind: 'timeout' }
    | { kind: 'cancel' };

class TurnFailure extends Error {
    constructor(
        readonly reason: BenchmarkFailureReason,
        message: string,
    ) {
        super(message);
    }
}

/**
 * Runs one prompt as a single Agent turn through the provider's Agent Chat driver, with no Session, Terminal, or
 * database row behind it: the projection lives only in this call. Driving the same driver Agent Chat uses keeps one
 * protocol implementation per provider, so a Benchmark measures exactly what a Chat would run.
 *
 * Approvals are accepted and questions answered empty, since nobody is watching; the autonomy flag in `launch` already
 * keeps both rare. Resolves with a closed outcome and never rejects.
 */
export async function runHeadlessTurn(
    dependencies: HeadlessTurnDependencies,
    request: HeadlessTurnRequest,
): Promise<HeadlessTurnOutcome> {
    const { entry } = request;
    let headless: HeadlessHost | undefined;
    const snapshot = () => headless?.snapshot() ?? emptyAgentChatSnapshot(request.id);
    const stepIds = new Set<string>();
    let startedAt: number | undefined;
    let session: AgentChatProviderSession | undefined;
    const answered = new Set<string>();
    const { promise: ended, resolve: settle } = Promise.withResolvers<TurnEnd>();
    const answerRequests = () => {
        for (const pending of snapshot().requests) {
            if (!session || answered.has(pending.id)) continue;
            answered.add(pending.id);
            session.respond(
                pending.id,
                pending.kind === 'question'
                    ? { kind: 'answers', answers: {} }
                    : { kind: 'decision', decision: 'accept' },
            );
        }
    };
    const outcome = (
        status: HeadlessTurnOutcome['status'],
        extra: Partial<HeadlessTurnOutcome> = {},
    ): HeadlessTurnOutcome => ({
        status,
        steps: stepIds.size,
        ...(startedAt !== undefined && { startedAt }),
        ...(headless?.agentSessionId() && { agentSessionId: headless.agentSessionId() }),
        ...resolvedSettings(snapshot(), entry),
        ...extra,
    });
    const onAbort = () => settle({ kind: 'cancel' });
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) return outcome('cancelled');
    let timer: NodeJS.Timeout | undefined;
    try {
        const driver = agentChatDrivers[entry.provider];
        if (!driver) throw new TurnFailure('startFailed', 'This Agent has no structured driver');
        const prepared = await prepareChatLaunch(
            dependencies.launch,
            entry.provider,
            request.launch,
            request.cwd,
        );
        headless = createHeadlessHost(request.id, prepared, request.launch, dependencies, {
            applied: (operations) => {
                const before = stepIds.size;
                for (const operation of operations)
                    if (operation.op === 'upsertItem' && STEP_ITEM_TYPES.has(operation.item.type))
                        stepIds.add(operation.item.id);
                if (stepIds.size !== before)
                    request.onProgress?.({ steps: stepIds.size, startedAt });
                if (snapshot().requests.length > 0) answerRequests();
            },
            turnFinished: (status) => settle({ kind: 'turn', status }),
            exited: (exit) => settle({ kind: 'exit', exit }),
        });
        session = driver.create(headless.host);
        const started = await raceStart(session.start(), ended);
        if (started !== 'started' && started !== 'resumed') return endWithoutTurn(started);
        await applyEffort(session, snapshot(), entry);
        timer = setTimeout(() => settle({ kind: 'timeout' }), request.timeoutMs);
        startedAt = Date.now();
        request.onProgress?.({ steps: 0, startedAt });
        const sent = await Promise.race([session.send({ text: request.prompt }), ended]);
        const end = sent ?? (await ended);
        const durationMs = Date.now() - startedAt;
        if (end.kind === 'turn') {
            if (end.status === 'completed')
                return outcome('completed', { durationMs, ...finalText(snapshot()) });
            return outcome('failed', {
                durationMs,
                failureReason: 'turnFailed',
                failureMessage: lastNotice(snapshot()) ?? `The turn ended as ${end.status}`,
                ...finalText(snapshot()),
            });
        }
        return endWithoutTurn(end, durationMs);
    } catch (error) {
        return outcome('failed', failureOf(error));
    } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
        if (session) await closeQuietly(session);
    }

    function endWithoutTurn(end: TurnEnd, durationMs?: number): HeadlessTurnOutcome {
        const timing = durationMs === undefined ? {} : { durationMs };
        if (end.kind === 'cancel')
            return outcome('cancelled', { ...timing, ...finalText(snapshot()) });
        if (end.kind === 'timeout')
            return outcome('timedOut', {
                ...timing,
                failureMessage: `No answer within ${Math.round(request.timeoutMs / 60_000)} minutes`,
                ...finalText(snapshot()),
            });
        return outcome('failed', {
            ...timing,
            failureReason: 'processExited',
            failureMessage: lastNotice(snapshot()) ?? 'The Agent process exited before it answered',
        });
    }
}

/**
 * The provider's start, bounded, and abandoned early when the run is cancelled or the process dies first.
 */
async function raceStart(
    start: Promise<'resumed' | 'started'>,
    ended: Promise<TurnEnd>,
): Promise<'resumed' | 'started' | TurnEnd> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new TurnFailure('startFailed', 'The Agent did not start in time')),
            START_TIMEOUT_MS,
        );
    });
    try {
        return await Promise.race([start, ended, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Applies the Entry's effort where a provider takes it only after start (Claude Code). Codex and Grok Build already
 * received it at launch; switching again through the listed models keeps the request validated either way.
 */
async function applyEffort(
    session: AgentChatProviderSession,
    snapshot: AgentChatSnapshot,
    entry: BenchmarkEntry,
): Promise<void> {
    if (entry.provider !== 'claude' || !entry.effort || !session.configure) return;
    if (!findAgentChatModel(snapshot.models, entry.model))
        throw new TurnFailure('modelUnavailable', `${entry.model} is not offered by this Agent`);
    try {
        await session.configure(
            resolveAgentChatModelChange(snapshot, { model: entry.model, effort: entry.effort }),
        );
    } catch (error) {
        throw new TurnFailure(
            'modelUnavailable',
            error instanceof Error ? error.message : 'The Agent refused this model or effort',
        );
    }
}

function resolvedSettings(
    snapshot: AgentChatSnapshot,
    entry: BenchmarkEntry,
): Pick<HeadlessTurnOutcome, 'resolvedEffort' | 'resolvedModel'> {
    const model = snapshot.model && snapshot.model !== entry.model ? snapshot.model : undefined;
    return {
        ...(model && { resolvedModel: model.slice(0, 200) }),
        ...(snapshot.effort && { resolvedEffort: snapshot.effort }),
    };
}

/**
 * The Agent's last message, which is its answer; earlier messages are commentary between tool calls.
 */
function finalText(snapshot: AgentChatSnapshot): Pick<HeadlessTurnOutcome, 'finalText'> {
    const message = snapshot.items.findLast(
        (item): item is Extract<AgentChatItem, { type: 'agentMessage' }> =>
            item.type === 'agentMessage' && item.text.trim().length > 0,
    );
    if (!message) return {};
    const text = message.text.trim();
    return {
        finalText:
            text.length > MAX_BENCHMARK_FINAL_TEXT_LENGTH
                ? `${text.slice(0, MAX_BENCHMARK_FINAL_TEXT_LENGTH)}\n\n[Answer truncated]`
                : text,
    };
}

function lastNotice(snapshot: AgentChatSnapshot): string | undefined {
    const notice = snapshot.items.findLast(
        (item): item is Extract<AgentChatItem, { type: 'notice' }> =>
            item.type === 'notice' && item.kind === 'error' && Boolean(item.message),
    );
    return notice?.message?.slice(0, 2_000) ?? snapshot.failure?.detail;
}

function failureOf(error: unknown): Pick<HeadlessTurnOutcome, 'failureMessage' | 'failureReason'> {
    if (error instanceof TurnFailure)
        return { failureReason: error.reason, failureMessage: error.message };
    if (error instanceof AgentChatStartError)
        return {
            failureReason:
                error.reason === 'executable_not_found' ? 'executableNotFound' : 'startFailed',
            failureMessage: error.detail ?? 'The Agent did not start',
        };
    return {
        failureReason: 'startFailed',
        failureMessage:
            error instanceof Error ? error.message.slice(0, 2_000) : 'The Agent did not start',
    };
}

async function closeQuietly(session: AgentChatProviderSession): Promise<void> {
    try {
        await Promise.race([
            session.close(),
            new Promise((resolve) => {
                setTimeout(resolve, CLOSE_TIMEOUT_MS).unref();
            }),
        ]);
    } catch {
        // The process is gone or going; nothing else holds it.
    }
}
