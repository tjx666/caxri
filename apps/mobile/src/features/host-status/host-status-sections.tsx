/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChevronRight } from 'lucide-react-native';

import { AgentAvatar, AgentGlyph } from '../../components/agent-icon';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import type {
    MeterLevel,
    MeterModel,
    ProcessRowModel,
    ProcessSort,
    SessionRowModel,
    SystemModel,
} from './host-status-model';
import { moreTerminalsLabel } from './host-status-model';

const levelColor = (level: MeterLevel, theme: MobileTheme): string =>
    level === 'danger' ? theme.danger : level === 'warning' ? theme.warning : theme.primary;

export const HostStatusSection = ({
    accessory,
    children,
    footer,
    testID,
    theme,
    title,
}: {
    accessory?: ReactNode;
    children: ReactNode;
    footer?: string;
    testID: string;
    theme: MobileTheme;
    title: string;
}) => (
    <View style={styles.section} testID={testID}>
        <View style={styles.sectionHeader}>
            <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.muted }]}>
                {title}
            </Text>
            {accessory}
        </View>
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            {children}
        </View>
        {footer ? <Text style={[styles.footer, { color: theme.muted }]}>{footer}</Text> : null}
    </View>
);

const Meter = ({
    label,
    meter,
    testID,
    theme,
}: {
    label: string;
    meter: MeterModel;
    testID: string;
    theme: MobileTheme;
}) => (
    <View
        accessibilityLabel={`${label} ${meter.value}${meter.detail ? `, ${meter.detail}` : ''}`}
        accessible
        style={styles.meter}
        testID={testID}
    >
        <View style={styles.meterHeading}>
            <Text style={[styles.meterLabel, { color: theme.text }]}>{label}</Text>
            <Text
                style={[
                    styles.meterValue,
                    {
                        color:
                            meter.level === 'normal' ? theme.text : levelColor(meter.level, theme),
                    },
                ]}
            >
                {meter.value}
            </Text>
        </View>
        <View style={[styles.track, { backgroundColor: theme.elevated }]}>
            <View
                style={[
                    styles.fill,
                    {
                        backgroundColor: levelColor(meter.level, theme),
                        width: `${Math.round((meter.ratio ?? 0) * 100)}%`,
                    },
                ]}
            />
        </View>
        {meter.detail ? (
            <Text style={[styles.meterDetail, { color: theme.muted }]}>{meter.detail}</Text>
        ) : null}
    </View>
);

export const HostSystemCard = ({ system, theme }: { system: SystemModel; theme: MobileTheme }) => {
    const { t } = useTranslation();
    return (
        <>
            <Meter
                label={t('hostStatus.system.cpu')}
                meter={system.cpu}
                testID="host-status-cpu"
                theme={theme}
            />
            <View style={[styles.divider, { backgroundColor: theme.border }]} />
            <Meter
                label={t('hostStatus.system.memory')}
                meter={system.memory}
                testID="host-status-memory"
                theme={theme}
            />
            <View style={[styles.divider, { backgroundColor: theme.border }]} />
            <Text style={[styles.uptime, { color: theme.muted }]} testID="host-status-uptime">
                {system.uptime}
            </Text>
        </>
    );
};

const Usage = ({
    cpu,
    isHigh = false,
    memory,
    theme,
}: {
    cpu: string;
    isHigh?: boolean;
    memory: string;
    theme: MobileTheme;
}) => (
    <View style={styles.usage}>
        <Text style={[styles.usageCpu, { color: isHigh ? theme.danger : theme.text }]}>{cpu}</Text>
        <Text style={[styles.usageMemory, { color: isHigh ? theme.danger : theme.muted }]}>
            {memory}
        </Text>
    </View>
);

export const HostSessionRow = ({
    isLast,
    onOpen,
    row,
    theme,
}: {
    isLast: boolean;
    onOpen: (sessionId: string) => void;
    row: SessionRowModel;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <Pressable
            accessibilityHint={t('hostStatus.sessions.openHint')}
            accessibilityLabel={`${row.title}, ${row.cpu}, ${row.memory}${row.isHigh ? `, ${t('hostStatus.sessions.high')}` : ''}`}
            accessibilityRole="button"
            onPress={() => onOpen(row.id)}
            style={({ pressed }) => [
                styles.sessionRow,
                pressed ? { backgroundColor: theme.elevated } : null,
                isLast ? null : { borderBottomColor: theme.border, borderBottomWidth: 1 },
            ]}
            testID={`host-status-session-${row.id}`}
        >
            <View style={styles.sessionHeading}>
                <AgentAvatar kind={row.kind} size={32} theme={theme} />
                <View style={styles.sessionMain}>
                    <Text numberOfLines={1} style={[styles.sessionTitle, { color: theme.text }]}>
                        {row.title}
                    </Text>
                    <Text
                        numberOfLines={1}
                        style={[
                            styles.secondary,
                            { color: row.isHigh ? theme.danger : theme.muted },
                        ]}
                    >
                        {row.isHigh
                            ? `${t('hostStatus.sessions.high')} · ${row.processes}`
                            : row.processes}
                    </Text>
                </View>
                <Usage cpu={row.cpu} isHigh={row.isHigh} memory={row.memory} theme={theme} />
                <ChevronRight color={theme.muted} size={18} />
            </View>
            {row.terminals.length > 1 || row.hiddenTerminals > 0 ? (
                <View style={styles.terminals}>
                    {row.terminals.map((terminal) => (
                        <View
                            key={terminal.id}
                            style={styles.terminalRow}
                            testID={`host-status-terminal-${terminal.id}`}
                        >
                            <AgentGlyph kind={terminal.kind} size={14} theme={theme} />
                            <Text
                                numberOfLines={1}
                                style={[
                                    styles.terminalName,
                                    { color: terminal.isHigh ? theme.danger : theme.text },
                                ]}
                            >
                                {terminal.name}
                            </Text>
                            <Text style={[styles.terminalUsage, { color: theme.muted }]}>
                                {`${terminal.cpu} · ${terminal.memory}`}
                            </Text>
                        </View>
                    ))}
                    {row.hiddenTerminals > 0 ? (
                        <Text style={[styles.secondary, { color: theme.muted }]}>
                            {moreTerminalsLabel(row.hiddenTerminals, t)}
                        </Text>
                    ) : null}
                </View>
            ) : null}
        </Pressable>
    );
};

