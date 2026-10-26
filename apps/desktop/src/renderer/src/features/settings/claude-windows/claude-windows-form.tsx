import { useState } from 'react';

import type { ClaudeWindowState } from '@caxri/protocol';

import { Button } from '../../../components/ui/button';
import { FieldDescription } from '../../../components/ui/field';
import { Input } from '../../../components/ui/input';
import { Spinner } from '../../../components/ui/spinner';
import { Switch } from '../../../components/ui/switch';
import { useTranslation } from '../../../i18n';
import { isImeComposing } from '../../../lib/ime';
import { useCaxriQuery } from '../../../queries/client';
import { updateClaudeWindows } from './claude-windows-client';
import {
    formatMinuteOfDay,
    formatWindowTime,
    parseTimeInput,
    summarizeClaudeWindows,
    warmUpMinuteOfDay,
} from './claude-windows-summary';

/**
 * The Claude 5-hour window keeper for the signed-in Claude account: the plan, the `Keep 5-hour windows rolling` switch,
 * the `First workday reset at` time, and read-only schedule and status lines. Times are shown as clock times, not a
 * live countdown, so the card does not re-render every second.
 */
export function ClaudeWindowsForm() {
    const { t } = useTranslation();
    const query = useCaxriQuery('claudeWindow.status', { refresh: false });
    const [isSaving, setIsSaving] = useState(false);
    const [hasSaveFailed, setHasSaveFailed] = useState(false);

    if (!query.data && query.isError)
        return (
            <div className="grid min-h-16 content-center justify-items-start gap-2" role="alert">
                <p className="m-0 text-[12px] text-danger">
                    {t('settings.claudeWindows.loadFailed')}
                </p>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                        void query.refetch();
                    }}
                >
                    {t('common.retry')}
                </Button>
            </div>
        );
    if (!query.data)
        return (
            <div className="flex min-h-16 items-center gap-2 text-[12px] text-muted" role="status">
                <Spinner aria-hidden="true" size={13} style={{ width: 13, height: 13 }} />
                {t('settings.claudeWindows.loading')}
            </div>
        );

    const save = async (changes: { keepRolling?: boolean; firstWorkdayResetMinutes?: number }) => {
        const account = query.data.account;
        if (!account) return;
        setIsSaving(true);
        setHasSaveFailed(false);
        try {
            await updateClaudeWindows({ accountKey: account.key, ...changes });
        } catch {
            setHasSaveFailed(true);
            void query.refetch();
        }
        setIsSaving(false);
    };
    return (
        <ClaudeWindowsCard
            state={query.data}
            isSaving={isSaving}
            hasSaveFailed={hasSaveFailed}
            onSave={(changes) => {
                void save(changes);
            }}
        />
    );
}

interface ClaudeWindowsCardProperties {
    state: ClaudeWindowState;
    isSaving: boolean;
    hasSaveFailed: boolean;
    onSave: (changes: { keepRolling?: boolean; firstWorkdayResetMinutes?: number }) => void;
}

function ClaudeWindowsCard({
    state,
    isSaving,
    hasSaveFailed,
    onSave,
}: ClaudeWindowsCardProperties) {
    const { t } = useTranslation();
    // Server Core stamps every state it returns; the mount time only covers a state without one.
    const [mountedAt] = useState(Date.now);
    const now = state.checkedAt ?? mountedAt;
    const summary = summarizeClaudeWindows(t, state, now);
    const account = state.account;
    const plan =
        account?.planType === 'pro' || account?.planType === 'max'
            ? t(`settings.claudeWindows.plan.${account.planType}`)
            : account?.planType;
    return (
        <div className="grid w-full grid-cols-1 gap-3" data-testid="claude-windows-form">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                {plan && (
                    <span className="text-foreground">
                        {t('settings.claudeWindows.planLine', { plan })}
                    </span>
                )}
                <span className={summary.isProblem ? 'text-danger' : 'text-muted'} role="status">
                    {summary.status}
                </span>
            </div>
            {account && (
                <label className="flex items-start gap-2.5">
                    <Switch
                        checked={account.keepRolling}
                        className="mt-0.5"
                        disabled={isSaving}
                        onCheckedChange={(keepRolling) => onSave({ keepRolling })}
                    />
                    <span className="grid gap-0.5">
                        <span className="text-[12px] text-foreground">
                            {t('settings.claudeWindows.keepRolling')}
                        </span>
                        <FieldDescription>
                            {t('settings.claudeWindows.keepRollingDescription')}
                        </FieldDescription>
                    </span>
                </label>
            )}
            {account?.keepRolling && (
                <div className="grid gap-3 rounded-md border border-border bg-elevated p-3">
                    <FirstWorkdayResetInput
                        disabled={isSaving}
                        minutes={account.firstWorkdayResetMinutes}
                        onChange={(firstWorkdayResetMinutes) =>
                            onSave({ firstWorkdayResetMinutes })
                        }
                    />
                    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
                        {state.nextAnchorAt !== undefined && (
                            <>
                                <dt className="text-muted">
                                    {t('settings.claudeWindows.nextWarmUp')}
                                </dt>
                                <dd className="m-0 text-foreground tabular-nums">
                                    {formatWindowTime(t, state.nextAnchorAt, now)}
                                </dd>
                            </>
                        )}
                        {state.nextWorkdayResetAt !== undefined && (
                            <>
                                <dt className="text-muted">
                                    {t('settings.claudeWindows.nextWorkdayReset')}
                                </dt>
                                <dd className="m-0 text-foreground tabular-nums">
                                    {formatWindowTime(t, state.nextWorkdayResetAt, now)}
                                </dd>
                            </>
                        )}
                        {summary.lastOutcome && (
                            <>
                                <dt className="text-muted">
                                    {t('settings.claudeWindows.lastOutcomeLabel')}
                                </dt>
                                <dd className="m-0 text-foreground">{summary.lastOutcome}</dd>
                            </>
                        )}
                    </dl>
                </div>
            )}
            {summary.backgroundWarning && (
                <p className="m-0 text-[11px] text-warning" role="alert">
                    {summary.backgroundWarning}
                </p>
            )}
            {hasSaveFailed && (
                <p className="m-0 text-[11px] text-danger" role="alert">
                    {t('settings.claudeWindows.saveFailed')}
                </p>
            )}
        </div>
    );
}

function FirstWorkdayResetInput({
    disabled,
    minutes,
    onChange,
}: {
    disabled: boolean;
    minutes: number;
    onChange: (minutes: number) => void;
}) {
    const { t } = useTranslation();
    const canonical = formatMinuteOfDay(minutes);
    const [draft, setDraft] = useState({ canonical, value: canonical });
    const value = draft.canonical === canonical ? draft.value : canonical;
    const commit = () => {
        const next = parseTimeInput(value);
        if (next === undefined || next === minutes) {
            setDraft({ canonical, value: canonical });
            return;
        }
        onChange(next);
    };
    return (
        <label className="grid gap-1">
            <span className="text-[12px] text-foreground">
                {t('settings.claudeWindows.firstWorkdayReset')}
            </span>
            <Input
                className="w-32 bg-background text-foreground tabular-nums"
                disabled={disabled}
                step={60}
                type="time"
                value={value}
                onBlur={commit}
                onChange={(event) => setDraft({ canonical, value: event.target.value })}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && !isImeComposing(event)) event.currentTarget.blur();
                }}
            />
            <FieldDescription>
                {t('settings.claudeWindows.warmUpNote', {
                    warmUp: formatMinuteOfDay(warmUpMinuteOfDay(minutes)),
                    reset: canonical,
                })}
            </FieldDescription>
        </label>
    );
}
