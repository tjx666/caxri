import { useEffect } from 'react';

import { isUntitledEditorTabPath } from '@caxri/protocol';
import type { EditorDocument } from '@desktop-shared/editor-state';

import { useSessionViewStore } from '../../../stores/session-view';
import { scheduleUntitledLanguageDetection } from './language-detection-client';
import { untitledLanguageKey, useUntitledLanguageStore } from './language-store';
import { emptyUntitledDocument } from './names';

const NO_CANDIDATES: readonly string[] = [];

/**
 * Keeps an untitled tab's buffer and language in step with the editor showing it. A tab restored without a backup (it
 * was empty when the app quit) gets an empty buffer again, and every edit schedules language detection.
 *
 * Returns the detected language candidates for an untitled tab, or `undefined` for any other path so its language keeps
 * coming from the file name.
 */
export function useUntitledEditor(
    session: { id: string; workbenchProjectId?: string } | undefined,
    scope: string | undefined,
    path: string,
    document: EditorDocument | undefined,
): readonly string[] | undefined {
    const isUntitled = isUntitledEditorTabPath(path);
    const sessionId = session?.id;
    const workbenchProjectId = session?.workbenchProjectId;
    const hasDocument = document !== undefined;
    const content = document?.content;
    const key = scope ? untitledLanguageKey(scope, path) : undefined;
    useEffect(() => {
        if (!isUntitled || !sessionId || hasDocument) return;
        useSessionViewStore
            .getState()
            .cacheDocument(sessionId, emptyUntitledDocument(path), workbenchProjectId);
    }, [hasDocument, isUntitled, path, sessionId, workbenchProjectId]);
    useEffect(() => {
        if (isUntitled && key && content !== undefined)
            scheduleUntitledLanguageDetection(key, content);
    }, [content, isUntitled, key]);
    const candidates = useUntitledLanguageStore((state) =>
        key ? state.candidates[key] : undefined,
    );
    return isUntitled ? (candidates ?? NO_CANDIDATES) : undefined;
}
