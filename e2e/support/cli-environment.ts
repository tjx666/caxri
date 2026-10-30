import { execFile } from 'node:child_process';
import process from 'node:process';

/**
 * The Agent Endpoint credential a Caxri-managed Agent receives. The CLI prefers it over `--profile`.
 */
const agentEndpointKeys = [
    'CAXRI_AGENT_ENDPOINT_HOST_ID',
    'CAXRI_AGENT_ENDPOINT_ID',
    'CAXRI_AGENT_ENDPOINT_GENERATION',
    'CAXRI_AGENT_ENDPOINT_TOKEN',
    'CAXRI_MANAGED_AGENT',
] as const;

/**
 * Environment for a `caxri` CLI call made by the Playwright runner itself, not by an Agent inside the app.
 *
 * When the suite runs from an Agent Session of an installed Caxri, the runner inherits that Session's Agent Endpoint
 * credential, and the CLI then authenticates against the test Server with a token it never issued
 * (`hello-agent-auth-failed`, surfaced as `UNAVAILABLE`).
 */
export function runnerCliEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const key of agentEndpointKeys) delete environment[key];
    return environment;
}

/**
 * Runs the built `caxri` CLI from the Playwright runner with {@link runnerCliEnvironment}, resolving its exit code and
 * output instead of rejecting on a non-zero exit.
 */
export function runRunnerCli(
    cliPath: string,
    arguments_: readonly string[],
): Promise<{ code: number; stderr: string; stdout: string }> {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [cliPath, ...arguments_],
            { env: runnerCliEnvironment(), maxBuffer: 1024 * 1024, timeout: 10_000 },
            (error, stdout, stderr) => {
                resolve({
                    code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
                    stderr,
                    stdout,
                });
            },
        );
    });
}
