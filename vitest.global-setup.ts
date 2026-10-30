import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { assertFullSuiteAuthorized } from './.agents/skills/quality-check/scripts/full-suite-authorization.ts';

/**
 * Variables a Caxri Host puts into every Agent Terminal it launches (`AgentEndpointLifecycle`'s launch environment). An
 * agent running Vitest inside Caxri inherits them, and fixtures that spread `process.env` would then see a Caxri CLI
 * that CI never has: `CAXRI_CLI` alone adds the Session discovery instructions to every fake Codex thread.
 */
const HOST_AGENT_ENVIRONMENT = [
    'CAXRI_MANAGED_AGENT',
    'CAXRI_AGENT_ENDPOINT_HOST_ID',
    'CAXRI_AGENT_ENDPOINT_ID',
    'CAXRI_AGENT_ENDPOINT_GENERATION',
    'CAXRI_AGENT_ENDPOINT_TOKEN',
    'CAXRI_CLI',
    'CAXRI_CLI_PATH',
    'CAXRI_USER_DATA_DIR',
] as const;

/**
 * Vitest `globalSetup`. Runs once in the CLI's own process, so `process.argv` is the real invocation and a bare `vitest
 * run` is refused the same way `bun run test` is. Workers start after it and inherit its environment, so removing the
 * Host's Agent variables here keeps a local run under a Caxri Agent identical to CI.
 */
export default function setup(): void {
    assertFullSuiteAuthorized('unit');
    removeHostAgentEnvironment(process.env);
    const warning = nodeMajorMismatchWarning(
        readFileSync(resolve(import.meta.dirname, 'mise.toml'), 'utf8'),
        process.versions.node,
    );
    if (warning) console.warn(warning);
}

/**
 * Warns, without failing, when Vitest runs under a different Node.js major than `mise.toml` pins (and CI uses). A shell
 * that never activated mise picks up whatever `node` is first on `PATH`, and a newer major changes runtime behavior
 * tests can observe: Node 26's recursive `readdir` follows symlinked folders, so a count that is right on CI's Node 24
 * read wrong only locally. Returns `undefined` when the majors match or `mise.toml` pins no Node version.
 */
export function nodeMajorMismatchWarning(
    miseSource: string,
    runningVersion: string,
): string | undefined {
    const pinned = /^node\s*=\s*"([^"]+)"$/mu.exec(miseSource)?.[1];
    if (!pinned) return undefined;
    const pinnedMajor = pinned.split('.', 1)[0];
    if (pinnedMajor === runningVersion.split('.', 1)[0]) return undefined;
    return (
        `vitest: running on Node.js ${runningVersion}, but mise.toml pins ${pinned} (CI runs the pinned major). ` +
        'Results that depend on Node.js behavior may differ from CI; activate mise or run `mise exec -- bunx vitest`.'
    );
}

export function removeHostAgentEnvironment(environment: NodeJS.ProcessEnv): void {
    for (const name of HOST_AGENT_ENVIRONMENT) delete environment[name];
}
