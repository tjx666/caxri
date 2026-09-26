import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { editor as MonacoEditor } from 'monaco-editor';

import { monaco } from '../../lib/monaco';
import { GitReviewCard } from './git-review-card';
import {
    clearActiveGitReviewComment,
    setActiveGitReviewComment,
} from './git-review-comment-commands';
import type { GitReviewComment } from './git-review-comments';
import { reviewSnippet, useGitReviewComments } from './git-review-comments';

interface ReviewEditorScope {
    sessionId: string;
    repositoryId: string;
    sourceKey: string;
    path: string;
    side: GitReviewComment['side'];
}

/**
 * Monaco owns the scrolling surface; view zones keep cards attached to their exact lines.
 */
export function bindGitReviewCommentEditor(
    editor: MonacoEditor.IStandaloneCodeEditor,
    scope: ReviewEditorScope,
): () => void {
    const zones = new Map<
        string,
        { root: ReturnType<typeof createRoot>; zoneId: string; comment: GitReviewComment }
    >();
    let hoverDecorations: MonacoEditor.IEditorDecorationsCollection | undefined;
    const isInScope = (comment: GitReviewComment) =>
        comment.sessionId === scope.sessionId &&
        comment.repositoryId === scope.repositoryId &&
        comment.sourceKey === scope.sourceKey &&
        comment.path === scope.path &&
        comment.side === scope.side;
    const renderZones = () => {
        const comments = useGitReviewComments.getState().comments.filter(isInScope);
        const currentIds = new Set(comments.map((comment) => comment.id));
        editor.changeViewZones((accessor) => {
            for (const [id, zone] of zones) {
                if (currentIds.has(id)) continue;
                zone.root.unmount();
                accessor.removeZone(zone.zoneId);
                zones.delete(id);
            }
            for (const comment of comments) {
                const existing = zones.get(comment.id);
                if (existing) {
                    if (existing.comment !== comment) {
                        existing.root.render(createElement(GitReviewCard, { comment }));
                        existing.comment = comment;
                    }
                    continue;
                }
                const domNode = document.createElement('div');
                domNode.className = 'git-review-zone';
                const zoneId = accessor.addZone({
                    afterLineNumber: comment.endLine,
                    heightInPx: 128,
                    domNode,
                });
                /**
                 * Monaco marks view zones as decorative. Review cards contain editable controls and must enter the
                 * accessibility tree.
                 */
                domNode.closest('[aria-hidden="true"]')?.removeAttribute('aria-hidden');
                const root = createRoot(domNode);
                zones.set(comment.id, { root, zoneId, comment });
                root.render(createElement(GitReviewCard, { comment }));
            }
        });
    };
    const add = (line?: number) => {
        const selection = editor.getSelection();
        const startLine = line ?? selection?.startLineNumber ?? 1;
        const endLine = line ?? Math.max(startLine, selection?.endLineNumber ?? startLine);
        const model = editor.getModel();
        if (!model) return;
        useGitReviewComments.getState().add({
            id: crypto.randomUUID(),
            ...scope,
            startLine,
            endLine,
            snippet: reviewSnippet(model.getValue(), startLine, endLine),
            text: '',
            status: 'pending',
        });
    };
    editor.addAction({
        id: 'caxri.addReviewComment',
        label: 'Add Review Comment',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyM],
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1,
        run: () => add(),
    });
    const focus = editor.onDidFocusEditorText(() => {
        setActiveGitReviewComment({
            editor,
            repositoryId: scope.repositoryId,
            sessionId: scope.sessionId,
            sourceKey: scope.sourceKey,
            path: scope.path,
            add: () => add(),
        });
    });
    const hover = editor.onMouseMove((event) => {
        const target = event.target;
        const line = target.position?.lineNumber;
        const isGutter =
            target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
            target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
        hoverDecorations?.clear();
        if (isGutter && line)
            hoverDecorations = editor.createDecorationsCollection([
                {
                    range: {
                        startLineNumber: line,
                        startColumn: 1,
                        endLineNumber: line,
                        endColumn: 1,
                    },
                    options: {
                        glyphMarginClassName: 'git-review-add-glyph',
                        glyphMarginHoverMessage: { value: 'Add Review Comment' },
                    },
                },
            ]);
    });
    const click = editor.onMouseDown((event) => {
        if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN)
            add(event.target.position.lineNumber);
    });
    const content = editor.onDidChangeModelContent(() =>
        useGitReviewComments
            .getState()
            .refresh(
                scope.sessionId,
                scope.repositoryId,
                scope.sourceKey,
                scope.path,
                scope.side,
                editor.getValue(),
            ),
    );
    const unsubscribe = useGitReviewComments.subscribe(renderZones);
    renderZones();
    return () => {
        unsubscribe();
        focus.dispose();
        clearActiveGitReviewComment(editor);
        hover.dispose();
        click.dispose();
        content.dispose();
        hoverDecorations?.clear();
        editor.changeViewZones((accessor) => {
            for (const zone of zones.values()) {
                zone.root.unmount();
                accessor.removeZone(zone.zoneId);
            }
        });
        zones.clear();
    };
}
