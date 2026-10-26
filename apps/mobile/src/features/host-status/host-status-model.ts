import type {
    AppLocale,
    MobileHostProcess,
    MobileHostService,
    MobileHostServiceRole,
    MobileHostSessionLoad,
    MobileHostSystem,
    MobileHostTerminalLoad,
    TerminalKind,
} from '@caxri/protocol';
import { formatCpuPercent, formatMemoryMb, isTerminalResourceUsageHigh } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { mobileAgentDisplayName } from '../sessions/agent-display-name';

/**
 * How often the screen re-reads while it is visible, the cadence Desktop's Process Explorer and the resource popovers
 * of Superset and Orca use. Like theirs, nothing polls while the screen is closed or the app is in the background.
 */
export const HOST_STATUS_POLL_MS = 2_000;

export type HostStatusScreenState =
    | { kind: 'ready'; isStale: boolean; hasRefreshError: boolean }
    | { kind: 'loading' }
    | { kind: 'offline' }
    | { kind: 'error' };

/**
 * Data already read stays on screen when the phone goes offline or a refresh fails, with a banner saying so; without
 * data, offline and failure each get their own message.
 */
export const hostStatusScreenState = ({
    hasData,
    isError,
    isObservable,
}: {
    hasData: boolean;
    isError: boolean;
    isObservable: boolean;
}): HostStatusScreenState => {
    if (hasData)
        return { kind: 'ready', isStale: !isObservable, hasRefreshError: isObservable && isError };
    if (!isObservable) return { kind: 'offline' };
    return isError ? { kind: 'error' } : { kind: 'loading' };
};

/**
 * How full a meter reads: `danger` from 90%, `warning` from 75%, the same bands a system monitor uses for a resource
 * the user should look at.
 */
export type MeterLevel = 'normal' | 'warning' | 'danger';

export const meterLevel = (ratio: number): MeterLevel =>
    ratio >= 0.9 ? 'danger' : ratio >= 0.75 ? 'warning' : 'normal';

/**
 * A sorted copy. The phone's Hermes runtime lacks ES2023 `toSorted`, so this sorts a fresh copy in place.
 */
const sortedCopy = <T>(items: readonly T[], compare: (left: T, right: T) => number): T[] =>
    // eslint-disable-next-line unicorn/no-array-sort -- Sorts the fresh copy; see above.
    [...items].sort(compare);

export interface MeterModel {
    detail: string;
    level: MeterLevel;
    /**
     * 0–1, or `null` when there is no reading yet.
     */
    ratio: number | null;
    value: string;
}

const clampRatio = (value: number): number => Math.min(Math.max(value, 0), 1);

const formatLoad = (value: number): string => value.toFixed(2);

export const formatUptime = (seconds: number, t: Translate = translate): string => {
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return t('hostStatus.uptime.days', { days, hours: hours % 24 });
    if (hours > 0) return t('hostStatus.uptime.hours', { hours, minutes: minutes % 60 });
    return t('hostStatus.uptime.minutes', { minutes });
};

export interface SystemModel {
    cpu: MeterModel;
    memory: MeterModel;
    uptime: string;
}

export const systemModel = (system: MobileHostSystem, t: Translate = translate): SystemModel => {
    const [one, five, fifteen] = system.loadAverage;
    const cpuRatio = system.cpuPercent === undefined ? null : clampRatio(system.cpuPercent / 100);
    const memoryRatio =
        system.memoryTotalMb > 0 ? clampRatio(system.memoryUsedMb / system.memoryTotalMb) : null;
    return {
        cpu: {
            ratio: cpuRatio,
            level: meterLevel(cpuRatio ?? 0),
            value: system.cpuPercent === undefined ? '—' : `${Math.round(system.cpuPercent)}%`,
            detail: t('hostStatus.system.cpuDetail', {
                count: system.cpuCount,
                load: [one, five, fifteen].map(formatLoad).join(' · '),
            }),
        },
        memory: {
            ratio: memoryRatio,
            level: meterLevel(memoryRatio ?? 0),
            value: t('hostStatus.system.memoryValue', {
                used: formatMemoryMb(system.memoryUsedMb),
                total: formatMemoryMb(system.memoryTotalMb),
            }),
            detail:
                system.swapUsedMb === undefined
                    ? ''
                    : t('hostStatus.system.swap', { swap: formatMemoryMb(system.swapUsedMb) }),
        },
        uptime: t('hostStatus.system.uptime', { uptime: formatUptime(system.uptimeSeconds, t) }),
    };
};

