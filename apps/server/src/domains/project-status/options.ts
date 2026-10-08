import type { AppSettings, ServerEvent } from '@caxri/protocol';

import type { GitHubPullRequestStore } from '../external-status';
import type { SessionTranscriptContext } from '../session-context';
import type { VercelDeploymentStore } from './vercel-store';

export interface ProjectStatusServiceOptions {
    cacheLimit?: number;
    cacheTtlMs?: number;
    emit?: (event: ServerEvent) => void;
    failureCacheTtlMs?: number;
    /**
     * Server-wide pull-request projection. Sharing one store with the sidebar sweep and Source Control is what keeps
     * the status bar, the Status panel, and the badges on a single `gh pr view` per pull request.
     */
    github?: GitHubPullRequestStore;
    now?: () => number;
    /**
     * Server-wide Vercel projection shared with the PrimarySidebar's delivery badge, for the same reason `github` is
     * shared: one production query per repository instead of one per reader.
     */
    vercel?: VercelDeploymentStore;
    /**
     * Every Session whose delivery failures should raise a notification: in practice every unarchived Session. Without
     * it only the selected Session is watched.
     */
    listWatchedSessions?: () => readonly string[];
    /**
     * Reads the clues this Session's own Agent conversation produced, so the status bar can name the issue a branch is
     * about even when the pull request body never said it. A Server assembled without it simply drops that source.
     */
    sessionContext?: (sessionId: string) => Promise<SessionTranscriptContext | undefined>;
    /**
     * Reads current settings for `projectStatus.ignoredChecks` and `projectStatus.notifications.enabled`. A Server
     * assembled without it behaves as if no check is ignored and no alert is wanted.
     */
    settings?: () => AppSettings;
    /**
     * Injected in tests so a polling interval can be advanced deterministically instead of waited out.
     */
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
}
