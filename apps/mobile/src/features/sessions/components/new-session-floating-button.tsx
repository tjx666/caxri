import { Pressable, StyleSheet, View } from 'react-native';

import { Plus } from 'lucide-react-native';

import { useTranslation } from '../../../i18n';
import { mobileRadius, mobileSpace } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';

const SIZE = 58;

const styles = StyleSheet.create({
    /**
     * Carries the position and the drop shadow. It does not clip, because clipping here would cut the shadow off.
     */
    shell: {
        borderRadius: mobileRadius.pill,
        bottom: mobileSpace.xl,
        height: SIZE,
        position: 'absolute',
        right: mobileSpace.lg,
        width: SIZE,
    },
    /**
     * Clips the press ripple to the circle. Android draws a bounded ripple as the Pressable's own background layer,
     * which the Pressable's own `overflow` does not clip, so a parent has to.
     */
    clip: {
        borderRadius: mobileRadius.pill,
        height: SIZE,
        overflow: 'hidden',
        width: SIZE,
    },
    button: {
        alignItems: 'center',
        height: SIZE,
        justifyContent: 'center',
        width: SIZE,
    },
});

/**
 * The phone's round New Session button, floating bottom-right over the Session list.
 */
export const NewSessionFloatingButton = ({
    onPress,
    theme,
}: {
    onPress: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View
            style={[
                styles.shell,
                { backgroundColor: theme.primary, boxShadow: `0px 4px 12px ${theme.shadow}` },
            ]}
        >
            <View style={styles.clip}>
                <Pressable
                    accessibilityHint={t('sessions.home.newSessionHint')}
                    accessibilityLabel={t('sessions.new.title')}
                    accessibilityRole="button"
                    android_ripple={{ color: theme.primaryRipple }}
                    onPress={onPress}
                    style={styles.button}
                    testID="new-session-button"
                >
                    <Plus color={theme.primaryForeground} size={28} strokeWidth={2.25} />
                </Pressable>
            </View>
        </View>
    );
};
