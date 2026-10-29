import { useRef } from 'react';
import type { ScrollViewInstance } from 'react-native';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type {
    AgentChatModelRequest,
    AgentChatPermissionMode,
    AgentProvider,
} from '@caxri/protocol';

import { BottomSheet, SheetCancel, SheetTitle } from '../../components/bottom-sheet';
import { useTranslation } from '../../i18n';
import { mobileSpace } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import {
    agentChatEffortHint,
    agentChatModelOptions,
    agentChatModelSheetNote,
    agentChatSettingsDisabledReasons,
    agentChatUltracodeToggle,
} from './agent-chat-model-choice';
import {
    agentChatPermissionOptions,
    agentChatPermissionSheetNote,
    agentChatPlanModeToggle,
} from './agent-chat-permission-choice';
import {
    SheetMessages,
    SheetOptionRow,
    SheetSectionLabel,
    SheetToggleRow,
} from './agent-chat-sheet-primitives';
import { sheetStyles } from './agent-chat-sheet-styles';
import type {
    useAgentChatModelSelection,
    useAgentChatPermissionSelection,
} from './use-agent-chat-choice';

type ModelSelection = ReturnType<typeof useAgentChatModelSelection>;
type PermissionSelection = ReturnType<typeof useAgentChatPermissionSelection>;

/**
 * Which chip opened the sheet. The sheet opens scrolled to that chip's section, and keeps the open chip's test IDs
 * (`agent-chat-model-sheet` and `-done`, or the `agent-chat-permission-` pair) so each entry point stays addressable.
 */
export type AgentChatSettingsEntry = 'model' | 'permission';

const styles = StyleSheet.create({
    footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: mobileSpace.xs },
});

/**
 * Chat settings as one phone sheet, the Desktop composer's model and permission menus together: `Model`, `Reasoning
 * effort` (with Claude Code's Ultracode switch while the provider offers it), and `Permissions` (with Plan mode for a
 * provider that has it). Every choice applies on tap and the sheet stays open, so a model's efforts show right away and
 * `Done` is the only way out. Desktop's "Use as Project default" is not offered: Project defaults stay a Desktop
 * setting.
 */
