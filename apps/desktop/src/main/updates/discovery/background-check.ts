import type { UpdateState } from '@caxri/protocol';

/**
 * How often a long-running Caxri asks again: soon enough to start a fresh release's background download within minutes,
 * at four requests an hour against GitHub's anonymous 60. A rate-limited tick needs no retry timer of its own.
 */
export const BACKGROUND_CHECK_INTERVAL_MS = 15 * 60 * 1_000;
/**
 * A wake from sleep re-checks only when the last attempt is at least this old, so closing and opening a lid repeatedly
 * does not turn into a request per wake.
 */
export const RESUME_CHECK_MIN_GAP_MS = 30 * 60 * 1_000;

interface AutomaticUpdateCheckOptions {
    alreadyStarted: boolean;
    hasAcceptanceDiscovery?: boolean;
    isE2E: boolean;
    isPackaged: boolean;
}

/**
 * Packaged E2E profiles stay deterministic and must never contact the release service. An admitted Acceptance fixture
 * is the one exception that runs the launch check off the network, so its notification arrives the same way a real
 * automatic discovery does.
 */
export function shouldStartAutomaticUpdateCheck(options: AutomaticUpdateCheckOptions): boolean {
    if (options.alreadyStarted) return false;
    return options.hasAcceptanceDiscovery === true || (options.isPackaged && !options.isE2E);
}

interface BackgroundCheckInput {
    isCheckInFlight: boolean;
    lastAttemptAt: number | undefined;
    minGapMs: number;
    now: number;
    status: UpdateState['status'];
}

/**
 * Whether a timer or wake-from-sleep re-check may run. A download in progress must never be replaced by a fresh
 * discovery (a verified installer waiting for the user keeps being re-checked: see `supersedeReady`), a check already
 * in flight is not repeated, and a recent attempt (including one that GitHub rate-limited) is not retried before
 * `minGapMs` has passed.
 */
export function shouldRunBackgroundCheck(input: BackgroundCheckInput): boolean {
    if (input.isCheckInFlight) return false;
    if (input.status === 'downloading') return false;
    return input.lastAttemptAt === undefined || input.now - input.lastAttemptAt >= input.minGapMs;
}
