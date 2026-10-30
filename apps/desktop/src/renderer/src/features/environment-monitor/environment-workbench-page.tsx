import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import type { EnvironmentMonitorIpProfile, EnvironmentMonitorState } from '@caxri/protocol';
import { Check, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { ReportCard, StatTile } from '../../components/report-card';
import { Button } from '../../components/ui/button';
import { usePolledQuery } from '../../hooks/use-polled-query';
import type { Translate, TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { formatDateTime } from '../../lib/locale-format';
import { cn } from '../../lib/utilities';
import { caxriQueryKey, queryClient } from '../../queries/client';
import { tryCommand } from '../../stores/toasts';
import { checkEnvironmentNow, useCurrentEnvironmentIp } from './environment-monitor-client';
import type { EnvironmentChange, EnvironmentChangeField } from './environment-monitor-presentation';
import {
    environmentChanges,
    environmentIssueLabel,
    locationDetailLabel,
    locationLabel,
    networkLabel,
} from './environment-monitor-presentation';

const STATUS_POLL_INTERVAL_MS = 5_000;

const CHANGE_LABEL_KEYS: Record<EnvironmentChangeField, TranslationKey> = {
    publicIp: 'environment.change.publicIp',
    country: 'environment.change.country',
    region: 'environment.change.region',
    city: 'environment.change.city',
    asn: 'environment.change.asn',
    isp: 'environment.change.isp',
    organization: 'environment.change.organization',
    networkType: 'environment.change.networkType',
    operator: 'environment.change.operator',
    riskScore: 'environment.signal.riskScore',
    anonymous: 'environment.signal.anonymous',
    compromised: 'environment.signal.compromised',
    hosting: 'environment.signal.hosting',
    proxy: 'environment.signal.proxy',
    scraper: 'environment.signal.scraper',
    tor: 'environment.signal.tor',
    vpn: 'environment.signal.vpn',
};

const MIHOMO_STATUS_LABEL_KEYS: Record<
    EnvironmentMonitorState['mihomo']['status'],
    TranslationKey
> = {
    available: 'environment.checks.mihomo.available',
    off: 'environment.checks.mihomo.off',
    unavailable: 'environment.checks.mihomo.unavailable',
};

const ROUTE_STATUS_LABEL_KEYS: Record<
    EnvironmentMonitorState['mihomo']['routes'][number]['status'],
    TranslationKey
> = {
    matched: 'environment.checks.route.matched',
    mismatch: 'environment.checks.route.mismatch',
    unobserved: 'environment.checks.route.unobserved',
};

const SIGNALS: ReadonlyArray<{
    field: keyof Extract<EnvironmentMonitorIpProfile, { status: 'available' }>['signals'];
    labelKey: TranslationKey;
}> = [
    { field: 'hosting', labelKey: 'environment.signal.hosting' },
    { field: 'proxy', labelKey: 'environment.signal.proxy' },
    { field: 'vpn', labelKey: 'environment.signal.vpn' },
    { field: 'tor', labelKey: 'environment.signal.tor' },
    { field: 'anonymous', labelKey: 'environment.signal.anonymous' },
    { field: 'compromised', labelKey: 'environment.signal.compromised' },
    { field: 'scraper', labelKey: 'environment.signal.scraper' },
];

function signalValue(t: Translate, value: boolean | undefined): string {
    const key =
        value === undefined
            ? 'environment.value.unknown'
            : value
              ? 'environment.value.reported'
              : 'environment.value.notReported';
    return t(key);
}

function Signal({ label, value }: { label: string; value: boolean | undefined }) {
    const { t } = useTranslation();
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1 text-[11px]',
                value === true &&
                    'border-[color-mix(in_srgb,var(--warning)_45%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-warning',
                value !== true && 'text-muted',
            )}
        >
            <span className="font-medium text-foreground">{label}</span>
            {signalValue(t, value)}
        </span>
    );
}

function RiskScore({ value }: { value: number | undefined }) {
    const { t } = useTranslation();
    return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1 text-[11px] text-muted">
            <span className="font-medium text-foreground">{t('environment.signal.riskScore')}</span>
            {value === undefined
                ? t('environment.value.unknown')
                : t('environment.value.riskScore', { score: value })}
        </span>
    );
}

