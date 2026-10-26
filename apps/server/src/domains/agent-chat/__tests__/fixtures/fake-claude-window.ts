/**
 * A Claude subscription account for the fake Claude Code CLI (`fake-claude-cli.ts`), for the 5-hour window keeper. A
 * `claude-window.json` file under `FAKE_CLAUDE_CONTROL_DIR` turns it on: `initialize` then reports its first-party
 * claude.ai sign-in, `get_usage` reports its plan and 5-hour window, and a user message starts a window when none is
 * active, like the real subscription. The file is rewritten with the new reset and the number of requests, which the
 * test reads back.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WINDOW_MS = 5 * 3_600_000;

interface FakeClaudeWindowAccount {
    plan: string;
    email: string;
    organization: string;
    resetsAt?: number;
    requests?: number;
}

function accountPath(): string | undefined {
    const directory = process.env.FAKE_CLAUDE_CONTROL_DIR;
    if (!directory) return undefined;
    const file = path.join(directory, 'claude-window.json');
    return fs.existsSync(file) ? file : undefined;
}

function readAccount(): { file: string; account: FakeClaudeWindowAccount } | undefined {
    const file = accountPath();
    if (!file) return undefined;
    return { file, account: JSON.parse(fs.readFileSync(file, 'utf8')) as FakeClaudeWindowAccount };
}

export function fakeClaudeWindowAccount(): Record<string, unknown> | undefined {
    const account = readAccount()?.account;
    return (
        account && {
            email: account.email,
            organization: account.organization,
            subscriptionType: `Claude ${account.plan}`,
            apiProvider: 'firstParty',
        }
    );
}

export function fakeClaudeWindowUsage(): Record<string, unknown> | undefined {
    const account = readAccount()?.account;
    if (!account) return undefined;
    const now = Date.now();
    const isActive = account.resetsAt !== undefined && account.resetsAt > now;
    return {
        subscription_type: account.plan,
        rate_limits_available: true,
        rate_limits: {
            five_hour: {
                utilization: isActive ? 1 : 0,
                resets_at: isActive ? new Date(account.resetsAt!).toISOString() : null,
            },
            seven_day: {
                utilization: 5,
                resets_at: new Date(now + 3 * 24 * 3_600_000).toISOString(),
            },
        },
    };
}

export function noteFakeClaudeWindowRequest(): void {
    const read = readAccount();
    if (!read) return;
    const { file, account } = read;
    const now = Date.now();
    const resetsAt =
        account.resetsAt !== undefined && account.resetsAt > now
            ? account.resetsAt
            : now + WINDOW_MS;
    fs.writeFileSync(
        file,
        JSON.stringify({ ...account, resetsAt, requests: (account.requests ?? 0) + 1 }),
    );
}
