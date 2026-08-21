import { useCallback, useEffect, useRef, useState } from 'react';

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
            for (const subscription of subscriptionsReference.current) subscription.dispose();
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
            for (const subscription of subscriptionsReference.current) subscription.dispose();
            subscriptionsReference.current = [];
            editorReference.current = null;
        },
        [],
    );

    return { isFollowing, jumpToLatest, onMount };
}
