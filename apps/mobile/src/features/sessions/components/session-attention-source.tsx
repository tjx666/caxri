/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text } from 'react-native';

import { ChevronRight } from 'lucide-react-native';

import { useTranslation } from '../../../i18n';
import { mobileControl, mobileSpace, mobileType, PRESSED_OPACITY } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileSessionItem } from '../session-model';
import { sessionTitleForDisplay } from '../session-row-model';

/**
 * The line above a request card in the Sessions list naming the Project and Session it came from. A tall card pushes
 * its own row out of view, and a Project filter hides the Project name on the row, so the card names its source itself
 * and opens that Session when tapped.
 */
export const SessionAttentionSource = ({
    onOpen,
    session,
    theme,
}: {
    onOpen: () => void;
    session: Pick<MobileSessionItem, 'projectTitle' | 'title'>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const title = sessionTitleForDisplay(session.title, t);
    return (
        <Pressable
            accessibilityHint={t('sessions.row.openHint')}
            accessibilityLabel={t('sessions.list.attentionSource', {
                project: session.projectTitle,
                title,
            })}
            accessibilityRole="button"
            onPress={onOpen}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            testID="session-attention-source"
        >
            <Text numberOfLines={1} style={[styles.label, { color: theme.muted }]}>
                <Text>{session.projectTitle}</Text>
                <Text>{' · '}</Text>
                <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
            </Text>
            <ChevronRight color={theme.muted} size={16} />
        </Pressable>
    );
};

const styles = StyleSheet.create({
    label: { ...mobileType.meta, flex: 1 },
    pressed: { opacity: PRESSED_OPACITY },
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.xs,
        minHeight: mobileControl.row,
    },
    title: { fontWeight: '600' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
