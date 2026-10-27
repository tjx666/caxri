import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountInfo, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeWindowUnavailableReason } from '@caxri/protocol';
import { CLAUDE_WINDOW_MINUTES } from '@caxri/protocol';

import { claudePlanLimits, withTimeout } from '../agent-chat';
import { CAXRI_CLAUDE_ENTRYPOINT } from '../agents';

const ACCOUNT_TIMEOUT_MS = 20_000;
const USAGE_TIMEOUT_MS = 10_000;
const TRIGGER_TIMEOUT_MS = 120_000;
const WEEK_MINUTES = 10_080;

/**
 * Plans whose 5-hour window a request may start. Claude Code's `/usage` answer names the plan (`pro`, `max`); any other
 * value, including a Team or Enterprise seat whose billing Caxri cannot confirm, fails closed.
 */
const SUBSCRIPTION_PLANS = new Set(['pro', 'max']);

/**
 * Environment that would route Claude Code to an API key, a third-party provider, or another endpoint, where a request
 * could bill API credits instead of starting a subscription window. Their presence alone pauses the keeper; their
 * values are never read.
 */
const NON_SUBSCRIPTION_ENVIRONMENT = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/**
 * The prompt of the minimal request. It is sent only to an idle window and never persisted (`persistSession: false`).
 */
const TRIGGER_PROMPT = 'Reply with OK.';

export interface ClaudeAccountReading {
    /**
     * SHA-256 of the account's organization and email; the only form of the identity Caxri keeps.
     */
    identity: string;
    planType: string;
    /**
     * When the active 5-hour window resets; absent for an idle window.
     */
    windowResetsAt?: number;
    isWeeklyLimitReached: boolean;
}

export type ClaudeAccountProbe =
    | { ok: true; reading: ClaudeAccountReading }
    | { ok: false; reason: ClaudeWindowUnavailableReason };

/**
 * One short-lived Claude Code process: it reads the account and its windows any number of times and sends at most the
 * one minimal request. Nothing it does appears in a Session, Chat, Terminal, or Claude's resume list.
 */
export interface ClaudeWindowSession {
    read(): Promise<ClaudeAccountProbe>;
    /**
     * Sends the minimal request and resolves when its turn ended; `false` when it failed or timed out.
     */
    trigger(): Promise<boolean>;
    close(): Promise<void>;
}

export type OpenClaudeWindowSession = () => Promise<ClaudeWindowSession>;

/**
 * The billing gate over Claude Code's account answer. Only a first-party claude.ai sign-in qualifies: an API key or
 * helper reports an `apiKeySource`, a long-lived token reports a `tokenSource`, and a third-party provider or gateway
 * reports another `apiProvider`.
 */
export function accountGate(
    account: AccountInfo | undefined,
    environment: Readonly<Record<string, string | undefined>>,
): { identity: string } | { reason: ClaudeWindowUnavailableReason } {
    if (NON_SUBSCRIPTION_ENVIRONMENT.some((name) => environment[name] !== undefined))
        return { reason: 'authUnsupported' };
    if (!account) return { reason: 'notSignedIn' };
    if (
        account.apiProvider !== 'firstParty' ||
        (account.apiKeySource !== undefined && account.apiKeySource !== 'none') ||
        account.tokenSource !== undefined
    )
        return { reason: 'authUnsupported' };
    if (!account.email || !account.organization) return { reason: 'notSignedIn' };
    const identity = createHash('sha256')
        .update(`${account.organization}\n${account.email}`)
        .digest('hex');
    return { identity };
}

/**
 * The window reading in a `/usage` answer (untrusted), or the reason it cannot be used. A missing 5-hour window means
 * the reading is unavailable, not that the window is idle: Claude Code reports `rate_limits: null` while its usage
 * fetch fails, for example under `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
 */
export function usageReading(
    answer: unknown,
    now: number,
):
    | { planType: string; windowResetsAt?: number; isWeeklyLimitReached: boolean }
    | { reason: ClaudeWindowUnavailableReason } {
    const limits = claudePlanLimits(answer, now);
    const five = limits?.windows.find((window) => window.windowMinutes === CLAUDE_WINDOW_MINUTES);
    if (!limits || !five) return { reason: 'usageUnavailable' };
    if (!limits.planType || !SUBSCRIPTION_PLANS.has(limits.planType))
        return { reason: 'planUnsupported' };
    const week = limits.windows.find((window) => window.windowMinutes === WEEK_MINUTES);
    return {
        planType: limits.planType,
        ...(five.resetsAt !== undefined &&
            five.resetsAt > now && { windowResetsAt: five.resetsAt }),
        isWeeklyLimitReached: (week?.usedPercent ?? 0) >= 100,
    };
}

