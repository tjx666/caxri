import { Text, View } from 'react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { FilesPanel } from './files-panel';
import { PanelStatus, PendingPanelStatus } from './panel-status';
import { panelsStyles as styles } from './panels-styles';
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
            return <TreePanel key={view.id} sessionId={sessionId} theme={theme} viewId={view.id} />;
        default:
            return (
                <PanelStatus
                    message={t('panels.viewOnComputerOnly', { title: view.title })}
                    theme={theme}
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
    if (query.isPending)
        return <PendingPanelStatus fetchStatus={query.fetchStatus} theme={theme} />;
    if (query.isError)
        return (
            <PanelStatus
                message={t('panels.loadFailed')}
                onRetry={() => {
                    void query.refetch();
                }}
                testID="panels-error"
                theme={theme}
            />
        );
    const panel = panels.panels?.find((candidate) => candidate.id === panelId);
    if (!panel)
        return (
            <PanelStatus
                message={t('panels.viewUnavailable')}
                testID="panel-missing"
                theme={theme}
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
