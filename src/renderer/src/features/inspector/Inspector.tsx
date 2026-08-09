import { executeCommand } from '../../commands/execute';
import { CommandTooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utils';
import { useSelectedSession, useSessionState } from '../../stores/selectors';
import { getInspectorPanel, inspectorPanels } from './panels';

export function Inspector() {
    const sessionId = useSelectedSession()?.id;
    const mode = useSessionState()?.inspectorMode ?? 'files';
    const activePanel = getInspectorPanel(mode);
    const ActiveComponent = activePanel.Component;
    return (
        <aside className="inspector min-w-0 flex min-h-0 flex-col bg-surface">
            <div className="inspector-tabs grid h-11 grid-cols-4 items-end border-b border-border [&>div]:h-9">
                {inspectorPanels.map(({ id, title, icon: Icon, commandId }) => (
                    <CommandTooltip key={id} commandId={commandId}>
                        <button
                            className={cn(
                                'flex h-9 items-center justify-center gap-1 border-0 border-b-2 border-transparent bg-surface text-muted text-[11px] cursor-pointer hover:text-foreground',
                                mode === id && 'active border-indicator text-foreground',
                            )}
                            aria-label={title}
                            onClick={() => executeCommand(commandId)}
                        >
                            <Icon size={15} />
                            <span className="max-[1100px]:hidden">{title}</span>
                        </button>
                    </CommandTooltip>
                ))}
            </div>
            <ActiveComponent key={activePanel.resetOnSessionChange ? sessionId : undefined} />
        </aside>
    );
}