export interface SdkSessionOptions {
    executable: string;
    environment: Record<string, string | undefined>;
    clientVersion: string;
    /**
     * Replaces the SDK's `query` in tests.
     */
    query?: (parameters: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;
    now?: () => number;
}

/**
 * Opens a Claude Code process through the Agent SDK in an empty temporary directory, with streaming input so the
 * account and usage can be read before any message is sent. It loads no settings, Project instructions, MCP servers,
 * tools, or slash commands, runs the low-cost model at low effort for one turn, and persists no session.
 */
export async function openSdkSession(options: SdkSessionOptions): Promise<ClaudeWindowSession> {
    const now = options.now ?? Date.now;
    const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-window-'));
    const input = new MessageQueue();
    const abort = new AbortController();
    const query = (options.query ?? sdkQuery)({
        prompt: input,
        options: {
            cwd: directory,
            pathToClaudeCodeExecutable: options.executable,
            env: {
                ...options.environment,
                CLAUDE_AGENT_SDK_CLIENT_APP: `caxri/${options.clientVersion}`,
                CLAUDE_CODE_ENTRYPOINT: CAXRI_CLAUDE_ENTRYPOINT,
            },
            abortController: abort,
            persistSession: false,
            settingSources: [],
            strictMcpConfig: true,
            mcpServers: {},
            tools: [],
            maxTurns: 1,
            model: 'haiku',
            effort: 'low',
            systemPrompt: TRIGGER_PROMPT,
            extraArgs: { 'disable-slash-commands': null, 'no-chrome': null },
            stderr: () => {},
        },
    });
    const turnEnded = turnEnds(query);
    return {
        read: async () => {
            let account: AccountInfo | undefined;
            try {
                account = await withTimeout(query.accountInfo(), ACCOUNT_TIMEOUT_MS);
            } catch {
                return { ok: false, reason: 'probeFailed' };
            }
            const gate = accountGate(account, options.environment);
            if ('reason' in gate) return { ok: false, reason: gate.reason };
            let answer: unknown;
            try {
                answer = await withTimeout(
                    query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
                        skipBehaviors: true,
                    }),
                    USAGE_TIMEOUT_MS,
                );
            } catch {
                return { ok: false, reason: 'usageUnavailable' };
            }
            const usage = usageReading(answer, now());
            if ('reason' in usage) return { ok: false, reason: usage.reason };
            return { ok: true, reading: { identity: gate.identity, ...usage } };
        },
        trigger: async () => {
            input.push({
                type: 'user',
                message: { role: 'user', content: TRIGGER_PROMPT },
                parent_tool_use_id: null,
            });
            try {
                return await withTimeout(turnEnded.next(), TRIGGER_TIMEOUT_MS);
            } catch {
                return false;
            }
        },
        close: async () => {
            input.end();
            abort.abort();
            query.close();
            await rm(directory, { recursive: true, force: true });
        },
    };
}

/**
 * Resolves each turn's result in order, reading the message stream in the background so the control requests keep
 * flowing. Breaking out of the SDK's iterator would close the query, so it is consumed to the end instead.
 */
function turnEnds(query: Query): { next(): Promise<boolean> } {
    const waiting: Array<(isSuccess: boolean) => void> = [];
    let hasEnded = false;
    void (async () => {
        try {
            for await (const message of query)
                if (message.type === 'result') waiting.shift()?.(!message.is_error);
        } catch {
            // The process ended; any waiting turn fails below.
        }
        hasEnded = true;
        for (const resolve of waiting) resolve(false);
        waiting.length = 0;
    })();
    return {
        next: () =>
            new Promise((resolve) => {
                if (hasEnded) resolve(false);
                else waiting.push(resolve);
            }),
    };
}

/**
 * The streaming input of the SDK session: it stays open, so the process keeps answering control requests, until
 * `end()`.
 */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
    private readonly messages: SDKUserMessage[] = [];
    private wake: (() => void) | undefined;
    private isEnded = false;

    push(message: SDKUserMessage): void {
        this.messages.push(message);
        this.wake?.();
    }

    end(): void {
        this.isEnded = true;
        this.wake?.();
    }

    async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        while (true) {
            const message = this.messages.shift();
            if (message) {
                yield message;
                continue;
            }
            if (this.isEnded) return;
            // eslint-disable-next-line no-await-in-loop -- the input stays open until the next message or end()
            await new Promise<void>((resolve) => {
                this.wake = resolve;
            });
            this.wake = undefined;
        }
    }
}
