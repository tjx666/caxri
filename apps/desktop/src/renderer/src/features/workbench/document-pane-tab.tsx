import { useTranslation } from '../../i18n';
import { useCaxriQuery } from '../../queries/client';
import { useGitDecoration } from '../../stores/git-decorations';
import { useProjectById, useSessionState } from '../../stores/selectors';
import { sessionViewScope, useSessionViewStore } from '../../stores/session-view';
import { closeDocumentTabs, pinDocumentTab } from '../editor/document-commands';
import {
    documentTabPathMenuState,
    resolveDocumentTabPath,
} from '../editor/document-tab-path-actions';
import { documentTabPathMenu } from '../editor/document-tab-path-menu';
import { GitReviewTabBadge } from '../editor/git-review-tab-badge';
import { useDocumentTabPresentation } from '../editor/hooks/use-document-tab-presentation';
import { previewTabSwitch } from '../preview/preview-commands';
import { WorkTab } from '../tabs/work-tab';
import type { WorkTabNavigationKey } from '../tabs/work-tab-accessibility';
import { workTabId } from '../tabs/work-tab-accessibility';
import { selectPaneTab } from './pane-actions';
import { EDITOR_PATH_DRAG_TYPE, PANE_TAB_DRAG_TYPE } from './pane-drop-zone';
import { paneTabMenu } from './pane-tab-menu';
import { usePaneViewSession, usePaneViewSessionId } from './pane-view-session';
import type { PaneTabProperties } from './terminal-pane-tab';

/**
 * Subscribes to its own document so a keystroke only rerenders the tab whose dirty flag flipped.
 */
export function DocumentPaneTab({
    active,
    closable,
    onNavigate,
    paneId,
    path,
    showActiveAccent,
    showTrailingSeparator,
    tab,
}: PaneTabProperties & { path: string }) {
    const { t } = useTranslation();
    const session = usePaneViewSession();
    /**
     * Keep context-menu close actions in sync when other tabs open or close.
     */
    const paneLayout = useSessionState(usePaneViewSessionId())?.paneLayout;
    const project = useProjectById(session?.workbenchProjectId);
    const overviewQuery = useCaxriQuery(
        'git.overview',
        { sessionId: session?.id ?? '' },
        { enabled: Boolean(session), staleTime: 60_000 },
    );
    const document = useSessionViewStore((state) =>
        session
            ? state.documents[sessionViewScope(session.id, session.workbenchProjectId)]?.[path]
            : undefined,
    );
    const resolution = resolveDocumentTabPath(path, {
        projectRoot: project?.rootPath,
        repositories: overviewQuery.data?.repositories,
        externalDisplayPath: document?.displayPath,
    });
    /**
     * Keyed on the resolved filesystem path, not the tab's own `path`: a single-file Git diff tab carries a virtual URI
     * whose repository-relative path only `resolveDocumentTabPath` can turn into the absolute path Git reports.
     */
    const gitDecoration = useGitDecoration(resolution?.absolutePath);
    const pathMenu = documentTabPathMenuState(path, overviewQuery, t);
    const presentation = useDocumentTabPresentation(path, document?.displayPath);
    return (
        <WorkTab
            active={active}
            accessory={<GitReviewTabBadge sessionId={session?.id} tabPath={path} />}
            fill={false}
            closable={closable}
            closeLabel={t('workbench.tab.closeEditor')}
            dirty={document?.dirty}
            gitDecoration={gitDecoration}
            // Icon, label, and location detail. Ordinary files expose their full path on hover (`labelTooltip`);
            // virtual resources reuse their descriptive label.
            {...presentation}
            // The full path is a different detail than the filename, not a fuller version of it, so it must not
            // replace the filename a screen reader announces the way a Terminal's untruncated title does.
            keepLabelAsAccessibleName
            motionIdentity={tab.id}
            showActiveAccent={showActiveAccent}
            showTrailingSeparator={showTrailingSeparator}
            tabId={workTabId(tab.id)}
            paneTabId={tab.id}
            onDoubleClick={() => {
                if (session) pinDocumentTab(session.id, tab.id);
            }}
            onClose={() => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard, closeDocumentTabs() reports its own errors
                void closeDocumentTabs([tab.id]);
            }}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'copyMove';
                event.dataTransfer.setData(PANE_TAB_DRAG_TYPE, tab.id);
                if (resolution)
                    event.dataTransfer.setData(EDITOR_PATH_DRAG_TYPE, resolution.absolutePath);
                event.dataTransfer.setData('text/plain', resolution?.absolutePath ?? path);
            }}
            onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                onNavigate(event.key as WorkTabNavigationKey);
            }}
            onSelect={() => selectPaneTab(tab.id)}
            contextMenu={() =>
                paneTabMenu({
                    paneId,
                    paneLayout,
                    tabId: tab.id,
                    resourceEntries: pathMenu.showMenu
                        ? documentTabPathMenu(
                              {
                                  resolution,
                                  unavailableReason: pathMenu.unavailableReason,
                                  externalDocumentId: pathMenu.externalDocumentId,
                                  previewSwitch: previewTabSwitch(path),
                              },
                              t,
                          )
                        : undefined,
                })
            }
            preview={tab.preview}
        />
    );
}