function CurrentExitCard({ state }: { state: EnvironmentMonitorState }) {
    const { t } = useTranslation();
    const observation = state.publicIp?.current;
    if (!observation)
        return (
            <ReportCard title={t('environment.current.title')}>
                <p className="m-0 text-[12px] text-muted">{t('environment.current.notChecked')}</p>
            </ReportCard>
        );

    const profile = observation.profile;
    const available = profile.status === 'available' ? profile : undefined;
    return (
        <ReportCard
            title={t('environment.current.title')}
            caption={t('environment.current.observedAt', {
                time: formatDateTime(observation.observedAt, t.locale),
            })}
        >
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <StatTile
                    label={t('environment.current.publicIp')}
                    value={observation.address}
                    detail={t('environment.current.ipVersion', { version: observation.family })}
                    wrapValue
                />
                <StatTile
                    label={t('environment.current.location')}
                    value={locationLabel(profile)}
                    detail={locationDetailLabel(profile)}
                    wrapValue
                />
                <StatTile
                    label={t('environment.current.network')}
                    value={networkLabel(profile)}
                    wrapValue
                />
                <StatTile
                    label={t('environment.current.organization')}
                    value={available?.organization}
                    wrapValue
                />
                <StatTile
                    label={t('environment.current.operator')}
                    value={available?.operator}
                    wrapValue
                />
                <StatTile
                    label={t('environment.current.networkType')}
                    value={available?.networkType}
                    detail={t('environment.current.thirdPartyClassification')}
                    wrapValue
                />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
                <RiskScore value={available?.riskScore} />
                {SIGNALS.map(({ field, labelKey }) => (
                    <Signal key={field} label={t(labelKey)} value={available?.signals[field]} />
                ))}
            </div>
            <div className="mt-3 text-[11px] leading-[1.45] text-muted">
                {profile.status === 'available'
                    ? t('environment.current.source', {
                          source: profile.source,
                          time: formatDateTime(profile.checkedAt, t.locale),
                      })
                    : t('environment.current.profileUnavailable', { source: profile.source })}
            </div>
        </ReportCard>
    );
}

function changeValue(
    t: Translate,
    field: EnvironmentChangeField,
    value: boolean | number | string,
): string {
    if (field === 'riskScore') return t('environment.value.riskScore', { score: String(value) });
    return typeof value === 'boolean' ? signalValue(t, value) : String(value);
}

