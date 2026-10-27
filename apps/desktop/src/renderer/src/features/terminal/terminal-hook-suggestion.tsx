import type { AgentProvider, AppSettings, TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { Plug, RotateCcw, X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import {
    dismissLifecycleHookSuggestion,
    enableLifecycleHooks,
    enableLifecycleHooksAndRestart,
    restartForLifecycleHooks,
    stopSuggestingLifecycleHooks,
    terminalHookSuggestion,
    useTerminalHookSuggestionStore,
} from './terminal-hook-suggestion-state';

const actionClassName = 'min-h-6 flex-none px-2 text-inherit';

/**
 * The pane row offering a PTY Agent its provider's lifecycle hooks, which are off by default. It is a lasting state
 * with actions, so it takes its own row above the recovery row instead of covering output.
 */
export function TerminalHookSuggestion({
    provider,
    settings,
    terminal,
}: {
    provider: AgentProvider | undefined;
    settings: AppSettings;
    terminal: TerminalRecord | undefined;
}) {
    const { t } = useTranslation();
    const terminalId = terminal?.id;
    const isDismissed = useTerminalHookSuggestionStore((state) =>
        terminalId ? state.dismissed[terminalId] === true : false,
    );
    const enabledDuringProcess = useTerminalHookSuggestionStore((state) =>
        terminalId ? state.enabledDuringProcess[terminalId] : undefined,
    );
    if (!terminal || !terminalId || !provider) return null;
    const suggestion = terminalHookSuggestion({
        enabledDuringProcess,
        isDismissed,
        settings,
        terminal,
    });
    if (!suggestion) return null;
    const providerName = agentProviderCatalog[provider].displayName;
    const message =
        suggestion === 'suggest'
            ? t('terminal.hookSuggestion.suggest', { provider: providerName })
            : suggestion === 'restart'
              ? t('terminal.hookSuggestion.restart')
              : t('terminal.hookSuggestion.required', { provider: providerName });
    return (
        <div
            aria-live="polite"
            className="terminal-hook-suggestion flex min-w-0 flex-none basis-7 items-center justify-between gap-3 border-t border-border bg-[color-mix(in_srgb,var(--surface)_65%,var(--background))] pr-1 pl-2 text-[11px] text-muted"
            data-hook-suggestion={suggestion}
            role="status"
        >
            <Tooltip
                content={
                    suggestion === 'suggest'
                        ? t('terminal.hookSuggestion.suggestDetail', { provider: providerName })
                        : message
                }
            >
                <span className="inline-flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
                    <Plug size={14} className="flex-none" />
                    {message}
                </span>
            </Tooltip>
            <div className="flex flex-none items-center">
                {suggestion === 'suggest' && (
                    <>
                        <Button
                            className={actionClassName}
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                                enableLifecycleHooks(terminalId, provider, terminal.processId)
                            }
                        >
                            {t('terminal.hookSuggestion.enable')}
                        </Button>
                        <Button
                            className={actionClassName}
                            size="sm"
                            variant="ghost"
                            onClick={() => stopSuggestingLifecycleHooks()}
                        >
                            {t('terminal.hookSuggestion.dontAskAgain')}
                        </Button>
                    </>
                )}
                {suggestion === 'restart' && (
                    <Button
                        className={actionClassName}
                        size="sm"
                        variant="ghost"
                        onClick={() => restartForLifecycleHooks(terminalId)}
                    >
                        <RotateCcw size={12} /> {t('terminal.recovery.restartAgent')}
                    </Button>
                )}
                {suggestion === 'required' && (
                    <Button
                        className={actionClassName}
                        size="sm"
                        variant="ghost"
                        onClick={() => enableLifecycleHooksAndRestart(terminalId, provider)}
                    >
                        <RotateCcw size={12} /> {t('terminal.hookSuggestion.enableAndRestart')}
                    </Button>
                )}
                {suggestion !== 'required' && (
                    <Tooltip content={t('terminal.hookSuggestion.dismiss')}>
                        <Button
                            aria-label={t('terminal.hookSuggestion.dismiss')}
                            className="size-6 flex-none text-inherit"
                            size="icon"
                            variant="ghost"
                            onClick={() => dismissLifecycleHookSuggestion(terminalId)}
                        >
                            <X size={12} />
                        </Button>
                    </Tooltip>
                )}
            </div>
        </div>
    );
}
