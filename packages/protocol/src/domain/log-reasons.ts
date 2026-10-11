/**
 * Closed reason sets for log events in `logEventCatalog` whose `reason` field must stay a fixed enum.
 */

/**
 * Closed reason set for `session_rename.provider_sync_skipped`. Skipping the provider write is ordinary behavior: a
 * Session title belongs to Caxri, so the rename always commits locally, which is exactly why the two causes have to
 * stay apart in logs: an Agent that has not reported a session id yet will start synchronizing once it does, while a
 * provider with no rename integration never will. Collapsing them into one string would hide a provider gap inside
 * normal new-Session noise.
 */
export type SessionRenameProviderSyncSkipReason =
    'agent-session-unidentified' | 'provider-rename-unsupported';

/**
 * Closed reason set for `path_browser.search_failed`. `files.search` and the Desktop-Server connection share the same
 * `UNAVAILABLE` wire code for two different situations (a packaged install missing the ripgrep binary or worker script,
 * or Main not currently attached to Server Core) so both fold into `'unavailable'` rather than inferring a split from
 * an error message string. `'disconnected'` is reserved for the connection's own terminal `CANCELLED` outcome
 * (replaced/disposed): an ordinary superseded search never throws, it resolves with `canceled: true`, so a `CANCELLED`
 * reaching this classifier is unambiguous.
 */
export type PathBrowserSearchFailureReason = 'disconnected' | 'io' | 'other' | 'unavailable';

/**
 * Closed reason set for `mobile_gateway.pairing_outcome`. `'started'` is the pairing link itself being issued;
 * `'succeeded'` is a device completing that link's handshake; `'expired'` is an attempt against a link whose TTL
 * already elapsed; `'not-found'` is an attempt against a `pairingId` the Server never issued or already consumed.
 * Keeping these apart is what makes a stuck QR code (expired) distinguishable from a forged or replayed one (not-found)
 * after the fact.
 */
export type MobilePairingOutcomeReason = 'expired' | 'not-found' | 'started' | 'succeeded';

/**
 * Closed reason set for `server_core.idle_exit_triggered`. A single member today, kept as a named union (rather than a
 * literal `'idle-timeout'` inlined at the one call site) so a later idle-exit trigger (e.g. an explicit operator
 * request) extends this type instead of widening an untyped string.
 */
export type ServerIdleExitReason = 'idle-timeout';

/**
 * Closed reason set for `server_core.idle_exit_deferred`. `'active-pty'` covers both a busy Agent and an ordinary live
 * shell: Terminal Host does not distinguish the two at this layer, and an idle-exit sweep has nobody to ask for
 * confirmation the way the interactive `host.stop` command does when it hits the same `activePtyCount > 0` signal (see
 * `apps/server/src/core/server-core.ts`), so it must always be conservative and defer.
 */
export type ServerIdleExitDeferralReason = 'active-pty';
