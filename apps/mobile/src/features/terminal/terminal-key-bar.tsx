import { useCallback, useMemo } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, Pressable, Text } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import type { TerminalKey } from './key-input';
import { terminalViewStyles as styles } from './terminal-view-styles';

interface KeyEntry {
    key: TerminalKey | 'paste';
    label: string;
    name: string;
}

interface TerminalKeyBarProperties {
    canControl: boolean;
    ctrl: boolean;
    onKey: (key: TerminalKey) => void;
    onPaste: () => void;
    theme: MobileTheme;
}

const keys: KeyEntry[] = [
    { key: 'escape', label: 'Esc', name: 'Escape' },
    { key: 'tab', label: 'Tab', name: 'Tab' },
    { key: 'ctrl', label: 'Ctrl', name: 'Control' },
    { key: 'up', label: '↑', name: 'Arrow up' },
    { key: 'down', label: '↓', name: 'Arrow down' },
    { key: 'left', label: '←', name: 'Arrow left' },
    { key: 'right', label: '→', name: 'Arrow right' },
    { key: '1', label: '1', name: 'One' },
    { key: '2', label: '2', name: 'Two' },
    { key: '3', label: '3', name: 'Three' },
    { key: 'enter', label: 'Enter', name: 'Enter' },
    { key: 'paste', label: 'Paste', name: 'Paste from clipboard' },
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
            accessibilityHint={
                item.key === 'ctrl'
                    ? 'Applies Control to the next Terminal key only.'
                    : 'Sends this key to the Terminal.'
            }
            accessibilityLabel={item.name}
            accessibilityRole="button"
            accessibilityState={accessibilityState}
            disabled={!canControl}
            onPress={press}
            style={buttonStyle}
            testID={`terminal-key-${item.key}`}
        >
            <Text style={labelStyle}>{item.label}</Text>
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
