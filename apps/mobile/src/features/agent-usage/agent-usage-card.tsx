/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ExternalLink, TrendingUp } from 'lucide-react-native';

import { AgentAvatar } from '../../components/agent-icon';
import { useTranslation } from '../../i18n';
import { openExternalLink } from '../../lib/open-external-link';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentUsageCard as AgentUsageCardModel, AgentUsageTone } from './agent-usage-model';

const toneColor = (tone: AgentUsageTone, theme: MobileTheme): string =>
    tone === 'success'
        ? theme.success
        : tone === 'warning'
          ? theme.warning
          : tone === 'danger'
            ? theme.danger
            : theme.muted;

const Section = ({
    children,
    isLast = false,
    theme,
    title,
}: {
    children: ReactNode;
    isLast?: boolean;
    theme: MobileTheme;
    title: string;
}) => (
    <View
        style={[
            styles.section,
            isLast ? null : { borderBottomColor: theme.border, borderBottomWidth: 1 },
        ]}
    >
        <Text style={[styles.sectionTitle, { color: theme.muted }]}>{title}</Text>
        {children}
    </View>
);

/**
 * One Agent on the Agent usage screen: its plan windows with what is left and when each resets, the output speed of its
 * most recent Agent, and its provider's public API status with open incidents.
 */
