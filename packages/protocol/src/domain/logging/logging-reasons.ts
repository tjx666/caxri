/**
 * Closed reason sets for structured-log events in `logging.ts` whose cause has no better owning contract.
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
 * Closed reason set for `session_rename.provider_sync_deferred`: what became of a manual title that was set before the
 * primary Agent had a conversation, once one appeared. `synchronized` wrote it; `already-synchronized` found the
 * conversation already carrying it; `native-name-kept` found a name the provider or the user gave the conversation,
 * which Caxri has no authority to overwrite; `conversation-pending` means the provider has not recorded the
 * conversation yet and the next turn tries again; `ineligible` means the Session, its title mode, or its primary Agent
 * changed first; `failed` is a provider write that threw.
 */
export type SessionRenameProviderDeferredSyncReason =
    | 'already-synchronized'
    | 'conversation-pending'
    | 'failed'
    | 'ineligible'
    | 'native-name-kept'
    | 'synchronized';

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

/**
 * Closed set of Server Core background drivers that yield to foreground work while the machine is loaded. Named in
 * `server_core.load_changed` deferral counts and in a slow `git.command` record's `background` field.
 */
export type BackgroundWorkSource = 'delivery-watch' | 'project-status-poll' | 'pull-request-sweep';

/**
 * Closed set of Antigravity private stores and read paths whose failures `agent.antigravity_store_read_failed` names.
 * `conversation`, `usage`, `userSteps`, `head` read one `conversations/<id>.db`; `summary` and `title` read
 * `conversation_summaries.db`; `usageCommand` is the `agy -p /usage` probe.
 */
export type AntigravityStoreReadSite =
    'conversation' | 'head' | 'summary' | 'title' | 'usage' | 'usageCommand' | 'userSteps';

/**
 * Closed reason set for `agent.antigravity_store_read_failed`. Database reads: `missing` (no file), `locked`
 * (`SQLITE_BUSY`/`SQLITE_LOCKED`, transient), `schema` (a table or column `agy` changed), `corrupt`
 * (`SQLITE_CORRUPT`/`SQLITE_NOTADB`), `unreadable` (anything else). The `/usage` probe: `spawn` (the command failed to
 * run), `timeout`, `parse` (stdout was not JSON), `shape` (JSON without the expected fields).
 */
export type AntigravityStoreReadFailureReason =
    | 'corrupt'
    | 'locked'
    | 'missing'
    | 'parse'
    | 'schema'
    | 'shape'
    | 'spawn'
    | 'timeout'
    | 'unreadable';

/**
 * Closed reason set for `agent_chat.turn_hold_released`: `call_finished` (the last holding call reported its end),
 * `stopped` (the user pressed Stop), `process_ended` (the provider process ended), `superseded` (the turn ended by
 * another path while held).
 */
export type TurnHoldReleaseReason = 'call_finished' | 'process_ended' | 'stopped' | 'superseded';
