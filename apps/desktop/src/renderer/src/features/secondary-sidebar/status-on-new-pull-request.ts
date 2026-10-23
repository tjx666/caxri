import { useEffect, useRef } from 'react';

import type { SessionPullRequests } from '@caxri/protocol';

import { useCaxriQuery } from '../../queries/client';
import { useSelectedSessionId } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS } from '../session/session-commands';

/**
 * The Status panel's ViewContainer: it shows the Session's pull request with its checks and Merge action.
 */
const STATUS_VIEW_CONTAINER_ID = 'caxri.project-status';

/**
 * One Session's pull request as the snapshot last reported it: its URL, `null` once a loaded snapshot listed none, or
 * `undefined` while the snapshot has not loaded yet.
 */
export type ObservedPullRequestUrl = string | null | undefined;

export interface PullRequestObservation {
    sessionId: string;
    url: string | null;
}

/**
 * Projects the snapshot onto the selected Session's pull request identity, keeping "not loaded" apart from "loaded with
 * no pull request" so the first loaded snapshot can become a baseline instead of a detection.
 */
export function selectPullRequestUrl(
    snapshot: SessionPullRequests | undefined,
    sessionId: string | undefined,
): ObservedPullRequestUrl {
    if (!snapshot || !sessionId) return undefined;
    // The record omits Sessions without a pull request.
    return Object.hasOwn(snapshot.pullRequests, sessionId)
        ? snapshot.pullRequests[sessionId].url
        : null;
}

/**
 * Whether the selected Session just gained a pull request it did not have the last time this Session was observed: a
 * newly opened one, or a different one replacing it. The first observation of a Session (App start, or selecting
 * another Session) is only a baseline, so a pull request that already existed never takes the panel away from the user;
 * and a status change on the same pull request keeps its URL, so it never pulls the user back after they leave.
 */
export function isNewSessionPullRequest(
    previous: PullRequestObservation | undefined,
    next: PullRequestObservation,
): boolean {
    if (!previous || previous.sessionId !== next.sessionId) return false;
    return next.url !== null && next.url !== previous.url;
}

/**
 * Switches the selected Session's Secondary Sidebar to the Status panel when that Session gains a new pull request.
 *
 * Source Control's Pull Request mode resolves the pull request from the Session's current branch, so a pull request an
 * Agent opened from another worktree branch would show there as "no pull request"; the Status panel reads the Session's
 * own pull request instead. A hidden Secondary Sidebar stays hidden and simply opens on Status next time.
 *
 * Reads the shared `session.pullRequests` cache without driving its cadence (see `useSessionPullRequestPoll`), and
 * `select` narrows the subscription to the selected Session's URL so a poll that changed nothing does not re-render.
 */
export function useStatusOnNewPullRequest(): void {
    const sessionId = useSelectedSessionId();
    const url = useCaxriQuery('session.pullRequests', undefined, {
        refetchOnMount: false,
        select: (snapshot) => selectPullRequestUrl(snapshot, sessionId),
        staleTime: SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS,
    }).data;
    const observed = useRef<PullRequestObservation | undefined>(undefined);
    useEffect(() => {
        if (!sessionId || url === undefined) return;
        const next = { sessionId, url };
        if (isNewSessionPullRequest(observed.current, next))
            useSessionViewStore
                .getState()
                .setDesiredSecondarySidebarViewContainerId(STATUS_VIEW_CONTAINER_ID);
        observed.current = next;
    }, [sessionId, url]);
}
