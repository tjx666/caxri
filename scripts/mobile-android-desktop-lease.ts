import process from 'node:process';

import type { DesktopLeaseHandle } from '../.agents/skills/switch-worktree/scripts/desktop-lease';
import {
    acquireDesktopLease,
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
export function createAndroidAcceptanceDesktopLease(root: string): {
    claim: () => Promise<void>;
    release: () => Promise<void>;
} {
    let lease: DesktopLeaseHandle | undefined;
    return {
        async claim() {
            // A caller that already coordinates the desktop (`switch-worktree desktop`) passes its token through.
            if (lease || process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN) return;
            lease = await acquireDesktopLease(root, 'Android Acceptance', process.pid, {
                waitMs: DESKTOP_LEASE_WAIT_MS,
            });
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