export const AgentChatSettingsSheet = ({
    configureReason,
    entry,
    model,
    onClose,
    permission,
    permissionReason,
    provider,
    theme,
}: {
    /**
     * Why the device cannot configure the Chat right now, such as a dropped connection. The open sheet keeps its lists
     * but disables them and says why, instead of vanishing under the reader's finger.
     */
    configureReason: string | undefined;
    entry: AgentChatSettingsEntry;
    /**
     * Both selections are owned by the chips, so a pending choice outlives the sheet and the chips show it too.
     */
    model: ModelSelection;
    onClose: () => void;
    permission: PermissionSelection;
    permissionReason: string | undefined;
    provider: AgentProvider | undefined;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const scroll = useRef<ScrollViewInstance>(null);
    const section = useRef({ contentHeight: 0, done: entry !== 'permission', y: -1 });
    /**
     * Opens at the Permissions section when its chip opened the sheet. Both the section's position and the content's
     * size must be known before Android honors a scroll, so either measurement may be the one that triggers it.
     */
    const scrollToEntry = (): void => {
        const state = section.current;
        if (state.done || state.y < 0 || state.contentHeight === 0) return;
        state.done = true;
        scroll.current?.scrollTo({ animated: false, y: state.y });
    };
    const modelSnapshot = model.snapshot;
    const { efforts, models } = agentChatModelOptions(modelSnapshot, t);
    const ultracode = agentChatUltracodeToggle(modelSnapshot, t);
    const effortHint = agentChatEffortHint(modelSnapshot, t);
    const isModelDisabled = model.busy !== null || configureReason !== undefined;
    const permissionOptions = provider
        ? agentChatPermissionOptions(permission.snapshot, provider, t)
        : [];
    const planMode = provider
        ? agentChatPlanModeToggle(permission.snapshot, provider, t)
        : undefined;
    const isPermissionDisabled = permission.busy !== null || permissionReason !== undefined;
    const footerReasons = agentChatSettingsDisabledReasons(
        { configure: configureReason, permission: permissionReason },
        t,
    );
    const modelNote = agentChatModelSheetNote(modelSnapshot, t);
    const select = (change: AgentChatModelRequest, isSelected: boolean): void => {
        if (!isSelected) void model.didConfigure(change);
    };
    const choosePermission = (permissionMode: AgentChatPermissionMode): void => {
        void permission.didConfigure({ permissionMode });
    };
    return (
        <BottomSheet
            closeLabel={t('chat.settings.close')}
            maxHeight="80%"
            onClose={onClose}
            testID={`agent-chat-${entry}-sheet`}
            theme={theme}
        >
            {(dismiss) => (
                <>
                    <SheetTitle theme={theme} title={t('chat.settings.title')} />
                    <ScrollView
                        onContentSizeChange={(_width, height) => {
                            section.current.contentHeight = height;
                            scrollToEntry();
                        }}
                        ref={scroll}
                        style={sheetStyles.scroll}
                    >
                        <SheetSectionLabel label={t('chat.model.model')} theme={theme} />
                        {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A provider lists a handful of models, and the other sections follow them in the same scroll. */}
                        {models.map((option) => (
                            <SheetOptionRow
                                description={option.description}
                                isBusy={model.busy?.model === option.id}
                                isDisabled={isModelDisabled}
                                isSelected={option.isSelected}
                                key={option.id}
                                label={option.displayName}
                                onPress={() => select({ model: option.id }, option.isSelected)}
                                testID={`agent-chat-model-${option.id}`}
                                theme={theme}
                            />
                        ))}
                        {effortHint || efforts.length > 0 ? (
                            <SheetSectionLabel
                                label={t('chat.model.reasoningEffort')}
                                theme={theme}
                            />
                        ) : null}
                        {effortHint ? (
                            <Text style={[sheetStyles.hint, { color: theme.muted }]}>
                                {effortHint}
                            </Text>
                        ) : null}
                        {efforts.map((effort) => (
                            <SheetOptionRow
                                description={effort.description}
                                isBusy={model.busy?.effort === effort.value}
                                isDisabled={isModelDisabled}
                                isSelected={effort.isSelected}
                                key={effort.value}
                                label={effort.label}
                                onPress={() => select({ effort: effort.value }, effort.isSelected)}
                                testID={`agent-chat-effort-${effort.value}`}
                                theme={theme}
                                trailing={effort.isDefault ? t('chat.model.default') : undefined}
                            />
                        ))}
                        {ultracode ? (
                            <SheetToggleRow
                                description={ultracode.description}
                                isBusy={model.busy?.ultracode !== undefined}
                                isDisabled={isModelDisabled}
                                isOn={ultracode.isOn}
                                label={ultracode.label}
                                onToggle={(isOn) => select({ ultracode: isOn }, false)}
                                testID="agent-chat-ultracode"
                                theme={theme}
                            />
                        ) : null}
                        {permissionOptions.length > 0 ? (
                            <View
                                onLayout={(event) => {
                                    section.current.y = event.nativeEvent.layout.y;
                                    scrollToEntry();
                                }}
                            >
                                <SheetSectionLabel
                                    label={t('chat.permission.permissions')}
                                    theme={theme}
                                />
                                {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A provider offers at most five levels. */}
                                {permissionOptions.map((option) => (
                                    <SheetOptionRow
                                        description={option.description}
                                        isBusy={
                                            option.value !== 'custom' &&
                                            permission.busy?.permissionMode === option.value
                                        }
                                        isDisabled={isPermissionDisabled}
                                        isSelected={option.isSelected}
                                        key={option.value}
                                        label={option.label}
                                        labelColor={option.isFullAccess ? theme.warning : undefined}
                                        onPress={() => {
                                            // Custom only explains the launch settings; there is nothing to switch back to.
                                            if (option.value === 'custom' || option.isSelected)
                                                return;
                                            choosePermission(option.value);
                                        }}
                                        testID={option.testID}
                                        theme={theme}
                                    />
                                ))}
                                {planMode ? (
                                    <SheetToggleRow
                                        description={planMode.description}
                                        isBusy={permission.busy?.planMode !== undefined}
                                        isDisabled={isPermissionDisabled}
                                        isOn={planMode.isOn}
                                        label={planMode.label}
                                        onToggle={(isOn) => {
                                            void permission.didConfigure({ planMode: isOn });
                                        }}
                                        testID="agent-chat-plan-mode"
                                        theme={theme}
                                    />
                                ) : null}
                            </View>
                        ) : null}
                    </ScrollView>
                    {/* Outside the scroll, so a failed choice stays in view whichever section it came from. The hairline marks
                    where the list scrolls under the footer instead of leaving a row cut off mid-line. */}
                    <View style={[styles.footer, { borderTopColor: theme.border }]}>
                        <SheetMessages
                            disabledReason={footerReasons.model}
                            error={model.error}
                            note={
                                modelNote ??
                                (provider
                                    ? agentChatPermissionSheetNote(permission.snapshot, provider, t)
                                    : undefined)
                            }
                            testIDPrefix="agent-chat-model"
                            theme={theme}
                        />
                        <SheetMessages
                            disabledReason={footerReasons.permission}
                            error={permission.error}
                            note={undefined}
                            testIDPrefix="agent-chat-permission"
                            theme={theme}
                        />
                        <SheetCancel
                            label="Done"
                            onPress={dismiss}
                            testID={`agent-chat-${entry}-done`}
                            theme={theme}
                        />
                    </View>
                </>
            )}
        </BottomSheet>
    );
};
