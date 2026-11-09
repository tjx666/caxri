import type { AgentChatTask } from '@caxri/protocol';
import { PanelRight, PanelRightClose } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';

/**
 * Opens a work row's subagent or background shell in the side split, and hides it again while the Portal shows it, so
 * the same button closes what it opened.
 */
export function AgentChatTaskOpenButton({
    isShown,
    onHide,
    onOpen,
    task,
}: {
    isShown: boolean;
    onHide: (() => void) | undefined;
    onOpen: () => void;
    task: AgentChatTask | undefined;
}) {
    const { t } = useTranslation();
    // An empty title falls back too, not only a missing task, hence `||` on a non-nullable string.
    const title = task ? task.title : '';
    const name = title || t('agentChat.workGroup.task');
    if (isShown && onHide)
        return (
            <Tooltip content={t('agentChat.workGroup.hideNamed', { name })}>
                <Button
                    aria-expanded
                    aria-label={t('agentChat.workGroup.hideNamed', { name })}
                    className="min-h-6 shrink-0 gap-1 px-1.5 text-foreground"
                    size="sm"
                    variant="ghost"
                    onClick={onHide}
                >
                    <PanelRightClose aria-hidden="true" className="size-3.5" />
                    {t('agentChat.workGroup.hide')}
                </Button>
            </Tooltip>
        );
    return (
        <Tooltip
            content={
                task
                    ? t('agentChat.timeline.openNamed', { name })
                    : t('agentChat.workGroup.openSubagent')
            }
        >
            <Button
                aria-expanded={onHide ? false : undefined}
                aria-label={t(
                    task?.kind === 'shell'
                        ? 'agentChat.workGroup.openShell'
                        : 'agentChat.workGroup.openSubagent',
                )}
                className="min-h-6 shrink-0 gap-1 px-1.5 text-muted"
                size="sm"
                variant="ghost"
                onClick={onOpen}
            >
                <PanelRight aria-hidden="true" className="size-3.5" />
                {t('common.open')}
            </Button>
        </Tooltip>
    );
}
