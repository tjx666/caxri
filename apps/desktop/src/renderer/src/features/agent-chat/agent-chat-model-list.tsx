import type { KeyboardEvent } from 'react';

import type { AgentChatModel } from '@caxri/protocol';
import { Check, ChevronLeft } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';

/**
 * Claude Code's `default` alias, whose description names what it resolves to, so it reads under the row rather than in
 * a tooltip (the Codex app's `Default / Recommended models` row).
 */
const DEFAULT_MODEL_ID = 'default';

/**
 * The picker's model face, opened from the effort panel's model name, after the Codex app's model list: a caption, one
 * row per model with a check on the current one, and each model's description in a tooltip beside its row. Arrow keys
 * move between rows; the current row takes focus when the list opens. While the current model has an effort panel
 * (`onBack`), the caption is a back button to it, and ArrowLeft goes back too, as a submenu returns to its parent.
 */
export function AgentChatModelList({
    currentId,
    models,
    onBack,
    onChoose,
}: {
    currentId: string | undefined;
    models: readonly AgentChatModel[];
    /**
     * Returns to the effort panel; omitted when the current model has none, so the list is the picker's only face.
     */
    onBack: (() => void) | undefined;
    onChoose: (id: string) => void;
}) {
    const { t } = useTranslation();
    // With no current row (a model the provider did not list), the first row is the one Tab and focus land on.
    const focusId = models.some((model) => model.id === currentId) ? currentId : models[0]?.id;
    return (
        <div className="flex max-h-96 flex-col overflow-y-auto p-1">
            {onBack ? (
                <button
                    aria-label={t('agentChat.model.backToEffort')}
                    className="flex min-h-6 cursor-pointer items-center gap-1 self-start rounded-md border-0 bg-transparent px-1.5 text-[11px] text-muted outline-none hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:bg-list-focus-background focus-visible:text-list-focus-foreground"
                    type="button"
                    onClick={onBack}
                >
                    <ChevronLeft aria-hidden className="size-3 shrink-0" />
                    {t('agentChat.model.chooseModel')}
                </button>
            ) : (
                <div className="px-2 pt-1 pb-0.5 text-[11px] text-muted">
                    {t('agentChat.model.chooseModel')}
                </div>
            )}
            <div
                aria-label={t('agentChat.model.chooseModel')}
                className="flex flex-col"
                role="radiogroup"
                onKeyDown={(event) => {
                    if (onBack && event.key === 'ArrowLeft') {
                        event.preventDefault();
                        onBack();
                        return;
                    }
                    moveRowFocus(event);
                }}
            >
                {models.map((model) => (
                    <ModelRow
                        key={model.id}
                        isCurrent={model.id === currentId}
                        isFocusTarget={model.id === focusId}
                        model={model}
                        onChoose={() => onChoose(model.id)}
                    />
                ))}
            </div>
        </div>
    );
}

function ModelRow({
    isCurrent,
    isFocusTarget,
    model,
    onChoose,
}: {
    isCurrent: boolean;
    isFocusTarget: boolean;
    model: AgentChatModel;
    onChoose: () => void;
}) {
    const isInline = model.id === DEFAULT_MODEL_ID && model.description !== undefined;
    const row = (
        <button
            aria-checked={isCurrent}
            // The current row takes focus as the list replaces the effort panel, as a menu focuses its checked item.
            autoFocus={isFocusTarget}
            className="flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] outline-none hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:bg-list-focus-background focus-visible:text-list-focus-foreground"
            role="radio"
            tabIndex={isFocusTarget ? 0 : -1}
            type="button"
            onClick={onChoose}
        >
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{model.displayName}</span>
                {isInline && (
                    <span className="truncate text-[11px] leading-4 text-muted">
                        {model.description}
                    </span>
                )}
            </span>
            {isCurrent && <Check className="size-3.5 shrink-0 text-muted" />}
        </button>
    );
    if (isInline || !model.description) return row;
    return (
        <Tooltip content={model.description} side="right">
            {row}
        </Tooltip>
    );
}

/**
 * Up and Down move focus between the radio rows, wrapping at the ends, as a radio group's arrow keys do.
 */
function moveRowFocus(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    rows.at((index + step) % rows.length)?.focus();
    event.preventDefault();
}
