import { useCallback, useEffect, useRef, useState } from 'react';

import { disposeAllThenRethrow } from '@caxri/utils';
import type { OnMount } from '@monaco-editor/react';

import { isTranscriptAtLatest } from './transcript-follow';

type TranscriptEditor = Parameters<OnMount>[0];

export function useAgentTranscriptFollow(scopeKey: string) {
    const editorReference = useRef<TranscriptEditor | null>(null);
    const subscriptionsReference = useRef<Array<{ dispose(): void }>>([]);
    const frameReference = useRef<number | null>(null);
    const programmaticScrollReference = useRef(false);
    const followingReference = useRef(true);
    const [isFollowing, setIsFollowing] = useState(true);

    const updateFollowing = useCallback((isNextFollowing: boolean): void => {
        followingReference.current = isNextFollowing;
        setIsFollowing(isNextFollowing);
    }, []);

    const scheduleLatest = useCallback(
        (isForced: boolean): void => {
            if (frameReference.current !== null) cancelAnimationFrame(frameReference.current);
            frameReference.current = requestAnimationFrame(() => {
                frameReference.current = null;
                if (!isForced && !followingReference.current) return;
                const editor = editorReference.current;
                if (!editor) return;
                programmaticScrollReference.current = true;
                editor.setScrollTop(editor.getScrollHeight());
                programmaticScrollReference.current = false;
                updateFollowing(true);
            });
        },
        [updateFollowing],
    );

    const jumpToLatest = useCallback((): void => {
        updateFollowing(true);
        scheduleLatest(true);
    }, [scheduleLatest, updateFollowing]);

    const onMount = useCallback<OnMount>(
        (editor) => {
            editorReference.current = editor;
            /**
             * Subscribe the new editor before releasing the previous subscriptions, so a throwing Monaco `dispose()`
             * (it throws on a repeated dispose) still surfaces without leaving this editor unfollowed.
             */
            const previousSubscriptions = subscriptionsReference.current;
            subscriptionsReference.current = [
                editor.onDidChangeModelContent(() => scheduleLatest(false)),
                editor.onDidScrollChange((event) => {
                    if (!event.scrollTopChanged || programmaticScrollReference.current) return;
                    updateFollowing(
                        isTranscriptAtLatest({
                            scrollHeight: editor.getScrollHeight(),
                            scrollTop: editor.getScrollTop(),
                            viewportHeight: editor.getLayoutInfo().height,
                        }),
                    );
                }),
            ];
            scheduleLatest(true);
            disposeAllThenRethrow(previousSubscriptions);
        },
        [scheduleLatest, updateFollowing],
    );

    useEffect(() => {
        followingReference.current = true;
        scheduleLatest(true);
    }, [scheduleLatest, scopeKey]);

    useEffect(
        () => () => {
            if (frameReference.current !== null) cancelAnimationFrame(frameReference.current);
            const subscriptions = subscriptionsReference.current;
            subscriptionsReference.current = [];
            editorReference.current = null;
            disposeAllThenRethrow(subscriptions);
        },
        [],
    );

    return { isFollowing, jumpToLatest, onMount };
}