export const AgentUsageCard = ({
    card,
    theme,
}: {
    card: AgentUsageCardModel;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { service } = card;
    return (
        <View
            style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID={`agent-usage-card-${card.provider}`}
        >
            <View style={[styles.heading, { borderBottomColor: theme.border }]}>
                <AgentAvatar kind={card.provider} size={32} theme={theme} />
                <Text
                    accessibilityRole="header"
                    numberOfLines={1}
                    style={[styles.name, { color: theme.text }]}
                >
                    {card.name}
                </Text>
                {service ? (
                    <View
                        accessibilityLabel={`${t('usage.section.status')}: ${service.label}`}
                        accessible
                        style={[styles.badge, { backgroundColor: theme.elevated }]}
                        testID={`agent-usage-status-${card.provider}`}
                    >
                        <View
                            style={[
                                styles.badgeDot,
                                { backgroundColor: toneColor(service.tone, theme) },
                            ]}
                        />
                        <Text style={[styles.badgeText, { color: theme.text }]}>
                            {service.label}
                        </Text>
                    </View>
                ) : null}
            </View>
            <Section theme={theme} title={t('usage.section.limits')}>
                {card.limits.map((row) => (
                    <View
                        accessibilityLabel={[row.label, row.left, row.resetLabel]
                            .filter(Boolean)
                            .join(', ')}
                        accessible
                        key={row.key}
                        style={styles.limit}
                        testID={`agent-usage-limit-${card.provider}-${row.key}`}
                    >
                        <View style={styles.limitHeading}>
                            <Text style={[styles.label, { color: theme.text }]}>{row.label}</Text>
                            <Text
                                style={[
                                    styles.left,
                                    { color: row.isWarning ? theme.warning : theme.text },
                                ]}
                            >
                                {row.left}
                            </Text>
                        </View>
                        <View style={[styles.track, { backgroundColor: theme.elevated }]}>
                            <View
                                style={[
                                    styles.fill,
                                    {
                                        backgroundColor: row.isWarning
                                            ? theme.warning
                                            : theme.primary,
                                        width: `${row.leftPercent}%`,
                                    },
                                ]}
                            />
                        </View>
                        {row.resetLabel ? (
                            <Text style={[styles.detail, { color: theme.muted }]}>
                                {row.resetLabel}
                            </Text>
                        ) : null}
                    </View>
                ))}
                {card.pace ? (
                    <View style={styles.pace} testID={`agent-usage-pace-${card.provider}`}>
                        <TrendingUp color={theme.warning} size={16} />
                        <Text style={[styles.paceText, { color: theme.text }]}>{card.pace}</Text>
                    </View>
                ) : null}
                <Text style={[styles.detail, { color: theme.muted }]}>{card.limitNote}</Text>
            </Section>
            <Section isLast={!service} theme={theme} title={t('usage.section.speed')}>
                {card.speed ? (
                    <View
                        accessible
                        style={styles.speed}
                        testID={`agent-usage-speed-${card.provider}`}
                    >
                        <Text style={[styles.rate, { color: theme.text }]}>{card.speed.rate}</Text>
                        <Text numberOfLines={2} style={[styles.detail, { color: theme.muted }]}>
                            {card.speed.source}
                        </Text>
                    </View>
                ) : (
                    <Text style={[styles.detail, { color: theme.muted }]}>
                        {t('usage.noSpeed')}
                    </Text>
                )}
            </Section>
            {service ? (
                <Section isLast theme={theme} title={t('usage.section.status')}>
                    {service.affected.map((line) => (
                        <Text key={line} style={[styles.body, { color: theme.text }]}>
                            {line}
                        </Text>
                    ))}
                    {service.incidents.map((incident) => (
                        <Pressable
                            accessibilityRole="link"
                            key={incident.key}
                            onPress={() => {
                                void openExternalLink(incident.url);
                            }}
                            style={({ pressed }) => [
                                styles.incident,
                                {
                                    backgroundColor: pressed ? theme.elevated : 'transparent',
                                    borderColor: theme.border,
                                },
                            ]}
                            testID={`agent-usage-incident-${card.provider}`}
                        >
                            <Text style={[styles.label, { color: theme.text }]}>
                                {incident.name}
                            </Text>
                            <Text style={[styles.detail, { color: theme.warning }]}>
                                {incident.detail}
                            </Text>
                            {incident.latestUpdate ? (
                                <Text
                                    numberOfLines={4}
                                    style={[styles.detail, { color: theme.muted }]}
                                >
                                    {incident.latestUpdate}
                                </Text>
                            ) : null}
                        </Pressable>
                    ))}
                    <Text style={[styles.detail, { color: theme.muted }]}>{service.note}</Text>
                    <Pressable
                        accessibilityRole="link"
                        hitSlop={{ bottom: 8, top: 8 }}
                        onPress={() => {
                            void openExternalLink(service.pageUrl);
                        }}
                        style={styles.link}
                        testID={`agent-usage-status-page-${card.provider}`}
                    >
                        <ExternalLink color={theme.primary} size={14} />
                        <Text style={[styles.linkText, { color: theme.primary }]}>
                            {t('usage.openStatusPage')}
                        </Text>
                    </Pressable>
                </Section>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    card: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
    heading: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
    },
    name: { flex: 1, fontSize: 17, fontWeight: '700' },
    badge: {
        alignItems: 'center',
        borderRadius: 12,
        flexDirection: 'row',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 4,
    },
    badgeDot: { borderRadius: 4, height: 8, width: 8 },
    badgeText: { fontSize: 12, fontWeight: '600' },
    section: { gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
    sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
    limit: { gap: 6 },
    limitHeading: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
    label: { flexShrink: 1, fontSize: 15, fontWeight: '600' },
    left: { fontSize: 15, fontVariant: ['tabular-nums'], fontWeight: '600' },
    track: { borderRadius: 3, height: 6, overflow: 'hidden' },
    fill: { borderRadius: 3, height: 6 },
    detail: { fontSize: 13, lineHeight: 18 },
    body: { fontSize: 14, lineHeight: 20 },
    pace: { alignItems: 'flex-start', flexDirection: 'row', gap: 8 },
    paceText: { flex: 1, fontSize: 13, lineHeight: 18 },
    speed: { gap: 2 },
    rate: { fontSize: 22, fontVariant: ['tabular-nums'], fontWeight: '700' },
    incident: { borderRadius: 10, borderWidth: 1, gap: 4, padding: 10 },
    link: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', gap: 6 },
    linkText: { fontSize: 14, fontWeight: '600' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
