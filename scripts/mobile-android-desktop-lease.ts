import { basename } from 'node:path';
import process from 'node:process';

import type { DesktopLeaseHandle } from '../.agents/skills/switch-worktree/scripts/desktop-lease';
import {
    acquireDesktopLease,
    inspectDesktopLease,
    releaseDesktopLease,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';

/**
 * Cases launch Electron, so the runner claims the desktop once the build is done instead of letting each Playwright
 * launch wait three minutes on its own. A sibling's focused E2E run once outlasted that wait and blocked a whole
 * batch.
 */
const DESKTOP_LEASE_WAIT_MS = 20 * 60_000;

/**
 * Owns the desktop lease for one Android Acceptance batch. Every Playwright case inherits the claimed token through
 * `CAXRI_DESKTOP_COORDINATOR_TOKEN` and launches Electron under this coordinator.
 */
export function createAndroidAcceptanceDesktopLease(
    root: string,
    log: (message: string) => void = console.info,
): {
    claim: () => Promise<void>;
    release: () => Promise<void>;
} {
    let lease: DesktopLeaseHandle | undefined;
    return {
        async claim() {
            // A caller that already coordinates the desktop (`switch-worktree desktop`) passes its token through.
            if (lease || process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN) return;
            /**
             * Sibling worktrees' E2E and Acceptance runs hold this lease for minutes at a time; a silent wait read as a
             * hung runner, so name the holder and report how long the round waited.
             */
            const holder = await inspectDesktopLease(root);
            const startedAt = Date.now();
            if (holder.state === 'active')
                log(
                    `Waiting for the desktop lease held by ${holder.lease.label} (${basename(holder.lease.worktreePath)})`,
                );
            lease = await acquireDesktopLease(root, 'Android Acceptance', process.pid, {
                waitMs: DESKTOP_LEASE_WAIT_MS,
            });
            if (holder.state === 'active')
                log(`Desktop lease acquired after ${Math.round((Date.now() - startedAt) / 1000)}s`);
            process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN = lease.token;
        },
        async release() {
            if (!lease) return;
            const owned = lease;
            lease = undefined;
            delete process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN;
            await releaseDesktopLease(owned);
        },
    };
}
