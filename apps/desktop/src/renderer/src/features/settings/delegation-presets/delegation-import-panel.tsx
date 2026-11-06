import { useEffect, useRef } from 'react';

import type { DelegationImportMode } from '@caxri/protocol';

import { Button } from '../../../components/ui/button';
import { Spinner } from '../../../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../../../components/ui/toggle-group';
import { useTranslation } from '../../../i18n';
import { ImportOutcomeAlerts } from './import-outcome-alerts';
import { ImportPreviewSummary } from './import-preview-summary';
import type { DelegationImportState } from './use-delegation-import';

type OpenState = Extract<DelegationImportState, { phase: 'open' }>;

interface DelegationImportPanelProperties {
    state: OpenState;
    onApply: () => void;
    onCancel: () => void;
    onModeChange: (mode: DelegationImportMode) => void;
}

/**
 * Inline preview of a dianjiang import, like the theme import notices rather than a modal: the file's name, a Merge or
 * Replace choice, what the chosen mode would change, and Import. Nothing is written until Import.
 */
export function DelegationImportPanel({
    state,
    onApply,
    onCancel,
    onModeChange,
}: DelegationImportPanelProperties) {
    const { t } = useTranslation();
    const { outcome } = state;
    const preview =
        outcome.kind === 'ready' || outcome.kind === 'applying' ? outcome.preview : undefined;
    const isApplying = outcome.kind === 'applying';
    const isBusy = isApplying || outcome.kind === 'checking';
    const panel = useRef<HTMLElement>(null);
    // Opening the panel moves focus into it, so a keyboard or screen reader user lands on the preview they asked for.
    useEffect(() => {
        panel.current?.focus();
    }, []);
    return (
        <section
            ref={panel}
            tabIndex={-1}
            aria-label={t('settings.delegationPresets.label')}
            className="mt-2 flex min-w-0 flex-col gap-2 rounded border border-border bg-elevated p-3 outline-none"
        >
            {state.fileName && (
                <p className="m-0 truncate text-[11px] text-muted">
                    {t('settings.delegationPresets.from', { fileName: state.fileName })}
                </p>
            )}
            {outcome.kind !== 'unreadable' && state.sourceText !== undefined && (
                <ImportModeChoice
                    isDisabled={isApplying}
                    mode={state.mode}
                    onModeChange={onModeChange}
                />
            )}
            {outcome.kind === 'checking' && (
                <p role="status" className="m-0 flex items-center gap-2 text-[11px] text-muted">
                    <Spinner />
                    {t('settings.delegationPresets.checking')}
                </p>
            )}
            {preview && <ImportPreviewSummary preview={preview} />}
            <ImportOutcomeAlerts outcome={outcome} />
            <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="secondary" disabled={isApplying} onClick={onCancel}>
                    {t('settings.delegationPresets.cancel')}
                </Button>
                <Button size="sm" disabled={isBusy || !preview?.changed} onClick={onApply}>
                    {t('settings.delegationPresets.apply')}
                </Button>
            </div>
        </section>
    );
}

/**
 * The Merge or Replace choice with a one-line hint of what the chosen mode keeps or removes.
 */
function ImportModeChoice({
    isDisabled,
    mode,
    onModeChange,
}: {
    isDisabled: boolean;
    mode: DelegationImportMode;
    onModeChange: (mode: DelegationImportMode) => void;
}) {
    const { t } = useTranslation();
    return (
        <>
            <ToggleGroup
                aria-label={t('settings.delegationPresets.mode')}
                disabled={isDisabled}
                value={[mode]}
                onValueChange={(next: DelegationImportMode[]) => {
                    // Re-activating the selected segment reports an empty selection; the mode must stay chosen.
                    if (next.length > 0) onModeChange(next[0]);
                }}
            >
                <ToggleGroupItem size="dense" value="merge">
                    {t('settings.delegationPresets.mode.merge')}
                </ToggleGroupItem>
                <ToggleGroupItem size="dense" value="replace">
                    {t('settings.delegationPresets.mode.replace')}
                </ToggleGroupItem>
            </ToggleGroup>
            <p className="m-0 text-[11px] text-muted">
                {t(
                    mode === 'merge'
                        ? 'settings.delegationPresets.mode.mergeHint'
                        : 'settings.delegationPresets.mode.replaceHint',
                )}
            </p>
        </>
    );
}
