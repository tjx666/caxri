import { useTranslation } from '../../i18n';
import { useDesiredSecondarySidebarView } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { ViewContainerSurface } from '../view-containers/view-container-surface';

export function SecondarySidebar() {
    const { t } = useTranslation();
    const { desiredId, hasSession } = useDesiredSecondarySidebarView();
    return (
        <aside
            aria-label={t('secondarySidebar.label')}
            className="secondary-sidebar flex min-h-0 min-w-0 flex-col bg-surface"
        >
            <ViewContainerSurface
                ariaLabel={t('secondarySidebar.label')}
                desiredId={desiredId}
                location="secondarySidebar"
                hasUnscopedSelection={!hasSession}
                onSelect={(id) =>
                    useSessionViewStore.getState().setDesiredSecondarySidebarViewContainerId(id)
                }
            />
        </aside>
    );
}
