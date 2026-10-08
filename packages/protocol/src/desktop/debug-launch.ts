import type { LogLevel } from '../domain/business-contract.js';
import { logLevelSchema } from '../domain/business-contract.js';

/**
 * Environment variable every Caxri process reads to override its compiled-in log level. Desktop Main forwards it to
 * Server Core through the launch allow-list, and Server Core forwards it to the Extension and Terminal Hosts, so
 * exporting it once before launch brings all four logs to the same level.
 */
export const LOG_LEVEL_ENVIRONMENT_KEY = 'CAXRI_LOG_LEVEL';

/**
 * Environment variable that moves or disables the Hosts' Node inspector. Unset or `1` uses the default base port, any
 * other port number moves the base, and `0` turns the inspector off.
 */
export const INSPECT_ENVIRONMENT_KEY = 'CAXRI_INSPECT';

const DEFAULT_INSPECT_BASE_PORT = 9229;

/**
 * Port offset each inspectable Host adds to the base, so all three can be attached at once without colliding. The
 * Renderer is absent because it is already reachable over the Desktop's own CDP endpoint.
 */
const INSPECT_PORT_OFFSETS = {
    'server-core': 0,
    'extension-host': 1,
    'terminal-host': 2,
} as const;

export type InspectableHost = keyof typeof INSPECT_PORT_OFFSETS;

/**
 * Level every Caxri process records when nothing asks for another one. `debug` keeps the per-request `ipc.request`
 * records (the timing and queue-depth detail that a failure report is useless without) and Caxri is built by coding
 * agents whose only view of a past failure is the log it left behind, so a build that has to be relaunched with an
 * environment variable before it explains itself costs an entire iteration.
 */
const DEFAULT_LOG_LEVEL: LogLevel = 'debug';

/**
 * Log level for one process, from the environment. An unrecognized value falls back to {@link DEFAULT_LOG_LEVEL}, so a
 * typo never silently quiets a log; `CAXRI_LOG_LEVEL=info` (or higher) is how a session opts out of the detail.
 */
export function resolveLogLevel(environment: Record<string, string | undefined>): LogLevel {
    const requested = logLevelSchema.safeParse(
        environment[LOG_LEVEL_ENVIRONMENT_KEY]?.trim().toLowerCase(),
    );
    return requested.success ? requested.data : DEFAULT_LOG_LEVEL;
}

/**
 * Child-process environment fragment that forwards an active override. Empty when none is set, so the child keeps its
 * own default instead of inheriting the literal string `undefined`.
 */
export function logLevelEnvironment(
    environment: Record<string, string | undefined>,
): Record<string, string> {
    const requested = environment[LOG_LEVEL_ENVIRONMENT_KEY];
    return requested ? { [LOG_LEVEL_ENVIRONMENT_KEY]: requested } : {};
}

function resolveInspectBasePort(
    environment: Record<string, string | undefined>,
): number | undefined {
    const requested = environment[INSPECT_ENVIRONMENT_KEY]?.trim();
    if (requested === '0') return undefined;
    if (!requested || requested === '1') return DEFAULT_INSPECT_BASE_PORT;
    const port = Number(requested);
    return Number.isSafeInteger(port) && port >= 1024 && port <= 65_535
        ? port
        : DEFAULT_INSPECT_BASE_PORT;
}

/**
 * Node inspector argv for one Host, unless `CAXRI_INSPECT=0` turned it off.
 *
 * On by default because attaching a debugger otherwise costs a full relaunch, and a Host only reproduces the state
 * worth inspecting after the session that produced it: by the time an agent knows it needs the inspector, the process
 * it wanted is gone. Node binds the inspector to loopback and does nothing until a client attaches, and a port already
 * taken by a sibling checkout only logs one line and keeps running, so an always-open port costs nothing until used.
 *
 * Always `--inspect`, never `--inspect-brk`: a Host paused before its first line never answers the readiness handshake
 * its supervisor is waiting on, so the app would look hung rather than debuggable.
 */
export function inspectExecArgv(
    host: InspectableHost,
    environment: Record<string, string | undefined>,
): string[] {
    const base = resolveInspectBasePort(environment);
    return base === undefined ? [] : [`--inspect=${base + INSPECT_PORT_OFFSETS[host]}`];
}

/**
 * The parent's `execArgv` minus its own inspector flags, for a child that inherits the rest of the parent's Node
 * options. Server Core runs with `--inspect=9229`; forwarding that next to the child's own `--inspect=9230` hands one
 * process two inspector ports and makes which one it binds depend on Node's flag precedence.
 */
export function inheritedExecArgv(execArgv: readonly string[]): string[] {
    return execArgv.filter((argument) => !/^--inspect(?:-brk|-port|-wait)?(?:=|$)/.test(argument));
}
