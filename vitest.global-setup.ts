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
}

export function removeHostAgentEnvironment(environment: NodeJS.ProcessEnv): void {
    for (const name of HOST_AGENT_ENVIRONMENT) delete environment[name];
}
