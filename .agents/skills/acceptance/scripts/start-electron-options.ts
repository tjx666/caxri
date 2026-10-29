/**
 * Command-line option parsing for the macOS Acceptance launcher, kept beside the launcher so its lifecycle logic stays
 * within the file budget.
 */
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import type { DesktopLeaseHandle } from '../../switch-worktree/scripts/desktop-lease';
import {
    acquireDesktopLease,
    DesktopLeaseBusyError,
} from '../../switch-worktree/scripts/desktop-lease';

type OptionValue = string | true;
// Partial (not Record<string, OptionValue[]>): the object starts empty and keys are only
// populated for flags actually present on argv, so an arbitrary key genuinely may be absent.
type ParsedOptions = Partial<Record<string, OptionValue[]>>;

export function parseOptions(argv: string[]): ParsedOptions {
    const options: ParsedOptions = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) throw new Error(`Expected an option, received: ${token}`);
        const key = token.slice(2);
        const next = argv[index + 1];
        (options[key] ??= []).push(next && !next.startsWith('--') ? argv[++index] : true);
    }
    return options;
}

export function stringOptions(options: ParsedOptions, key: string): string[] {
    const values = options[key] ?? [];
    if (values.includes(true)) throw new Error(`--${key} requires a value`);
    return values as string[];
}

export function stringOption(options: ParsedOptions, key: string): string | undefined {
    const values = options[key] ?? [];
    if (values.length > 1) throw new Error(`--${key} may only be provided once`);
    const value = values[0];
    if (value === true) throw new Error(`--${key} requires a value`);
    return value;
}

export function hasBooleanOption(options: ParsedOptions, key: string): boolean {
    const values = options[key] ?? [];
    if (values.length > 1) throw new Error(`--${key} may only be provided once`);
    if (values.some((value) => value !== true)) throw new Error(`--${key} does not take a value`);
    return values.length === 1;
}

const MAX_LEASE_WAIT_SECONDS = 1800;

/**
 * Reads `--lease-wait <seconds>`: an integer from 1 to {@link MAX_LEASE_WAIT_SECONDS}, mirroring `check --e2e-wait`.
 * Absent means 0, the immediate-failure default.
 */
export function leaseWaitSecondsOption(options: ParsedOptions): number {
    const raw = stringOption(options, 'lease-wait');
    if (raw === undefined) return 0;
    const seconds = Number(raw);
    if (
        !/^\d+$/.test(raw) ||
        !Number.isSafeInteger(seconds) ||
        seconds < 1 ||
        seconds > MAX_LEASE_WAIT_SECONDS
    )
        throw new Error(
            `--lease-wait requires an integer from 1 to ${MAX_LEASE_WAIT_SECONDS} seconds`,
        );
    return seconds;
}

/**
 * A busy lease without `--lease-wait` names that option: the error is all an Agent reads at that moment, and without
 * the hint it writes a shell retry loop that can relaunch an instance after cleanup. A wait that ran out arrives as a
 * plain error carrying the waited duration, so it gets no hint.
 */
export function withLeaseWaitHint(error: unknown, leaseWaitSeconds: number): unknown {
    if (leaseWaitSeconds > 0 || !(error instanceof DesktopLeaseBusyError)) return error;
    return new Error(
        `${error.message}\nTo wait for it to finish, rerun with --lease-wait <seconds> (1-${MAX_LEASE_WAIT_SECONDS}) ` +
            'instead of retrying in a shell loop.',
    );
}

/**
 * Takes the repository desktop lease, waiting up to `leaseWaitSeconds` for a live owner, and tells the Agent when the
 * wait ended because the Acceptance window is about to take focus.
 */
export async function acquireLaunchLease(
    root: string,
    leaseWaitSeconds: number,
): Promise<DesktopLeaseHandle> {
    let lease: DesktopLeaseHandle;
    try {
        lease = await acquireDesktopLease(root, 'Acceptance', process.pid, {
            waitMs: leaseWaitSeconds * 1000,
        });
    } catch (error) {
        throw withLeaseWaitHint(error, leaseWaitSeconds);
    }
    if (leaseWaitSeconds > 0)
        console.error(
            'Acquired the desktop lease; the Acceptance window is about to start and take focus.',
        );
    return lease;
}

/**
 * Resolves the requested Project roots (default: the repository root) and fails when one does not exist.
 */
export async function resolveTestRoots(requested: string[], root: string): Promise<string[]> {
    const paths = (requested.length > 0 ? requested : [root]).map((path) => resolve(root, path));
    await Promise.all(
        paths.map(async (path) => {
            try {
                await access(path);
            } catch {
                throw new Error(`Test root does not exist: ${path}`);
            }
        }),
    );
    return paths;
}

export function help(): string {
    return `Start an isolated Caxri Electron acceptance instance

Options:
  --port N               CDP port (default: 9222)
  --test-root PATH       Project root selected in Caxri; repeat to queue roots (default: repository root)
  --agent-fixture ID     Plan-declared, repository-owned fake Agent fixture
  --native-dialog        Explicit-current-request exception: use the real macOS picker
  --case-id ID           Stable ASCII id for this isolated Acceptance case
  --report-dir DIR       Frozen round containing this case plan and lifecycle evidence
  --case-mode MODE       isolated (default) or restart
  --reuse-user-data PATH Reuse this case's frozen caxri-acceptance-user-<profile-id>-* profile
  --cleanup-reused-user-data
                         Remove the validated reusable profile when this launch stops
  --lease-wait SECONDS   Wait up to 1800 seconds for the repository desktop lease (default: fail immediately)
  --help                 Show this message`;
}
