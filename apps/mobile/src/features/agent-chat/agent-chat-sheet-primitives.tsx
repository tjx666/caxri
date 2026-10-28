import { Pressable, Switch, Text, View } from 'react-native';

import { Check } from 'lucide-react-native';

import { SectionLabel } from '../../components/section-label';
import { Spinner } from '../../components/spinner';
import type { MobileTheme } from '../../theme/tokens';
import { sheetStyles } from './agent-chat-sheet-styles';

/**
 * One choice in a composer sheet's list (a model, an effort, a permission level): a radio row with an optional
 * description and trailing caption, a check when selected, and a spinner while its request is on its way.
 */
export const SheetOptionRow = ({
    description,
    isBusy,
    isDisabled,
    isSelected,
    label,
    labelColor,
    onPress,
    testID,
    theme,
    trailing,
}: {
    description?: string;
    isBusy: boolean;
    isDisabled: boolean;
    isSelected: boolean;
    label: string;
    /**
     * Overrides the label color, such as Full access's warning tone.
     */
    labelColor?: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
    trailing?: string;
}) => (
    <Pressable
        accessibilityRole="radio"
        accessibilityState={{ busy: isBusy, checked: isSelected, disabled: isDisabled }}
        disabled={isDisabled}
        onPress={onPress}
        style={({ pressed }) => [
            sheetStyles.option,
            { backgroundColor: pressed || isSelected ? theme.elevated : 'transparent' },
        ]}
        testID={testID}
    >
        <View style={sheetStyles.optionText}>
            <Text
                numberOfLines={1}
                style={[sheetStyles.optionLabel, { color: labelColor ?? theme.text }]}
            >
                {label}
            </Text>
            {description ? (
                <Text
                    numberOfLines={2}
                    style={[sheetStyles.optionDescription, { color: theme.muted }]}
                >
                    {description}
                </Text>
            ) : null}
        </View>
        {trailing ? (
            <Text style={[sheetStyles.optionTrailing, { color: theme.muted }]}>{trailing}</Text>
        ) : null}
        <View style={sheetStyles.optionMark}>
            {isBusy ? (
                <Spinner color={theme.muted} />
            ) : isSelected ? (
                <Check color={theme.primary} size={18} strokeWidth={2.5} />
            ) : null}
        </View>
    </Pressable>
);

/**
 * An on/off setting in a composer sheet (Ultracode, Plan mode), the phone's form of a Desktop menu checkbox item. The
 * whole row toggles; the switch only shows the state, so one tap never reaches two handlers.
 */
export const SheetToggleRow = ({
    description,
    isBusy,
    isDisabled,
    isOn,
    label,
    onToggle,
    testID,
    theme,
}: {
    description: string;
    isBusy: boolean;
    isDisabled: boolean;
    isOn: boolean;
    label: string;
    onToggle: (isOn: boolean) => void;
    testID: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityLabel={label}
        accessibilityHint={description}
        accessibilityRole="switch"
        accessibilityState={{ busy: isBusy, checked: isOn, disabled: isDisabled }}
        disabled={isDisabled}
        onPress={() => onToggle(!isOn)}
        style={({ pressed }) => [
            sheetStyles.option,
            { backgroundColor: pressed ? theme.elevated : 'transparent' },
        ]}
        testID={testID}
    >
        <View style={sheetStyles.optionText}>
            <Text numberOfLines={1} style={[sheetStyles.optionLabel, { color: theme.text }]}>
                {label}
            </Text>
            <Text numberOfLines={2} style={[sheetStyles.optionDescription, { color: theme.muted }]}>
                {description}
            </Text>
        </View>
        {isBusy ? <Spinner color={theme.muted} /> : null}
        <View pointerEvents="none">
            <Switch
                disabled={isDisabled}
                thumbColor={theme.text}
                trackColor={{ false: theme.border, true: theme.primary }}
                value={isOn}
            />
        </View>
    </Pressable>
);

/**
 * A group heading inside a composer sheet, set by the app's one section label.
 */
export const SheetSectionLabel = ({ label, theme }: { label: string; theme: MobileTheme }) => (
    <SectionLabel style={sheetStyles.section} theme={theme}>
        {label.toUpperCase()}
    </SectionLabel>
);

/**
 * The lines under a composer sheet's lists: when the choice takes effect, why the device cannot change it now, and the
 * last failure. `testIDPrefix` keeps each sheet's existing test ids (`<prefix>-note`, `-disabled-reason`, `-error`).
 */
export const SheetMessages = ({
    disabledReason,
    error,
    note,
    testIDPrefix,
    theme,
}: {
    disabledReason: string | undefined;
    error: string | null;
    note: string | undefined;
    testIDPrefix: string;
    theme: MobileTheme;
}) => (
    <>
        {note ? (
            <Text
                style={[sheetStyles.hint, { color: theme.muted }]}
                testID={`${testIDPrefix}-note`}
            >
                {note}
            </Text>
        ) : null}
        {disabledReason ? (
            <Text
                style={[sheetStyles.hint, { color: theme.muted }]}
                testID={`${testIDPrefix}-disabled-reason`}
            >
                {disabledReason}
            </Text>
        ) : null}
        {error ? (
            <Text
                accessibilityRole="alert"
                style={[sheetStyles.hint, { color: theme.danger }]}
                testID={`${testIDPrefix}-error`}
            >
                {error}
            </Text>
        ) : null}
    </>
);
