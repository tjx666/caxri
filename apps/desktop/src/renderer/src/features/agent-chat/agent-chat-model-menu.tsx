import { useState } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatModelLabel } from '@caxri/protocol';
import { ChevronDown } from 'lucide-react';

import {
    Menu,
    MenuCheckboxItem,
    MenuContent,
    MenuGroup,
    MenuGroupLabel,
    MenuRadioGroup,
    MenuRadioItem,
    MenuSeparator,
    MenuTrigger,
} from '../../components/ui/menu';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import {
    agentChatEffortDisplayName,
    agentChatMenuModel,
    agentChatModelTriggerText,
} from './agent-chat-model-selection';
import { useAgentChatModelSelection } from './hooks/use-agent-chat-model-selection';

const LABEL_CLASS_NAME = 'flex min-w-0 items-center gap-1 text-[12px] leading-4 text-muted';

/**
 * The model and reasoning effort the next turn uses, and the menu that switches them, as the Codex app and Claude Code
 * keep beside their input. Choosing a model keeps the menu open so its efforts show right away; choosing an effort
 * finishes the choice and closes it. The choice shows at once with a spinner beside it until the snapshot confirms it
 * (`AgentChatPendingSelection` in `@caxri/protocol`), and reverts with a toast naming what failed. A provider that
 * listed no models shows the model it reported as plain text. As in the Codex app, the model name reads in the
 * foreground color and the effort stays muted beside it. Before Claude Code names its model, the menu checks the
 * provider's `default` row and offers its efforts, matching the trigger's "Default" (`agentChatMenuModel`).
 *
 * Claude Code's ultracode is a toggle beside the effort rather than an effort level, as in its own `/effort` picker
 * since 2.1.284: it stays on at any effort. The row appears only while the provider offers it for the current model.
 */
export function AgentChatModelMenu({
    snapshot: reported,
    terminalId,
}: {
    snapshot: Pick<AgentChatSnapshot, 'effort' | 'model' | 'models' | 'ultracode'> | undefined;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const [isOpen, setOpen] = useState(false);
    const { configure, isPending, snapshot } = useAgentChatModelSelection(reported, terminalId);
    const label = agentChatModelLabel(snapshot);
    if (!label) return null;
    const { modelName, effortName, ariaLabel } = agentChatModelTriggerText(t, snapshot, label);
    const text = (
        <>
            <span className="truncate text-foreground">{modelName}</span>
            {effortName && <span className="shrink-0">{effortName}</span>}
            {/* A mode word, set like the permission trigger's `Plan`. */}
            {snapshot?.ultracode && <span className="shrink-0 text-foreground">Ultracode</span>}
        </>
    );
    const models = snapshot?.models;
    if (!models || models.length === 0) return <span className={LABEL_CLASS_NAME}>{text}</span>;
    const current = agentChatMenuModel(snapshot);
    return (
        <Menu open={isOpen} onOpenChange={setOpen}>
            <MenuTrigger
                aria-label={ariaLabel}
                className={`${LABEL_CLASS_NAME} h-7 shrink cursor-pointer rounded-md border-0 bg-transparent px-1.5 transition-colors duration-(--motion-overlay-enter) ease-(--motion-ease-enter) hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent data-popup-open:bg-elevated data-popup-open:text-foreground`}
            >
                {text}
                {isPending ? (
                    <Spinner
                        aria-label={t('agentChat.model.switching')}
                        className="size-3 shrink-0"
                    />
                ) : (
                    <ChevronDown className="size-3 shrink-0" />
                )}
            </MenuTrigger>
            <MenuContent align="end" className="max-w-80 min-w-56" side="top">
                <MenuGroup>
                    <MenuGroupLabel>{t('agentChat.model.model')}</MenuGroupLabel>
                    <MenuRadioGroup
                        value={current?.id ?? null}
                        onValueChange={(model: string) => configure({ model })}
                    >
                        {models.map((model) => (
                            <MenuRadioItem key={model.id} value={model.id}>
                                <span className="flex min-w-0 flex-col">
                                    <span className="truncate">{model.displayName}</span>
                                    {model.description && (
                                        <span className="truncate text-[11px] leading-4 text-muted">
                                            {model.description}
                                        </span>
                                    )}
                                </span>
                            </MenuRadioItem>
                        ))}
                    </MenuRadioGroup>
                </MenuGroup>
                {current && current.efforts.length > 0 && (
                    <>
                        <MenuSeparator />
                        <MenuGroup>
                            <MenuGroupLabel>{t('agentChat.model.reasoningEffort')}</MenuGroupLabel>
                            <MenuRadioGroup
                                value={snapshot.effort ?? null}
                                onValueChange={(effort: string) => {
                                    configure({ effort });
                                    setOpen(false);
                                }}
                            >
                                {current.efforts.map((effort) => (
                                    <MenuRadioItem key={effort} value={effort}>
                                        {agentChatEffortDisplayName(t, effort)}
                                        {effort === current.defaultEffort && (
                                            <span className="ml-auto pl-3 text-[11px] text-muted">
                                                {t('agentChat.model.default')}
                                            </span>
                                        )}
                                    </MenuRadioItem>
                                ))}
                            </MenuRadioGroup>
                        </MenuGroup>
                    </>
                )}
                {snapshot.ultracode !== undefined && (
                    <UltracodeItem
                        isOn={snapshot.ultracode}
                        onChange={(isOn) => configure({ ultracode: isOn })}
                    />
                )}
            </MenuContent>
        </Menu>
    );
}

/**
 * Claude Code's ultracode toggle, below the efforts.
 */
function UltracodeItem({ isOn, onChange }: { isOn: boolean; onChange: (isOn: boolean) => void }) {
    const { t } = useTranslation();
    return (
        <>
            <MenuSeparator />
            <MenuCheckboxItem
                checked={isOn}
                className="h-auto min-h-7 py-1"
                onCheckedChange={onChange}
            >
                <span className="flex min-w-0 flex-col">
                    <span className="truncate">Ultracode</span>
                    <span className="truncate text-[11px] leading-4 text-muted">
                        {t('agentChat.model.ultracodeDescription')}
                    </span>
                </span>
            </MenuCheckboxItem>
        </>
    );
}
