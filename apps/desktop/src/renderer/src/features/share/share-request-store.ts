import type { ServerEvent } from '@caxri/protocol';

import { createStore } from '../../lib/store';

export type ShareRequest = Extract<ServerEvent, { event: 'desktop.shareReceived' }>['payload'];

interface ShareRequestState {
    /**
     * What the macOS Share menu handed over and no Session has received yet. While it is set, the Send to Session
     * picker is open.
     */
    pending: ShareRequest | undefined;
}

export const useShareRequestStore = createStore<ShareRequestState>('share-request', () => ({
    pending: undefined,
}));

/**
 * `next` added to a request the user has not placed yet, so a second share made while the picker is open goes to the
 * same Session instead of replacing the first. A file already pending is not added twice.
 */
export function mergedShareRequest(
    pending: ShareRequest | undefined,
    next: ShareRequest,
): ShareRequest {
    if (!pending) return next;
    const paths = new Set(pending.files.map((file) => file.path));
    const text = [pending.text, next.text].filter(Boolean).join('\n\n');
    return {
        requestId: pending.requestId,
        files: [...pending.files, ...next.files.filter((file) => !paths.has(file.path))],
        ...(text && { text }),
    };
}

export function clearShareRequest(): void {
    useShareRequestStore.setState({ pending: undefined });
}

/**
 * Opens the Send to Session picker for each Share menu hand-off Main delivers. Returns the unsubscribe.
 */
export function subscribeShareRequests(): () => void {
    return caxri.onEvent((event) => {
        if (event.event !== 'desktop.shareReceived') return;
        useShareRequestStore.setState(({ pending }) => ({
            pending: mergedShareRequest(pending, event.payload),
        }));
    });
}
