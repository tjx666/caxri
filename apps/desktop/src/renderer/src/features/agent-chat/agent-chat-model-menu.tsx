import { useState } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatModelLabel } from '@caxri/protocol';
import { ChevronDown, Workflow, Zap } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { AgentChatEffortPanel } from './agent-chat-effort-panel';
import { AgentChatModelList } from './agent-chat-model-list';
import type { AgentChatModelPickerView } from './agent-chat-model-selection';
import {
    agentChatMenuModel,
    agentChatModelTriggerText,
    agentChatPickerOpeningView,
    isAgentChatFastOffered,
} from './agent-chat-model-selection';
import { useAgentChatModelSelection } from './hooks/use-agent-chat-model-selection';

const LABEL_CLASS_NAME = 'flex min-w-0 items-center gap-1 text-[12px] leading-4 text-muted';

/**
 * The model and reasoning effort the next turn uses, and the picker that switches them, after the Codex app's: a pill
 * beside the input opens an effort panel (`AgentChatEffortPanel`) whose model name flips the same popover to the model
 * list (`AgentChatModelList`); choosing a model flips back so its efforts show right away. A model with neither efforts
 * nor a mode toggle opens straight on the list, and choosing from it closes the picker. While the effort panel is open
 * the pill reads `Choose effort`, as the Codex app's does.
 *
 * The choice shows at once with a spinner beside it until the snapshot confirms it (`AgentChatPendingSelection`), and
 * reverts with a toast naming what failed. A provider that listed no models shows the model it reported as plain text.
 * The model name reads in the foreground color and the effort stays muted beside it. Before Claude Code names its
 * model, the picker checks the provider's `default` row and offers its efforts, matching the trigger's "Default"
 * (`agentChatMenuModel`).
 *
 * Fast mode and Claude Code's ultracode are toggles in the panel's header rather than effort stops: ultracode follows
 * Claude Code's own `/effort` picker since 2.1.284, and Fast mode is a separate speed tier at any effort, as Codex's
 * `/fast` and Claude Code's `/fast` keep it. Each appears only while the provider offers it for the current model, and
 * an active one leads the trigger as its icon, as the Codex app's Fast bolt does.
 */
export function AgentChatModelMenu({
    snapshot: reported,
    terminalId,
}: {
    snapshot:
        Pick<AgentChatSnapshot, 'effort' | 'fast' | 'model' | 'models' | 'ultracode'> | undefined;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const [isOpen, setOpen] = useState(false);
    const [view, setView] = useState<AgentChatModelPickerView>('effort');
    const { configure, isPending, snapshot } = useAgentChatModelSelection(reported, terminalId);
    const label = agentChatModelLabel(snapshot);
    if (!label) return null;
    const { modelName, effortName, ariaLabel } = agentChatModelTriggerText(t, snapshot, label);
    const text = (
        <>
            {snapshot?.fast && (
                <Zap aria-hidden className="size-3 shrink-0 fill-current text-foreground" />
            )}
            {snapshot?.ultracode && (
                <Workflow aria-hidden className="size-3 shrink-0 text-foreground" />
            )}
            <span className="truncate text-foreground">{modelName}</span>
            {effortName && <span className="shrink-0">{effortName}</span>}
        </>
    );
    const models = snapshot?.models;
    if (!models || models.length === 0) return <span className={LABEL_CLASS_NAME}>{text}</span>;
    const current = agentChatMenuModel(snapshot);
    const fast = isAgentChatFastOffered(snapshot, current)
        ? {
              description: current?.fast?.description ?? t('agentChat.model.fastDescription'),
              isOn: snapshot.fast === true,
          }
        : undefined;
    const ultracode =
        snapshot.ultracode === undefined
            ? undefined
            : { description: t('agentChat.model.ultracodeDescription'), isOn: snapshot.ultracode };
    const hasModes = fast !== undefined || ultracode !== undefined;
    return (
        <Popover
            open={isOpen}
            onOpenChange={(open) => {
                setOpen(open);
                if (open) setView(agentChatPickerOpeningView(current, hasModes));
            }}
        >
            <PopoverTrigger
                aria-label={ariaLabel}
                className={`${LABEL_CLASS_NAME} h-7 shrink cursor-pointer rounded-full border-0 bg-transparent px-2.5 transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent data-popup-open:bg-elevated`}
            >
                {isOpen && view === 'effort' ? (
                    <span className="truncate">{t('agentChat.model.chooseEffort')}</span>
                ) : (
                    text
                )}
                {isPending ? (
                    <Spinner
                        aria-label={t('agentChat.model.switching')}
                        className="size-3 shrink-0"
                    />
                ) : (
                    <ChevronDown className="size-3 shrink-0" />
                )}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72" side="top" sideOffset={6}>
                {view === 'effort' ? (
                    <AgentChatEffortPanel
                        configure={configure}
                        effort={snapshot.effort}
                        fast={fast}
                        model={current}
                        modelName={modelName}
                        ultracode={ultracode}
                        onChooseModel={() => setView('models')}
                    />
                ) : (
                    <AgentChatModelList
                        currentId={current?.id}
                        models={models}
                        onChoose={(id) => {
                            if (id !== current?.id) configure({ model: id });
                            const next = models.find((model) => model.id === id);
                            const nextView = agentChatPickerOpeningView(
                                next,
                                ultracode !== undefined || next?.fast !== undefined,
                            );
                            if (nextView === 'effort') setView('effort');
                            else setOpen(false);
                        }}
                    />
                )}
            </PopoverContent>
        </Popover>
    );
}
