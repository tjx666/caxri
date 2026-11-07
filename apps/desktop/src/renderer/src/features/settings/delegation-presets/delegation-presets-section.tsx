import { useEffect, useRef } from 'react';

import type { AppSettings } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { Upload } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { useTranslation } from '../../../i18n';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import { DelegationImportPanel } from './delegation-import-panel';
import { TypeList } from './types/type-list';
import { useDelegationImport } from './use-delegation-import';

type DelegationSettings = AppSettings['agents.delegation'];

/**
 * The Agent each delegation type runs on, editable here, then the profile's delegation presets, read-only, with the
 * entry to import a dianjiang file. Presets are edited in the file or by import; type bindings write through
 * `onChange`, which preserves presets and every other field.
 */
export function DelegationPresetsSection({
    value,
    onChange,
}: {
    value: DelegationSettings;
    onChange: (value: DelegationSettings, member: string) => void;
}) {
    const { t } = useTranslation();
    const flow = useDelegationImport();
    const callerRules = Object.keys(value.callers).length;
    const isBusy = flow.state.phase !== 'closed';
    const importButton = useRef<HTMLDivElement>(null);
    const isOpen = flow.state.phase === 'open';
    const wasOpen = useRef(false);
    // The panel replaces the Import button while open; when it closes (cancel or a finished import) the button comes
    // back, and focus returns to it instead of falling to the document body.
    useEffect(() => {
        if (!isOpen && wasOpen.current) importButton.current?.querySelector('button')?.focus();
        wasOpen.current = isOpen;
    }, [isOpen]);
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <TypeList value={value} onChange={onChange} />
            <p className="m-0 text-[11px] text-muted">{t('settings.delegationPresets.heading')}</p>
            {value.presets.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">
                    {t('settings.delegationPresets.empty')}
                </p>
            ) : (
                <ul
                    aria-label={t('settings.delegationPresets.label')}
                    className="m-0 flex list-none flex-col gap-1 p-0"
                >
                    {value.presets.map((preset) => (
                        <li
                            key={preset.name}
                            className="flex min-w-0 flex-col gap-0.5 rounded px-1 py-1 hover:bg-state-hover-quiet"
                        >
                            <span className="flex min-w-0 items-center gap-2 text-[12px]">
                                <span className="shrink-0 font-mono text-foreground">
                                    {preset.name}
                                </span>
                                <AgentIdentityIcon identity={preset.provider} size={12} />
                                <span className="min-w-0 truncate text-muted">
                                    {[
                                        agentProviderCatalog[preset.provider].displayName,
                                        preset.model ??
                                            t('settings.delegationPresets.defaultModel'),
                                        preset.effort ??
                                            t('settings.delegationPresets.defaultEffort'),
                                    ].join(' · ')}
                                </span>
                                {preset.instructions !== undefined && (
                                    <span className="shrink-0 text-[11px] text-muted">
                                        {t('settings.delegationPresets.privateInstructions')}
                                    </span>
                                )}
                            </span>
                            <span className="truncate text-[11px] text-muted">
                                {t('settings.delegationPresets.useWhen', { text: preset.useWhen })}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {callerRules > 0 && (
                <p className="m-0 text-[11px] text-muted">
                    {t(
                        callerRules === 1
                            ? 'settings.delegationPresets.callerOverridesOne'
                            : 'settings.delegationPresets.callerOverridesOther',
                        { count: callerRules },
                    )}
                </p>
            )}
            {flow.state.phase === 'open' && (
                <DelegationImportPanel
                    state={flow.state}
                    onApply={() => {
                        void flow.apply();
                    }}
                    onCancel={flow.cancel}
                    onModeChange={flow.setMode}
                />
            )}
            {flow.state.phase !== 'open' && (
                <div ref={importButton}>
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={isBusy}
                        onClick={() => {
                            void flow.choose();
                        }}
                    >
                        <Upload aria-hidden="true" size={12} />
                        {t('settings.delegationPresets.import')}
                    </Button>
                </div>
            )}
        </div>
    );
}
