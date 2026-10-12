import { X } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { CommandTooltip } from '../../components/command-tooltip';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { ViewContainerSurface } from '../view-containers/view-container-surface';

export function Panel() {
    const { t } = useTranslation();
    const desiredId = useChromeLayoutStore((state) => state.desiredPanelViewContainerId);
    return (
        <section
            aria-label={t('panel.label')}
            className="panel flex min-h-0 min-w-0 flex-col border-t border-border bg-surface"
        >
            <ViewContainerSurface
                ariaLabel={t('panel.label')}
                desiredId={desiredId}
                location="panel"
                onSelect={(id) => useChromeLayoutStore.getState().activatePanelViewContainer(id)}
                trailing={
                    <span className="ml-auto flex items-center pr-1">
                        <CommandTooltip commandId="panel.toggle">
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={t('panel.close')}
                                onClick={() => executeCommand('panel.toggle')}
                            >
                                <X size={14} />
                            </Button>
                        </CommandTooltip>
                    </span>
                }
            />
        </section>
    );
}