function ChangesCard({ changes }: { changes: EnvironmentChange[] }) {
    const { t } = useTranslation();
    return (
        <ReportCard title={t('environment.changes.title')}>
            {changes.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">{t('environment.changes.none')}</p>
            ) : (
                <div className="grid gap-2">
                    {changes.map((change) => (
                        <div
                            key={change.field}
                            className="grid gap-1 rounded-md bg-elevated px-3 py-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-baseline"
                        >
                            <span className="text-[11px] font-medium text-muted">
                                {t(CHANGE_LABEL_KEYS[change.field])}
                            </span>
                            <span className="text-[12px] wrap-anywhere">
                                <span className="text-muted">
                                    {changeValue(t, change.field, change.previous)}
                                </span>{' '}
                                → {changeValue(t, change.field, change.current)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </ReportCard>
    );
}

function statusTone(status: 'matched' | 'mismatch' | 'unobserved'): string {
    return status === 'matched'
        ? 'text-success'
        : status === 'mismatch'
          ? 'text-warning'
          : 'text-muted';
}

function ChecksCard({ state }: { state: EnvironmentMonitorState }) {
    const { t } = useTranslation();
    return (
        <ReportCard title={t('environment.checks.title')}>
            <div className="grid gap-3">
                <div className="flex items-start justify-between gap-4 border-b border-border pb-3">
                    <div>
                        <div className="text-[12px] font-medium">
                            {t('environment.checks.systemTimeZone')}
                        </div>
                        <div className="mt-1 text-[11px] text-muted">
                            {state.timeZone.expected
                                ? t('environment.checks.timeZoneExpected', {
                                      actual: state.timeZone.actual,
                                      expected: state.timeZone.expected,
                                  })
                                : t('environment.checks.timeZoneNotConfigured', {
                                      actual: state.timeZone.actual,
                                  })}
                        </div>
                    </div>
                    {state.issues.some((issue) => issue.kind === 'timeZoneMismatch') ? (
                        <TriangleAlert
                            aria-label={t('environment.value.warning')}
                            className="text-warning"
                            size={15}
                        />
                    ) : (
                        <Check
                            aria-label={t('environment.value.ok')}
                            className="text-success"
                            size={15}
                        />
                    )}
                </div>
                <div>
                    <div className="flex items-baseline justify-between gap-3">
                        <div className="text-[12px] font-medium">
                            {t('environment.checks.mihomoRoutes')}
                        </div>
                        <span className="text-[11px] text-muted">
                            {t(MIHOMO_STATUS_LABEL_KEYS[state.mihomo.status])}
                        </span>
                    </div>
                    {state.mihomo.routes.length === 0 ? (
                        <p className="mt-1 mb-0 text-[11px] text-muted">
                            {t('environment.checks.routesNotConfigured')}
                        </p>
                    ) : (
                        <div className="mt-2 grid gap-2">
                            {state.mihomo.routes.map((route) => (
                                <div
                                    key={route.domain}
                                    className="grid gap-1 rounded-md bg-elevated px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline"
                                >
                                    <div className="min-w-0">
                                        <div className="truncate text-[12px]">{route.domain}</div>
                                        <div className="mt-0.5 text-[11px] wrap-anywhere text-muted">
                                            {route.observedChain.length > 0
                                                ? t('environment.checks.routeObserved', {
                                                      actual: route.observedChain.join(' → '),
                                                      expected: route.expectedNode,
                                                  })
                                                : t('environment.checks.routeUnobserved', {
                                                      expected: route.expectedNode,
                                                  })}
                                        </div>
                                    </div>
                                    <span className={cn('text-[11px]', statusTone(route.status))}>
                                        {t(ROUTE_STATUS_LABEL_KEYS[route.status])}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                {state.issues.length > 0 && (
                    <div className="border-t border-border pt-3">
                        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-warning">
                            <ShieldAlert aria-hidden="true" size={14} />
                            {t('environment.checks.warnings')}
                        </div>
                        <ul className="m-0 grid gap-1.5 pl-5 text-[11px] leading-[1.45]">
                            {state.issues.map((issue) => (
                                <li key={environmentIssueLabel(issue, t)}>
                                    {environmentIssueLabel(issue, t)}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </ReportCard>
    );
}

export function EnvironmentWorkbenchPage({ headerAction }: { headerAction?: ReactNode } = {}) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState<'check' | 'useIp'>();
    const query = usePolledQuery('environmentMonitor.read', undefined, {
        label: 'environmentMonitor.read',
        intervalMs: STATUS_POLL_INTERVAL_MS,
        retry: false,
    });
    useEffect(() => {
        let isDisposed = false;
        void checkEnvironmentNow()
            .then((result) => {
                if (!isDisposed)
                    queryClient.setQueryData(
                        caxriQueryKey('environmentMonitor.read', undefined),
                        result,
                    );
            })
            .catch((error: unknown) => {
                // The polled query below owns the visible error state; this keeps the cause for diagnostics.
                console.error('environmentMonitor.check failed on mount', error);
            });
        return () => {
            isDisposed = true;
        };
    }, []);

    const update = async (
        action: 'check' | 'useIp',
        run: typeof checkEnvironmentNow,
    ): Promise<void> => {
        if (busy) return;
        setBusy(action);
        const result = await tryCommand(t('environment.actionFailed'), run);
        if (result)
            queryClient.setQueryData(caxriQueryKey('environmentMonitor.read', undefined), result);
        setBusy(undefined);
    };

    const state = query.data;
    return (
        <div
            data-environment-page
            className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-px"
        >
            <div className="flex flex-wrap items-end justify-between gap-3 bg-surface pt-4 pr-4 pb-3 pl-4">
                <div className="min-w-0">
                    <h1 className="m-0 text-[15px] font-semibold">{t('environment.title')}</h1>
                    <p className="mt-1 mb-0 text-[11px] leading-[1.45] text-muted">
                        {state?.checkedAt
                            ? t('environment.lastChecked', {
                                  time: formatDateTime(state.checkedAt, t.locale),
                              })
                            : t('environment.description')}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {state?.canUseCurrentIp && (
                        <Button
                            aria-disabled={Boolean(busy)}
                            size="sm"
                            variant="secondary"
                            onClick={async () => update('useIp', useCurrentEnvironmentIp)}
                        >
                            {t('environment.useCurrentIp')}
                        </Button>
                    )}
                    <Button
                        aria-disabled={Boolean(busy)}
                        size="sm"
                        variant="secondary"
                        onClick={async () => update('check', checkEnvironmentNow)}
                    >
                        <RefreshCw
                            aria-hidden="true"
                            className={
                                busy === 'check' ? 'animate-spin motion-reduce:animate-none' : ''
                            }
                            size={13}
                        />
                        {t('environment.checkNow')}
                    </Button>
                    {headerAction}
                </div>
            </div>
            <div className="min-h-0 overflow-y-auto p-4">
                {state ? (
                    <div className="mx-auto grid w-full max-w-6xl gap-4">
                        <CurrentExitCard state={state} />
                        <div className="grid items-start gap-4 xl:grid-cols-2">
                            <ChangesCard changes={environmentChanges(state)} />
                            <ChecksCard state={state} />
                        </div>
                    </div>
                ) : query.isError ? (
                    <div
                        role="alert"
                        className="mx-auto grid min-h-40 w-full max-w-6xl place-items-center content-center gap-3 text-center text-muted"
                    >
                        <p className="m-0 text-[12px] text-danger">{t('environment.loadFailed')}</p>
                        <Button
                            aria-disabled={query.isFetching}
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                                if (!query.isFetching) void query.refetch();
                            }}
                        >
                            {t('common.retry')}
                        </Button>
                    </div>
                ) : (
                    <LoadingSkeleton variant="page" label={t('environment.loading')} />
                )}
            </div>
        </div>
    );
}
