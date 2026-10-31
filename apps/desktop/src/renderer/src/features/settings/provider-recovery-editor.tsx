import { useState } from 'react';

import type { AgentOutputRecoverySettings, AgentProvider } from '@caxri/protocol';
import {
    agentProviderCatalog,
    MAX_AGENT_OUTPUT_RECOVERY_DELAY_MS,
    MIN_AGENT_OUTPUT_RECOVERY_DELAY_MS,
} from '@caxri/protocol';

import { FieldDescription, FieldLabel } from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { useTranslation } from '../../i18n';
import { isImeComposing } from '../../lib/ime';
import { parseRecoveryDelay, parseRecoveryPatterns } from './provider-recovery-values';

interface ProviderRecoveryEditorProperties {
    id: string;
    provider: AgentProvider;
    value: AgentOutputRecoverySettings;
    onChange: (value: AgentOutputRecoverySettings) => void;
}

interface RecoveryDelayInputProperties {
    label: string;
    providerName: string;
    value: number;
    onChange: (value: number) => void;
}

interface FieldDraft {
    canonical: string;
    error?: string;
    value: string;
}

const RECOVERY_PATTERN_PLACEHOLDERS: Record<AgentProvider, string> = {
    claude: 'API Error: The response stopped arriving. The response above may be incomplete.',
    codex: 'API timeout\nretry failed',
    grok: 'API timeout',
    antigravity: 'API timeout',
};

function currentDraft(state: FieldDraft, canonical: string): FieldDraft {
    return state.canonical === canonical ? state : { canonical, value: canonical };
}

function RecoveryDelayInput({
    label,
    providerName,
    value,
    onChange,
}: RecoveryDelayInputProperties) {
    const { t } = useTranslation();
    const canonical = String(value);
    const [draftState, setDraftState] = useState<FieldDraft>({
        canonical,
        value: canonical,
    });
    const draft = currentDraft(draftState, canonical);
    const commit = (): void => {
        const next = parseRecoveryDelay(draft.value);
        if (next === undefined) {
            setDraftState({
                ...draft,
                error: t('settings.providerRecovery.delayRange', {
                    min: MIN_AGENT_OUTPUT_RECOVERY_DELAY_MS,
                    max: MAX_AGENT_OUTPUT_RECOVERY_DELAY_MS,
                }),
            });
            return;
        }
        setDraftState({ canonical: String(next), value: String(next) });
        onChange(next);
    };
    return (
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted">
            <span>{label}</span>
            <span className="relative">
                <Input
                    aria-label={t('settings.providerRecovery.delayAriaLabel', {
                        provider: providerName,
                        label,
                    })}
                    aria-invalid={Boolean(draft.error)}
                    className="bg-background pr-9 text-foreground"
                    max={MAX_AGENT_OUTPUT_RECOVERY_DELAY_MS}
                    min={MIN_AGENT_OUTPUT_RECOVERY_DELAY_MS}
                    step={50}
                    type="number"
                    value={draft.value}
                    onBlur={commit}
                    onChange={(event) => {
                        setDraftState({ canonical, value: event.target.value });
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && !isImeComposing(event))
                            event.currentTarget.blur();
                    }}
                />
                <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted">
                    ms
                </span>
            </span>
            {draft.error && (
                <span className="text-danger" role="alert">
                    {draft.error}
                </span>
            )}
        </label>
    );
}

export function ProviderRecoveryEditor({
    id,
    provider,
    value,
    onChange,
}: ProviderRecoveryEditorProperties) {
    const { t } = useTranslation();
    const providerName = agentProviderCatalog[provider].displayName;
    const canonicalPatterns = value.patterns.join('\n');
    const [patternDraftState, setPatternDraftState] = useState<FieldDraft>({
        canonical: canonicalPatterns,
        value: canonicalPatterns,
    });
    const patternDraft = currentDraft(patternDraftState, canonicalPatterns);

    const commitPatterns = (): void => {
        const result = parseRecoveryPatterns(t, patternDraft.value);
        if (!result.ok) {
            setPatternDraftState({ ...patternDraft, error: result.error });
            return;
        }
        const canonical = result.patterns.join('\n');
        setPatternDraftState({ canonical, value: canonical });
        onChange({ ...value, patterns: result.patterns });
    };
    return (
        <div className="flex flex-col gap-3">
            {value.enabled && (
                <div className="flex flex-col gap-3 rounded-md border border-border bg-elevated p-3">
                    <div className="flex flex-col gap-1">
                        <FieldLabel htmlFor={`${id}-patterns`}>
                            {t('settings.providerRecovery.patternsLabel')}
                        </FieldLabel>
                        <Textarea
                            id={`${id}-patterns`}
                            aria-label={t('settings.providerRecovery.patternsAriaLabel', {
                                provider: providerName,
                            })}
                            aria-invalid={Boolean(patternDraft.error)}
                            className="min-h-24 bg-background font-mono text-foreground"
                            placeholder={RECOVERY_PATTERN_PLACEHOLDERS[provider]}
                            value={patternDraft.value}
                            onBlur={commitPatterns}
                            onChange={(event) => {
                                setPatternDraftState({
                                    canonical: canonicalPatterns,
                                    value: event.target.value,
                                });
                            }}
                        />
                        <FieldDescription>
                            {t('settings.providerRecovery.patternsDescription')}
                        </FieldDescription>
                        {value.patterns.length === 0 && !patternDraft.error && (
                            <p className="m-0 text-[11px] text-muted" role="status">
                                {t('settings.providerRecovery.noPatterns')}
                            </p>
                        )}
                        {patternDraft.error && (
                            <p className="m-0 text-[11px] text-danger" role="alert">
                                {patternDraft.error}
                            </p>
                        )}
                    </div>
                    <div className="flex gap-3">
                        <RecoveryDelayInput
                            label={t('settings.providerRecovery.waitBeforeEsc')}
                            providerName={providerName}
                            value={value.settleDelayMs}
                            onChange={(settleDelayMs) => onChange({ ...value, settleDelayMs })}
                        />
                        <RecoveryDelayInput
                            label={t('settings.providerRecovery.waitBeforeContinue')}
                            providerName={providerName}
                            value={value.continueDelayMs}
                            onChange={(continueDelayMs) => onChange({ ...value, continueDelayMs })}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
