import { useCallback, useMemo } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, Pressable, Text } from 'react-native';

import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import type { TerminalKey } from './key-input';
import { terminalViewStyles as styles } from './terminal-view-styles';

/**
 * Key caps (`Esc`, `Tab`, `Shift Tab`, `Ctrl`, `Enter`) and their spoken names stay untranslated because they name
 * physical keys; every other entry's label or spoken name is a translation key.
 */
interface KeyEntry {
    key: TerminalKey | 'paste';
    label: string | { key: TranslationKey };
    name: string | { key: TranslationKey };
}

interface TerminalKeyBarProperties {
    canControl: boolean;
    ctrl: boolean;
    onKey: (key: TerminalKey) => void;
    onPaste: () => void;
    theme: MobileTheme;
}

/**
 * The arrows stay on the row's first screen because menus in Agent CLIs are driven by them; `⇧Tab` (cycling a CLI's
 * mode) comes after them since it is wide and used less often.
 */
const keys: KeyEntry[] = [
    { key: 'escape', label: 'Esc', name: 'Escape' },
    { key: 'tab', label: 'Tab', name: 'Tab' },
    { key: 'ctrl', label: 'Ctrl', name: 'Control' },
    { key: 'up', label: '↑', name: { key: 'terminal.key.arrowUp' } },
    { key: 'down', label: '↓', name: { key: 'terminal.key.arrowDown' } },
    { key: 'left', label: '←', name: { key: 'terminal.key.arrowLeft' } },
    { key: 'right', label: '→', name: { key: 'terminal.key.arrowRight' } },
    { key: 'shift-tab', label: '⇧Tab', name: 'Shift Tab' },
    { key: '1', label: '1', name: { key: 'terminal.key.one' } },
    { key: '2', label: '2', name: { key: 'terminal.key.two' } },
    { key: '3', label: '3', name: { key: 'terminal.key.three' } },
    { key: 'enter', label: 'Enter', name: 'Enter' },
    { key: 'paste', label: { key: 'terminal.key.paste' }, name: { key: 'terminal.key.pasteName' } },
];

const keyExtractor = (item: KeyEntry): string => item.key;

const TerminalKeyButton = ({
    canControl,
    ctrl,
    item,
    onKey,
    onPaste,
    theme,
}: TerminalKeyBarProperties & { item: KeyEntry }) => {
    const { t } = useTranslation();
    const text = (value: KeyEntry['label']): string =>
        typeof value === 'string' ? value : t(value.key);
    const selected = item.key === 'ctrl' && ctrl;
    const accessibilityState = useMemo(
        () => ({ disabled: !canControl, selected }),
        [canControl, selected],
    );
    const buttonStyle = useMemo(
        () => [
            styles.key,
            {
                backgroundColor: selected ? theme.primary : theme.surface,
                opacity: canControl ? 1 : 0.45,
            },
        ],
        [canControl, selected, theme.primary, theme.surface],
    );
    const labelStyle = useMemo(
        () => [styles.keyLabel, { color: selected ? theme.primaryForeground : theme.text }],
        [selected, theme.primaryForeground, theme.text],
    );
    const press = useCallback((): void => {
        if (item.key === 'paste') onPaste();
        else onKey(item.key);
    }, [item.key, onKey, onPaste]);

    return (
        <Pressable
            accessibilityHint={t(
                item.key === 'ctrl' ? 'terminal.key.ctrlHint' : 'terminal.key.sendHint',
            )}
            accessibilityLabel={text(item.name)}
            accessibilityRole="button"
            accessibilityState={accessibilityState}
            disabled={!canControl}
            onPress={press}
            style={buttonStyle}
            testID={`terminal-key-${item.key}`}
        >
            <Text style={labelStyle}>{text(item.label)}</Text>
        </Pressable>
    );
};

export const TerminalKeyBar = ({
    canControl,
    ctrl,
    onKey,
    onPaste,
    theme,
}: TerminalKeyBarProperties) => {
    const renderKey = useCallback(
        ({ item }: ListRenderItemInfo<KeyEntry>) => (
            <TerminalKeyButton
                canControl={canControl}
                ctrl={ctrl}
                item={item}
                onKey={onKey}
                onPaste={onPaste}
                theme={theme}
            />
        ),
        [canControl, ctrl, onKey, onPaste, theme],
    );

    return (
        <FlatList
            contentContainerStyle={styles.keyBarContent}
            data={keys}
            horizontal
            keyExtractor={keyExtractor}
            keyboardShouldPersistTaps="always"
            renderItem={renderKey}
            showsHorizontalScrollIndicator={false}
            style={styles.keyBar}
            testID="terminal-key-bar"
        />
    );
};
