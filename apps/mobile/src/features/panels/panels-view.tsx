import { Text, View } from 'react-native';

import { ScreenState } from '../../components/screen-state';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { FilesPanel } from './files-panel';
import { panelsStyles as styles } from './panels-styles';
import { PendingPanelState } from './pending-panel-state';
import { TreePanel } from './tree-panel';
import type { Panel, useSessionPanels } from './use-panels';

type PanelView = Panel['views'][number];

const PanelBody = ({
    deviceRole,
    sessionId,
    theme,
    view,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    sessionId: string;
    theme: MobileTheme;
    view: PanelView;
}) => {
    const { t } = useTranslation();
    switch (view.kind) {
        case 'files':
            return (
                <FilesPanel
                    deviceRole={deviceRole}
                    key={sessionId}
                    sessionId={sessionId}
                    theme={theme}
                />
            );
        case 'tree':
            return (
                <TreePanel
                    key={view.id}
                    deviceRole={deviceRole}
                    sessionId={sessionId}
                    theme={theme}
                    viewId={view.id}
                />
            );
        default:
            return (
                <ScreenState
                    kind="empty"
                    testID="panel-computer-only"
                    theme={theme}
                    title={t('panels.viewOnComputerOnly', { title: view.title })}
                />
            );
    }
};

/**
 * One Project view mirrored from Desktop's right sidebar (Files, Status, or an extension panel). A panel with several
 * views stacks them under their titles, as the Desktop sidebar does.
 */
export const ProjectPanelView = ({
    deviceRole,
    panelId,
    panels,
    sessionId,
    theme,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    panelId: string;
    panels: ReturnType<typeof useSessionPanels>;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { query } = panels;
    if (query.isPending) return <PendingPanelState fetchStatus={query.fetchStatus} theme={theme} />;
    if (query.isError)
        return (
            <ScreenState
                actionLabel={t('common.retry')}
                kind="error"
                onAction={() => {
                    void query.refetch();
                }}
                testID="panels-error"
                theme={theme}
                title={t('panels.loadFailed')}
            />
        );
    const panel = panels.panels?.find((candidate) => candidate.id === panelId);
    if (!panel)
        return (
            <ScreenState
                kind="empty"
                testID="panel-missing"
                theme={theme}
                title={t('panels.viewUnavailable')}
            />
        );
    return (
        <View style={styles.root} testID="panels-view">
            {panel.views.length === 1 ? (
                <PanelBody
                    deviceRole={deviceRole}
                    sessionId={sessionId}
                    theme={theme}
                    view={panel.views[0]}
                />
            ) : (
                panel.views.map((view) => (
                    <View key={view.id} style={styles.body}>
                        <Text style={[styles.viewTitle, { color: theme.muted }]}>{view.title}</Text>
                        <PanelBody
                            deviceRole={deviceRole}
                            sessionId={sessionId}
                            theme={theme}
                            view={view}
                        />
                    </View>
                ))
            )}
        </View>
    );
};
