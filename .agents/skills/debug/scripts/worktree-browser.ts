/**
 * Runs one `agent-browser` command against this worktree's running dev instance with the three rules `debug` requires
 * on every call already applied: proxy variables stripped, a session name unique to this worktree, and the port read
 * from the `switch-worktree dev` process record. Before the command runs it checks that `globalThis.__caxriWorktree`
 * names this checkout, so a sibling worktree's window can never answer.
 *
 * With `--packaged` it reaches the installed app instead: the fixed packaged CDP port (`CAXRI_DEV_CDP_PORT` overrides
 * it), its own session, and a check that the window is a Caxri build no worktree launched.
 *
 * Usage: `bun run .agents/skills/debug/scripts/worktree-browser.ts [--packaged] <agent-browser arguments...>`
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

/**
 * The installed app's Renderer CDP port; see the `debug` skill's Live CDP inspection.
 */
const PACKAGED_CDP_PORT = 9224;

/**
 * Stands in for the worktree identity, so the installed app gets its own `caxri-packaged` session.
 */
const PACKAGED_ID = 'packaged';

export function packagedTarget(environment: NodeJS.ProcessEnv): BrowserTarget {
    const port = Number(environment.CAXRI_DEV_CDP_PORT);
    return {
        cdpPort: Number.isSafeInteger(port) && port > 0 ? port : PACKAGED_CDP_PORT,
        worktreeId: PACKAGED_ID,
    };
}

/**
 * Splits a leading `--packaged` off the command line.
 */
export function parseBrowserArguments(argv: string[]): {
    commandArguments: string[];
    isPackaged: boolean;
} {
    const isPackaged = argv[0] === '--packaged';
    return { commandArguments: isPackaged ? argv.slice(1) : argv, isPackaged };
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

async function probeUserAgent(
    target: BrowserTarget,
    environment: NodeJS.ProcessEnv,
): Promise<string> {
    try {
        const { stdout } = await execFileAsync(
            'agent-browser',
            browserArguments(target, ['eval', 'navigator.userAgent']),
            { encoding: 'utf8', env: environment },
        );
        return stdout;
    } catch {
        return '';
    }
}

/**
 * Resolves and verifies the window a command may reach: this worktree's dev instance, or with `isPackaged` the
 * installed app, which must report a Caxri build and no worktree.
 */
export async function verifiedTarget(
    cwd: string,
    isPackaged: boolean,
): Promise<{ cwd: string; environment: NodeJS.ProcessEnv; target: BrowserTarget }> {
    const environment = browserEnvironment(process.env);
    if (isPackaged) {
        const target = packagedTarget(process.env);
        // One after the other: two first calls racing on a new session can each find no daemon attached yet.
        const userAgent = await probeUserAgent(target, environment);
        const reached = await probeWorktree(target, environment);
        if (reached !== undefined || !/\bCaxri\//u.test(userAgent)) {
            throw new CommandError(
                `CDP port ${target.cdpPort} did not answer as the installed Caxri app`,
            );
        }
        return { cwd, environment, target };
    }
    const { root, target } = await resolveTarget(cwd);
    const reached = await probeWorktree(target, environment);
    if (reached !== root) {
        throw new CommandError(
            `CDP port ${target.cdpPort} answered for ${reached ?? 'an unknown window'}, not ${root}`,
        );
    }
    return { cwd: root, environment, target };
}

async function main(): Promise<number> {
    const { commandArguments, isPackaged } = parseBrowserArguments(process.argv.slice(2));
    if (commandArguments.length === 0) {
        throw new CommandError('Pass the agent-browser command to run, e.g. `snapshot`', 2);
    }
    const { cwd, environment, target } = await verifiedTarget(process.cwd(), isPackaged);
    return runInherited('agent-browser', browserArguments(target, commandArguments), {
        cwd,
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
