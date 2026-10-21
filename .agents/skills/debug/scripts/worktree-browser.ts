/**
 * Runs one `agent-browser` command against this worktree's running dev instance with the three rules `debug` requires
 * on every call already applied: proxy variables stripped, a session name unique to this worktree, and the port read
 * from the `switch-worktree dev` process record. Before the command runs it checks that `globalThis.__caxriWorktree`
 * names this checkout, so a sibling worktree's window can never answer.
 *
 * Usage: `bun run .agents/skills/debug/scripts/worktree-browser.ts <agent-browser arguments...>`
 */
import process from 'node:process';

import { execFileAsync } from '../../../../scripts/exec';
import { CommandError, runInherited } from '../../switch-worktree/scripts/process';
import { repoContext, worktreeIdentity } from '../../switch-worktree/scripts/repo';
import { readDevelopmentProcess } from '../../switch-worktree/scripts/worktree-development-process';

/**
 * Agent-browser honors these but ignores `NO_PROXY`, and with any of them set it attaches to its own headless Chrome
 * instead of Caxri.
 */
const PROXY_VARIABLES = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
] as const;

export interface BrowserTarget {
    cdpPort: number;
    worktreeId: string;
}

export function browserEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const result = { ...environment };
    for (const name of PROXY_VARIABLES) delete result[name];
    return result;
}

/**
 * The session is derived from the worktree identity, so two agents in different worktrees never share a daemon and
 * repeated calls from one worktree reuse the same attachment.
 */
export function browserArguments(target: BrowserTarget, commandArguments: string[]): string[] {
    return [
        '--session',
        `caxri-${target.worktreeId.slice(0, 8)}`,
        '--cdp',
        String(target.cdpPort),
        ...commandArguments,
    ];
}

/**
 * `agent-browser eval` prints the evaluated value as JSON; the probe stringifies once more so an absent global prints
 * `undefined` instead of failing to parse.
 */
export function reportedWorktree(evalOutput: string): string | undefined {
    try {
        const outer: unknown = JSON.parse(evalOutput.trim());
        if (typeof outer !== 'string') return undefined;
        const inner: unknown = JSON.parse(outer);
        return typeof inner === 'string' ? inner : undefined;
    } catch {
        return undefined;
    }
}

export async function resolveTarget(cwd: string): Promise<{ root: string; target: BrowserTarget }> {
    const context = await repoContext(cwd);
    const worktreeId = await worktreeIdentity(context.root, false);
    const record = await readDevelopmentProcess(context, worktreeId);
    if (!worktreeId || !record) {
        throw new CommandError(
            'No dev instance recorded for this worktree; start one with `switch-worktree dev`',
        );
    }
    return { root: context.root, target: { cdpPort: record.cdpPort, worktreeId } };
}

async function probeWorktree(
    target: BrowserTarget,
    environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync(
            'agent-browser',
            browserArguments(target, ['eval', 'JSON.stringify(globalThis.__caxriWorktree)']),
            { encoding: 'utf8', env: environment },
        );
        return reportedWorktree(stdout);
    } catch {
        return undefined;
    }
}

async function main(): Promise<number> {
    const commandArguments = process.argv.slice(2);
    if (commandArguments.length === 0) {
        throw new CommandError('Pass the agent-browser command to run, e.g. `snapshot`', 2);
    }
    const { root, target } = await resolveTarget(process.cwd());
    const environment = browserEnvironment(process.env);
    const reached = await probeWorktree(target, environment);
    if (reached !== root) {
        throw new CommandError(
            `CDP port ${target.cdpPort} answered for ${reached ?? 'an unknown window'}, not ${root}`,
        );
    }
    return runInherited('agent-browser', browserArguments(target, commandArguments), {
        cwd: root,
        env: environment,
    });
}

if (import.meta.main) {
    try {
        process.exitCode = await main();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = error instanceof CommandError ? error.exitCode : 1;
    }
}
