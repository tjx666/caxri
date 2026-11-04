import { useTranslation } from '../../../i18n';
import {
    changedPresetLines,
    importCounts,
    otherChangeLines,
    presetNameLines,
} from './delegation-import-model';
import type { DelegationImportState } from './use-delegation-import';

type OpenState = Extract<DelegationImportState, { phase: 'open' }>;
type ImportPreview = Extract<OpenState['outcome'], { kind: 'ready' }>['preview'];

/**
 * What the previewed import would change: the counts line and the changed presets, callers and depth.
 */
export function ImportPreviewSummary({ preview }: { preview: ImportPreview }) {
    const { t } = useTranslation();
    const counts = importCounts(preview.diff);
    const lines = [
        ...presetNameLines(preview.diff, t),
        ...changedPresetLines(preview.diff),
        ...otherChangeLines(preview, t),
    ];
    return (
        <div role="status" className="flex min-w-0 flex-col gap-1 text-[12px]">
            <p className="m-0 text-foreground">
                {preview.changed
                    ? t('settings.delegationPresets.counts', counts)
                    : t('settings.delegationPresets.upToDate')}
            </p>
            {lines.map((line) => (
                <p key={line} className="m-0 truncate text-[11px] text-muted">
                    {line}
                </p>
            ))}
        </div>
    );
}
