import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { useTranslation } from '../../i18n';
import type { MonitorMode } from './monitor-store';

/**
 * The `Overlay | Window` choice. The pressed segment is where the monitor is now; pressing the other one moves it.
 */
export function ModeSwitch({
    current,
    onSelect,
}: {
    current: MonitorMode;
    onSelect: (mode: MonitorMode) => void;
}) {
    const { t } = useTranslation();
    return (
        <ToggleGroup<MonitorMode>
            aria-label={t('performanceMonitor.mode.label')}
            className="gap-0.5 rounded border border-border p-0.5"
            value={[current]}
            onValueChange={(next) => {
                const mode = next.find((candidate) => candidate !== current);
                if (mode) onSelect(mode);
            }}
        >
            <ToggleGroupItem
                className="h-5 px-2 data-pressed:border-border"
                data-performance-mode="overlay"
                value="overlay"
            >
                {t('performanceMonitor.mode.overlay')}
            </ToggleGroupItem>
            <ToggleGroupItem
                className="h-5 px-2 data-pressed:border-border"
                data-performance-mode="window"
                value="window"
            >
                {t('performanceMonitor.mode.window')}
            </ToggleGroupItem>
        </ToggleGroup>
    );
}
