import { parseGitDiffTab } from '@caxri/protocol';
import type { editor as MonacoEditor } from 'monaco-editor';

import { getSelectedSession } from '../../stores/selectors';
import { getActivePaneTab } from '../workbench/pane-actions';

interface ActiveReviewComment {
    editor: MonacoEditor.IStandaloneCodeEditor;
    repositoryId: string;
    sessionId: string;
    sourceKey: string;
    path: string;
    add(): void;
}

const activeReviewComment: { current?: ActiveReviewComment } = {};

export function setActiveGitReviewComment(value: ActiveReviewComment): void {
    activeReviewComment.current = value;
}

export function clearActiveGitReviewComment(editor: MonacoEditor.IStandaloneCodeEditor): void {
    if (activeReviewComment.current?.editor === editor) activeReviewComment.current = undefined;
}

export function canAddGitReviewComment(): boolean {
    const tab = getActivePaneTab();
    const diff = tab?.resource.kind === 'file' ? parseGitDiffTab(tab.resource.path) : undefined;
    const active = activeReviewComment.current;
    return Boolean(
        diff &&
        active &&
        diff.repositoryId === active.repositoryId &&
        (diff.source === 'commit' ? `commit:${diff.sha}` : diff.source) === active.sourceKey &&
        (diff.kind === 'changes' || diff.path === active.path) &&
        getSelectedSession()?.id === active.sessionId,
    );
}

export function addGitReviewComment(): void {
    if (canAddGitReviewComment()) activeReviewComment.current?.add();
}