export const HostProcessRow = ({
    isLast,
    row,
    testID,
    theme,
}: {
    isLast: boolean;
    row: ProcessRowModel;
    testID: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View
            accessibilityLabel={`${row.name}, ${row.cpu}, ${row.memory}`}
            accessible
            style={[
                styles.processRow,
                isLast ? null : { borderBottomColor: theme.border, borderBottomWidth: 1 },
            ]}
            testID={testID}
        >
            <View style={styles.processMain}>
                <Text numberOfLines={1} style={[styles.processName, { color: theme.text }]}>
                    {row.name}
                </Text>
                <Text style={[styles.secondary, { color: theme.muted }]}>
                    {t('hostStatus.pid', { pid: row.pid })}
                </Text>
            </View>
            <Usage cpu={row.cpu} memory={row.memory} theme={theme} />
        </View>
    );
};

export const ProcessSortToggle = ({
    onChange,
    sort,
    theme,
}: {
    onChange: (sort: ProcessSort) => void;
    sort: ProcessSort;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const options: Array<{ label: string; value: ProcessSort }> = [
        { label: t('hostStatus.processes.sortCpu'), value: 'cpu' },
        { label: t('hostStatus.processes.sortMemory'), value: 'memory' },
    ];
    return (
        <View
            accessibilityLabel={t('hostStatus.processes.sortLabel')}
            accessibilityRole="radiogroup"
            style={[styles.toggle, { backgroundColor: theme.surface, borderColor: theme.border }]}
        >
            {options.map((option) => {
                const isSelected = option.value === sort;
                return (
                    <Pressable
                        accessibilityRole="radio"
                        accessibilityState={{ checked: isSelected }}
                        hitSlop={{ bottom: 8, top: 8 }}
                        key={option.value}
                        onPress={() => onChange(option.value)}
                        style={[
                            styles.toggleOption,
                            isSelected ? { backgroundColor: theme.elevated } : null,
                        ]}
                        testID={`host-status-sort-${option.value}`}
                    >
                        <Text
                            style={[
                                styles.toggleText,
                                { color: isSelected ? theme.text : theme.muted },
                            ]}
                        >
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
};

const styles = StyleSheet.create({
    section: { gap: 8 },
    sectionHeader: {
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
        minHeight: 28,
        paddingHorizontal: 4,
    },
    sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
    card: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
    footer: { fontSize: 12, paddingHorizontal: 4 },
    divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16 },
    meter: { gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
    meterHeading: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
    meterLabel: { fontSize: 15, fontWeight: '600' },
    meterValue: { fontSize: 20, fontVariant: ['tabular-nums'], fontWeight: '700' },
    meterDetail: { fontSize: 13, fontVariant: ['tabular-nums'] },
    track: { borderRadius: 3, height: 6, overflow: 'hidden' },
    fill: { borderRadius: 3, height: 6 },
    uptime: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 12 },
    usage: { alignItems: 'flex-end', minWidth: 72 },
    usageCpu: { fontSize: 15, fontVariant: ['tabular-nums'], fontWeight: '600' },
    usageMemory: { fontSize: 12, fontVariant: ['tabular-nums'] },
    sessionRow: { gap: 8, paddingHorizontal: 14, paddingVertical: 12 },
    sessionHeading: { alignItems: 'center', flexDirection: 'row', gap: 12 },
    sessionMain: { flex: 1, gap: 2 },
    sessionTitle: { fontSize: 15, fontWeight: '600' },
    secondary: { fontSize: 12 },
    terminals: { gap: 6, paddingLeft: 44, paddingRight: 30 },
    terminalRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
    terminalName: { flex: 1, fontSize: 13 },
    terminalUsage: { fontSize: 12, fontVariant: ['tabular-nums'] },
    processRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
        minHeight: 52,
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    processMain: { flex: 1, gap: 2 },
    processName: { fontSize: 14, fontWeight: '500' },
    toggle: { borderRadius: 8, borderWidth: 1, flexDirection: 'row', padding: 2 },
    toggleOption: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
    toggleText: { fontSize: 12, fontWeight: '600' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
