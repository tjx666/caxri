import type { LogLevel } from '../domain/business-contract.js';
import { logLevelSchema } from '../domain/business-contract.js';

/**
 * Environment variable every Caxri process reads to override its compiled-in log level. Desktop Main forwards it to
 * Server Core through the launch allow-list, and Server Core forwards it to the Extension and Terminal Hosts, so
 * exporting it once before launch brings all four logs to the same level.
 */
export const LOG_LEVEL_ENVIRONMENT_KEY = 'CAXRI_LOG_LEVEL';

/**
 * Environment variable that attaches Node's inspector to the Hosts. `1` uses Node's own default base port, any other
 * port number moves the base, and unset or `0` leaves every Host without an inspector — which is the shipped behavior.
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

export interface ResolveLogLevelOptions {
    environment: Record<string, string | undefined>;
    /**
     * Level to keep when the environment asks for nothing usable. This stays the process's compiled-in default, so a
     * packaged build is never noisier than it is today unless an operator opts in.
     */
    fallback: LogLevel;
}

/**
 * A packaged build records `info` and above, which silently drops every per-request `ipc.request` record — exactly the
 * timing and queue-depth detail a production-only failure needs. Reading the level from the environment makes that
 * detail recoverable without a rebuild, and an unrecognized value keeps the shipped default, so the extra serialization
 * and log volume are only ever paid by a session that asked for them.
 */
export function resolveLogLevel({ environment, fallback }: ResolveLogLevelOptions): LogLevel {
    const requested = logLevelSchema.safeParse(
        environment[LOG_LEVEL_ENVIRONMENT_KEY]?.trim().toLowerCase(),
    );
    return requested.success ? requested.data : fallback;
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
    if (!requested || requested === '0') return undefined;
    if (requested === '1') return DEFAULT_INSPECT_BASE_PORT;
    const port = Number(requested);
    return Number.isSafeInteger(port) && port >= 1024 && port <= 65_535 ? port : undefined;
}

/**
 * Node inspector argv for one Host, or nothing when no operator asked for one.
 *
 * Always `--inspect`, never `--inspect-brk`: a Host paused before its first line never answers the readiness handshake
 * its supervisor is waiting on, so the app would look hung rather than debuggable. The inspector keeps Node's default
 * loopback bind, so enabling it never opens a port to the network.
 */
export function inspectExecArgv(
    host: InspectableHost,
    environment: Record<string, string | undefined>,
): string[] {
    const base = resolveInspectBasePort(environment);
    return base === undefined ? [] : [`--inspect=${base + INSPECT_PORT_OFFSETS[host]}`];
}
