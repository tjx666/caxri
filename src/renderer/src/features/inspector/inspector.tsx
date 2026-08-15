import { executeCommand } from '../../commands/execute';
import { ChromeTabPanel, ChromeTabs } from '../../components/chrome-tabs';
import { CommandTooltip } from '../../components/ui/tooltip';
import { useSelectedSession, useSessionState } from '../../stores/selectors';
import { getInspectorPanel, inspectorPanels } from './panels';

export function Inspector() {
    const sessionId = useSelectedSession()?.id;
    const mode = useSessionState()?.inspectorMode ?? 'files';
    const activePanel = getInspectorPanel(mode);
    const ActiveComponent = activePanel.Component;
    const tabs = inspectorPanels.map(({ id, title, icon: Icon }) => ({
        value: id,
        label: title,
        content: (
            <>
                <Icon size={15} />
                <span className="max-[1100px]:hidden" data-slot="chrome-tab-label">
                    {title}
                </span>
            </>
        ),
    }));
    return (
        <aside className="inspector min-w-0 flex min-h-0 flex-col bg-surface">
            <ChromeTabs
                ariaLabel="Inspector"
                className="inspector-tabs grid h-11 grid-cols-4 items-end border-b border-border"
                idPrefix="inspector"
                items={tabs}
                tabClassName="h-9 w-full text-[11px]"
                value={mode}
                onValueChange={(nextMode) => executeCommand(getInspectorPanel(nextMode).commandId)}
                renderTab={(item, tab) => (
                    <CommandTooltip commandId={getInspectorPanel(item.value).commandId}>
                        {tab}
                    </CommandTooltip>
                )}
            />
            {tabs.map(({ value }) => {
                const isActive = value === mode;
                return (
                    <ChromeTabPanel
                        key={value}
                        active={isActive}
                        className="flex min-h-0 flex-1 flex-col overflow-hidden [&>*]:min-h-0 [&>*]:flex-1"
                        idPrefix="inspector"
                        value={value}
                    >
                        {isActive && (
                            <ActiveComponent
                                key={activePanel.resetOnSessionChange ? sessionId : undefined}
                            />
                        )}
                    </ChromeTabPanel>
                );
            })}
        </aside>
    );
}
