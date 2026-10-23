import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { editor as MonacoEditor } from 'monaco-editor';

import { translate, useLocaleStore } from '../../i18n';
import { monaco } from '../../lib/monaco';
import { subscribeCaxriQuery } from '../../queries/client';
import type { BoundGitReviewCommentEditor, ReviewEditorScope } from './git-review-bound-editors';
import { registerBoundGitReviewCommentEditor } from './git-review-bound-editors';
import { GitReviewCard } from './git-review-card';
import {
    clearActiveGitReviewComment,
    createGitReviewComment,
    refreshGitReviewComments,
    setActiveGitReviewComment,
} from './git-review-comment-commands';
import type { GitReviewComment } from './git-review-comments';
import { reviewSnippet } from './git-review-comments';

/**
 * Monaco owns the scrolling surface; view zones keep cards attached to their exact lines.
 */
export function bindGitReviewCommentEditor(
    editor: MonacoEditor.IStandaloneCodeEditor,
    scope: ReviewEditorScope,
): () => void {
    const zones = new Map<
        string,
        {
            root: ReturnType<typeof createRoot>;
            zoneId: string;
            zone: MonacoEditor.IViewZone;
            comment: GitReviewComment;
            resizeObserver: ResizeObserver;
        }
    >();
    let hoverDecorations: MonacoEditor.IEditorDecorationsCollection | undefined;
    let scopedComments: GitReviewComment[] = [];
    const isInScope = (comment: GitReviewComment) =>
        comment.sourceKey === scope.sourceKey &&
        comment.path === scope.path &&
        comment.side === scope.side;
    /**
     * Monaco view zones do not size to their content, so the card's own vertical resize (edit mode, a manually resized
     * textarea) would otherwise get clipped by a stale `heightInPx`. `ResizeObserver` measures the mounted card's real
     * rendered height and `layoutZone` reflows the editor around it.
     */
    const observeZoneHeight = (
        domNode: HTMLDivElement,
        zoneId: string,
        zone: MonacoEditor.IViewZone,
    ) => {
        const resizeObserver = new ResizeObserver(() => {
            const measured = Math.ceil(domNode.getBoundingClientRect().height);
            if (measured <= 0 || zone.heightInPx === measured) return;
            editor.changeViewZones((accessor) => {
                zone.heightInPx = measured;
                accessor.layoutZone(zoneId);
            });
        });
        resizeObserver.observe(domNode);
        return resizeObserver;
    };
    /**
     * Monaco stretches a view zone across the whole scrollable content width, which runs under the minimap and
     * scrollbar, so a card sized to the zone was clipped on its right edge. The visible content width caps it instead.
     */
    const syncZoneWidth = (domNode: HTMLElement) =>
        domNode.style.setProperty(
            '--git-review-zone-width',
            `${editor.getLayoutInfo().contentWidth}px`,
        );
    /**
     * A comment created on a line near the viewport's bottom edge gets its card placed below the visible area, where
     * the user cannot see or type into it; the next render scrolls just far enough to show that one new card.
     */
    let revealOnCreateId: string | undefined;
    const revealCreatedZone = () => {
        const entry = revealOnCreateId ? zones.get(revealOnCreateId) : undefined;
        if (!entry) return;
        revealOnCreateId = undefined;
        const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
        const zoneBottom =
            editor.getTopForLineNumber(entry.comment.endLine) +
            lineHeight +
            (entry.zone.heightInPx ?? 0);
        const viewportBottom = editor.getScrollTop() + editor.getLayoutInfo().height;
        if (zoneBottom > viewportBottom)
            editor.setScrollTop(zoneBottom - editor.getLayoutInfo().height);
    };
    const renderZones = () => {
        const comments = scopedComments;
        const currentIds = new Set(comments.map((comment) => comment.id));
        editor.changeViewZones((accessor) => {
            for (const [id, entry] of zones) {
                if (currentIds.has(id)) continue;
                entry.resizeObserver.disconnect();
                entry.root.unmount();
                accessor.removeZone(entry.zoneId);
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
                syncZoneWidth(domNode);
                const zone: MonacoEditor.IViewZone = {
                    afterLineNumber: comment.endLine,
                    heightInPx: 128,
                    domNode,
                };
                const zoneId = accessor.addZone(zone);
                /**
                 * Monaco marks view zones as decorative. Review cards contain editable controls and must enter the
                 * accessibility tree.
                 */
                domNode.closest('[aria-hidden="true"]')?.removeAttribute('aria-hidden');
                const root = createRoot(domNode);
                const resizeObserver = observeZoneHeight(domNode, zoneId, zone);
                zones.set(comment.id, { root, zoneId, zone, comment, resizeObserver });
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
        const id = crypto.randomUUID();
        revealOnCreateId = id;
        void createGitReviewComment({
            id,
            ...scope,
            startLine,
            endLine,
            snippet: reviewSnippet(model.getValue(), startLine, endLine),
        });
    };
    /**
     * No `keybindings` entry here: `Cmd+Shift+M` is registered centrally as `editor.addReviewComment` in
     * `packages/protocol`'s default keybindings, so it is rebindable in Settings and discoverable in the Command
     * Palette instead of being a Monaco-only shortcut invisible to both. The context-menu entry stays, since Monaco has
     * no other way to surface an editor action there.
     *
     * Monaco fixes an action's label when it is added, so a language change re-adds the action under its new label.
     */
    const addMenuAction = () =>
        editor.addAction({
            id: 'caxri.addReviewComment',
            label: translate('editor.review.addComment'),
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 1,
            run: () => add(),
        });
    let menuAction = addMenuAction();
    const unsubscribeLocale = useLocaleStore.subscribe(() => {
        menuAction.dispose();
        menuAction = addMenuAction();
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
                        glyphMarginHoverMessage: { value: translate('editor.review.addComment') },
                    },
                },
            ]);
    });
    const click = editor.onMouseDown((event) => {
        if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN)
            add(event.target.position.lineNumber);
    });
    const content = editor.onDidChangeModelContent(() => {
        void refreshGitReviewComments(
            scope.sessionId,
            scope.repositoryId,
            scope.sourceKey,
            scope.path,
            scope.side,
            editor.getValue(),
        );
    });
    const layout = editor.onDidLayoutChange(() => {
        for (const entry of zones.values()) syncZoneWidth(entry.zone.domNode);
    });
    const boundEditor: BoundGitReviewCommentEditor = {
        scope,
        getComments: () => scopedComments,
        reveal: (id) => {
            const entry = zones.get(id);
            if (!entry) return false;
            editor.revealLineInCenter(entry.comment.endLine);
            editor.focus();
            return true;
        },
    };
    const unregister = registerBoundGitReviewCommentEditor(boundEditor);
    const unsubscribe = subscribeCaxriQuery(
        'gitReview.list',
        { sessionId: scope.sessionId, repositoryId: scope.repositoryId },
        (comments) => {
            scopedComments = (comments ?? []).filter(isInScope);
            renderZones();
            revealCreatedZone();
        },
    );
    return () => {
        unsubscribe();
        unsubscribeLocale();
        menuAction.dispose();
        unregister();
        focus.dispose();
        clearActiveGitReviewComment(editor);
        hover.dispose();
        click.dispose();
        content.dispose();
        layout.dispose();
        hoverDecorations?.clear();
        editor.changeViewZones((accessor) => {
            for (const entry of zones.values()) {
                entry.resizeObserver.disconnect();
                entry.root.unmount();
                accessor.removeZone(entry.zoneId);
            }
        });
        zones.clear();
    };
}
