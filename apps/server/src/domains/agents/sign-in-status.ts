import type { AgentProvider } from '@caxri/protocol';
import { readBoundedRegularFileText, readE2EAgentPolicy } from '@caxri/system';

import { runExternalCommand } from '../executables';

/**
 * What a CLI's own status command says about its sign-in. `unknown` covers a provider without such a command, a
 * failure, a timeout, and an answer Caxri does not recognize, so only an explicit "signed out" reaches the menus.
 */
export type AgentSignInStatus = 'signedIn' | 'signedOut' | 'unknown';

interface CommandOutcome {
    /**
     * The exit code, or `undefined` when the command did not exit on its own (spawn failure, timeout, kill).
     */
    exitCode: number | undefined;
    stdout: string;
}

interface SignInCommand {
    arguments_: readonly string[];
    parse: (outcome: CommandOutcome) => AgentSignInStatus;
}

/**
 * `claude auth status --json` prints `{"loggedIn": ...}` and exits 1 when signed out. It already counts an API key or a
 * third-party provider (`ANTHROPIC_API_KEY`, Bedrock, Vertex) from the environment as signed in, so Caxri does not
 * second-guess the authentication method.
 */
export function parseClaudeAuthStatus({ stdout }: CommandOutcome): AgentSignInStatus {
    try {
        const answer = JSON.parse(stdout) as { loggedIn?: unknown };
        if (answer.loggedIn === true) return 'signedIn';
        if (answer.loggedIn === false) return 'signedOut';
    } catch {
        // Not JSON: an older CLI without `auth status`, or an error message.
    }
    return 'unknown';
}

/**
 * `codex login status` exits 0 when signed in and 1 with `Not logged in` when not. Any other failure is unknown.
 */
export function parseCodexLoginStatus({ exitCode, stdout }: CommandOutcome): AgentSignInStatus {
    if (exitCode === 0) return 'signedIn';
    return exitCode === 1 && /not logged in/i.test(stdout) ? 'signedOut' : 'unknown';
}

/**
 * Providers whose CLI answers a sign-in question without starting a conversation. Grok Build and Antigravity have no
 * such command, so their status stays unknown rather than being guessed from files they own.
 */
const SIGN_IN_COMMANDS: Partial<Record<AgentProvider, SignInCommand>> = {
    claude: { arguments_: ['auth', 'status', '--json'], parse: parseClaudeAuthStatus },
    codex: { arguments_: ['login', 'status'], parse: parseCodexLoginStatus },
};

const SIGN_IN_TIMEOUT_MS = 8_000;
/**
 * How long an answer is reused. A user who signs in from a Terminal sees the marker go within this window; the menus
 * ask only when they open, so the status commands run at most this often per provider.
 */
const SIGN_IN_CACHE_MS = 30_000;

type RunCommand = (executable: string, arguments_: readonly string[]) => Promise<CommandOutcome>;

async function runStatusCommand(
    executable: string,
    arguments_: readonly string[],
): Promise<CommandOutcome> {
    try {
        const { stdout } = await runExternalCommand(executable, arguments_, {
            maxBuffer: 64 * 1024,
            timeout: SIGN_IN_TIMEOUT_MS,
        });
        return { exitCode: 0, stdout };
    } catch (error) {
        const failure = error as { code?: unknown; killed?: unknown; stdout?: unknown };
        return {
            exitCode:
                failure.killed !== true && typeof failure.code === 'number'
                    ? failure.code
                    : undefined,
            stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
        };
    }
}

/**
 * E2E seam: fake Agent executables cannot all answer status commands, so under the fake-Agent policy the status comes
 * from an optional `<executable>.sign-in` file (`signedIn` or `signedOut`) instead of running the fake. No file means
 * unknown, which keeps every existing spec free of a marker.
 */
async function readE2ESignInStatus(executable: string): Promise<AgentSignInStatus> {
    try {
        const recorded = (await readBoundedRegularFileText(`${executable}.sign-in`, 64)).trim();
        return recorded === 'signedIn' || recorded === 'signedOut' ? recorded : 'unknown';
    } catch {
        return 'unknown';
    }
}

async function readStatus(
    run: RunCommand,
    executable: string,
    command: SignInCommand,
): Promise<AgentSignInStatus> {
    return command.parse(await run(executable, command.arguments_));
}

export interface AgentSignInProbe {
    read(provider: AgentProvider, executable: string): Promise<AgentSignInStatus>;
}

/**
 * Reads each provider's sign-in status from its CLI on demand, never on the startup path. Concurrent and repeated asks
 * for the same executable within {@link SIGN_IN_CACHE_MS} share one command.
 */
export function createAgentSignInProbe(
    options: {
        isFakeAgents?: () => boolean;
        now?: () => number;
        run?: RunCommand;
    } = {},
): AgentSignInProbe {
    const isFakeAgents = options.isFakeAgents ?? (() => readE2EAgentPolicy()?.mode === 'fake');
    const now = options.now ?? Date.now;
    const run = options.run ?? runStatusCommand;
    const answers = new Map<string, { at: number; status: Promise<AgentSignInStatus> }>();
    return {
        read(provider, executable) {
            const command = SIGN_IN_COMMANDS[provider];
            if (!command) return Promise.resolve('unknown');
            if (isFakeAgents()) return readE2ESignInStatus(executable);
            const key = `${provider}:${executable}`;
            const cached = answers.get(key);
            if (cached && now() - cached.at < SIGN_IN_CACHE_MS) return cached.status;
            const status = readStatus(run, executable, command);
            answers.set(key, { at: now(), status });
            return status;
        },
    };
}
