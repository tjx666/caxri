import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

import { CommandError } from './process';
import { errorCode } from './repo';

/**
 * Kept clear of the fixed default CDP ports (`apps/desktop/src/main/desktop-profile.ts` uses 9223 for dev, 9224
 * packaged) and of the Node inspector range (9229-9231, shiftable as a block via `CAXRI_INSPECT`), so a bare `bun run
 * dev` outside this wrapper always lands on the documented 9223 default without risk of a wrapper-managed sibling
 * worktree taking it.
 *
 * @see https://github.com/tjx666/caxri/issues/1016
 */
export const CDP_PORT_BASE = 9300;
export const CDP_PORT_RANGE = 400;

/**
 * Deterministically derives a worktree's preferred CDP port from its stable identity: the same UUID `ensureProfile`
 * (see `repo.ts`) keys the isolated `userData` profile on. Two `switch-worktree dev` runs for the same worktree land on
 * the same preferred port across restarts, so an agent's `debug`-skill connection instructions stay valid between runs
 * instead of having to be re-read every time.
 */
export function derivePreferredCdpPort(identity: string): number {
    const digest = createHash('sha256').update(identity).digest();
    const value = digest.readUInt32BE(0);
    return CDP_PORT_BASE + (value % CDP_PORT_RANGE);
}

export interface CdpPortProbe {
    isAvailable(port: number): Promise<boolean>;
}

/**
 * Binds and immediately releases a real TCP listener on `port` to detect a live occupant (including a sibling
 * worktree's Electron instance still holding its port, or any unrelated local process) rather than trusting a recorded
 * port that may be stale.
 */
const defaultCdpPortProbe: CdpPortProbe = {
    isAvailable(port) {
        return new Promise((resolve, reject) => {
            const server = createServer();
            server.once('error', (error: Error) => {
                if (errorCode(error) === 'EADDRINUSE') resolve(false);
                else reject(error);
            });
            server.listen(port, '127.0.0.1', () => {
                server.close((closeError) => {
                    if (closeError) reject(closeError);
                    else resolve(true);
                });
            });
        });
    },
};

/**
 * Honors an explicit `CAXRI_DEV_CDP_PORT` the caller already set (e.g. a skill pinning a fixed, reproducible port for
 * an audit run) instead of silently overriding it with the derived port. Mirrors `desktop-profile.ts`'s treatment of an
 * exported-but-empty value as "not set".
 */
export function explicitCdpPort(environment: NodeJS.ProcessEnv): number | undefined {
    const raw = environment.CAXRI_DEV_CDP_PORT;
    if (raw === undefined || raw === '') return undefined;
    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port <= 0) {
        throw new CommandError(`Invalid CAXRI_DEV_CDP_PORT: ${raw}`);
    }
    return port;
}

/**
 * Resolves a worktree's CDP port: start from its deterministic preferred port and, when that port is occupied, advance
 * within the fixed range so a colliding preferred port (or a leftover process still holding it) still yields a
 * distinct, live port instead of failing to start. The probe is injectable so a unit test can force specific ports
 * "busy" without binding real sockets. Callers that must honor an explicit `CAXRI_DEV_CDP_PORT` override should check
 * {@link explicitCdpPort} first: this function always derives and probes.
 */
export async function resolveWorktreeCdpPort(
    identity: string,
    probe: CdpPortProbe = defaultCdpPortProbe,
): Promise<number> {
    const preferred = derivePreferredCdpPort(identity);
    // Each attempt's target port depends on knowing every earlier offset in this range was
    // unavailable, so the probe is inherently sequential and cannot be parallelized.
    /* eslint-disable no-await-in-loop -- sequential port probe, see comment above */
    for (let offset = 0; offset < CDP_PORT_RANGE; offset += 1) {
        const port = CDP_PORT_BASE + ((preferred - CDP_PORT_BASE + offset) % CDP_PORT_RANGE);
        if (await probe.isAvailable(port)) return port;
    }
    /* eslint-enable no-await-in-loop */
    throw new CommandError(
        `Could not find a free CDP port in ${CDP_PORT_BASE}-${CDP_PORT_BASE + CDP_PORT_RANGE - 1} for this worktree`,
    );
}