export interface UsageLabels {
    cpu: string;
    memory: string;
}

const usageLabels = (usage: { cpuPercent: number; memoryMb: number }): UsageLabels => ({
    cpu: formatCpuPercent(usage.cpuPercent),
    memory: formatMemoryMb(usage.memoryMb),
});

/**
 * Named the way Desktop's Process Explorer names a Terminal row: the Agent for an Agent Terminal, else the Terminal's
 * title.
 */
const terminalName = (terminal: MobileHostTerminalLoad, t: Translate): string =>
    terminal.provider
        ? mobileAgentDisplayName(terminal.provider)
        : terminal.title || t('hostStatus.sessions.terminal');

interface TerminalRowModel extends UsageLabels {
    id: string;
    isHigh: boolean;
    kind: TerminalKind;
    name: string;
    processes: string;
}

export interface SessionRowModel extends UsageLabels {
    id: string;
    /**
     * Over the shared alert thresholds in at least one Terminal, the same rule that raises Desktop's resource alert.
     */
    isHigh: boolean;
    /**
     * The busiest Terminal's kind, so the row reads by Agent first like the Session list.
     */
    kind: TerminalKind | undefined;
    processes: string;
    terminals: TerminalRowModel[];
    /**
     * Running Terminals left out of `terminals` by the Server's per-Session cap.
     */
    hiddenTerminals: number;
    title: string;
}

export const sessionRows = (
    sessions: readonly MobileHostSessionLoad[],
    t: Translate = translate,
): SessionRowModel[] =>
    sessions.map((session) => {
        const terminals = session.terminals.map((terminal): TerminalRowModel => ({
            id: terminal.terminalId,
            name: terminalName(terminal, t),
            isHigh: isTerminalResourceUsageHigh(terminal),
            kind: terminal.kind,
            processes: t('hostStatus.processCount', { count: terminal.processCount }),
            ...usageLabels(terminal),
        }));
        return {
            id: session.sessionId,
            title: session.title || t('hostStatus.sessions.untitled'),
            isHigh: terminals.some((terminal) => terminal.isHigh),
            kind: terminals[0]?.kind,
            processes: t('hostStatus.processCount', { count: session.processCount }),
            terminals,
            hiddenTerminals: Math.max(0, session.terminalTotal - session.terminals.length),
            ...usageLabels(session),
        };
    });

/**
 * Product names, the same in every language, as Desktop's Process Explorer shows them.
 */
const SERVICE_NAMES: Readonly<Record<MobileHostServiceRole, string>> = {
    serverCore: 'Server Core',
    terminalHost: 'Terminal Host',
    extensionHost: 'Extension Host',
};

const SERVICE_ORDER: readonly MobileHostServiceRole[] = [
    'serverCore',
    'terminalHost',
    'extensionHost',
];

export interface ProcessRowModel extends UsageLabels {
    id: string;
    name: string;
    pid: string;
}

export const serviceRows = (services: readonly MobileHostService[]): ProcessRowModel[] =>
    sortedCopy(
        services,
        (left, right) => SERVICE_ORDER.indexOf(left.role) - SERVICE_ORDER.indexOf(right.role),
    ).map((service) => ({
        id: `${service.role}-${service.pid}`,
        name: SERVICE_NAMES[service.role],
        pid: String(service.pid),
        ...usageLabels(service),
    }));

/**
 * The top-processes sort toggle, as Superset's and cmux's resource views offer.
 */
export type ProcessSort = 'cpu' | 'memory';

/**
 * The busiest processes in the chosen order. The Server sends the top entries of both orders, so either sort shows the
 * true top ten.
 */
export const topProcessRows = (
    processes: readonly MobileHostProcess[],
    sort: ProcessSort,
    limit = 10,
): ProcessRowModel[] =>
    sortedCopy(processes, (left, right) =>
        sort === 'cpu'
            ? right.cpuPercent - left.cpuPercent || right.memoryMb - left.memoryMb
            : right.memoryMb - left.memoryMb || right.cpuPercent - left.cpuPercent,
    )
        .slice(0, limit)
        .map((process) => ({
            id: String(process.pid),
            name: process.name,
            pid: String(process.pid),
            ...usageLabels(process),
        }));

/**
 * When the reading was taken, to the second, so a frozen screen is visible at a glance.
 */
export const formatSampledAt = (at: number, locale: AppLocale): string =>
    new Date(at).toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
