/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import * as Clipboard from 'expo-clipboard';
import { Check, CircleAlert, Copy } from 'lucide-react-native';

import { useTranslation } from '../i18n';
import type { MobileTheme } from '../theme/tokens';

/**
 * How long Copy shows its confirmation, matching Desktop's `COPY_FEEDBACK_RESET_MS`.
 */
const COPY_FEEDBACK_RESET_MS = 2000;

/**
 * Copies a code block or quote from its top-right corner, which the parent must position against. It confirms in place,
 * like Desktop's `CopyIconButton`, instead of with a toast: a block inside an Android `Modal` sheet would cover the
 * app's root toast, so a toast there would never be seen. Selecting a long block by hand on a phone stops at the screen
 * edge, so this is the way to take all of it.
 */
export const CopyButton = ({
    label: idleLabel,
    onCopied,
    text,
    testID,
    theme,
}: {
    /**
     * The accessible name while idle, such as "Copy code" or "Copy quote", so a screen reader tells the buttons on a
     * page apart. Defaults to "Copy"; the copied and failed states keep their own names.
     */
    label?: string;
    /**
     * Runs once a successful copy's confirmation has shown, for a parent that reveals Copy only on demand to hide it
     * again.
     */
    onCopied?: () => void;
    /**
     * The text to copy, or a function that produces it on tap when building it costs more than a render should pay,
     * such as a quote's text re-parsed from a streaming reply.
     */
    text: string | (() => string);
    /**
     * Distinct per block: Android semantic capture keeps one node per test ID, so a shared ID hides the second Copy.
     * The confirmation glyph carries `${testID}-copied`.
     */
    testID: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [status, setStatus] = useState<'copied' | 'failed' | 'idle'>('idle');
    useEffect(() => {
        if (status === 'idle') return;
        const timer = setTimeout(() => {
            setStatus('idle');
            if (status === 'copied') onCopied?.();
        }, COPY_FEEDBACK_RESET_MS);
        return () => clearTimeout(timer);
    }, [onCopied, status]);
    const label = {
        copied: t('components.copied'),
        failed: t('components.copyFailed'),
        idle: idleLabel ?? t('components.copy'),
    }[status];
    return (
        <Pressable
            accessibilityLabel={label}
            accessibilityLiveRegion="polite"
            accessibilityRole="button"
            // The 27dp glyph pad plus 10dp on each side reaches the 44dp touch target.
            hitSlop={10}
            onPress={() => {
                void Clipboard.setStringAsync(typeof text === 'function' ? text() : text)
                    .then(() => setStatus('copied'))
                    .catch(() => setStatus('failed'));
            }}
            style={({ pressed }) => [
                styles.copy,
                { backgroundColor: theme.elevated, opacity: pressed ? 0.5 : 1 },
            ]}
            testID={testID}
        >
            {status === 'copied' ? (
                <View testID={`${testID}-copied`}>
                    <Check color={theme.success} size={15} />
                </View>
            ) : status === 'failed' ? (
                <CircleAlert color={theme.danger} size={15} />
            ) : (
                <Copy color={theme.muted} size={15} />
            )}
        </Pressable>
    );
};

const styles = StyleSheet.create({
    copy: { borderRadius: 6, padding: 6, position: 'absolute', right: 4, top: 4 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
