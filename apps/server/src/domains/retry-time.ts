/**
 * The clock time a recovery sentence can name, from the limiter's pause deadline.
 *
 * Lives at the domains root rather than inside `external-status` because its two callers straddle that boundary: the
 * limiter's own recovery sentences and the Project Status formatter one level up. A cross-domain deep import is
 * rejected by the domain-structure test, and importing the `external-status` barrel for one pure function pulls the CLI
 * runner, the limiter, and the pull-request store along with it.
 *
 * Returns `undefined` for a deadline that has already passed, so a sentence is never composed promising a retry at a
 * time in the past; the caller falls back to the generic "refresh after the limit resets". This guards composition, not
 * display: a snapshot written just before the deadline is still served for the rest of its failure TTL, so the row that
 * renders the sentence re-checks the deadline against the current clock to decide whether to offer Retry.
 *
 * The locale is pinned rather than read from the host: every Caxri UI string is English, and a Server started from
 * launchd inherits no `LANG`, so an unpinned format would render one sentence differently depending on how the process
 * happened to be launched. The time zone is deliberately left to the host, because the Server always runs on the same
 * machine as the window reading it.
 */
export function retryTimeLabel(
    retryAt: number | undefined,
    now: number = Date.now(),
): string | undefined {
    if (retryAt === undefined || !Number.isFinite(retryAt) || retryAt <= now) return undefined;
    return new Date(retryAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
