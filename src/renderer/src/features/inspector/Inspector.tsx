import { executeCommand } from '../../commands/execute';
import { cn } from '../../lib/utils';
import { useSelectedSession, useSessionState } from '../../state/selectors';
import { getInspectorPanel, inspectorPanels } from './panels';

export function Inspector() {
    const sessionId = useSelectedSession()?.id;
    const mode = useSessionState()?.inspectorMode ?? 'files';
    const activePanel = getInspectorPanel(mode);
    const ActiveComponent = activePanel.Component;
    return (
        <aside className="inspector min-w-0 flex min-h-0 flex-col bg-surface">
            <div className="inspector-tabs grid grid-cols-4 min-h-9 border-b border-border">
                {inspectorPanels.map(({ id, title, icon: Icon, commandId }) => (
                    <button
                        key={id}
                        className={cn(
                            'flex items-center justify-center gap-1 border-0 border-b-2 border-transparent bg-surface text-muted text-[11px] cursor-pointer hover:text-foreground',
                            mode === id && 'active border-indicator text-foreground',
                        )}
                        title={title}
                        onClick={() => executeCommand(commandId)}
                    >
                        <Icon size={15} />
                        <span className="max-[1100px]:hidden">{title}</span>
                    </button>
                ))}
            </div>
            <ActiveComponent key={activePanel.resetOnSessionChange ? sessionId : undefined} />
        </aside>
    );
}
