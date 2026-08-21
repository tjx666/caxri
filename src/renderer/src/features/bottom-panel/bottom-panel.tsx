import { X } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { ChromeTabPanel, ChromeTabs } from '../../components/chrome-tabs';
import { Button } from '../../components/ui/button';
import { CommandTooltip } from '../../components/ui/tooltip';
import { usePanelLayoutStore } from '../../stores/panel-layout';
import { bottomPanelViews, getBottomPanelView } from './views';

/**
 * The wide counterpart to the Inspector: stream- and record-shaped views that need horizontal room rather than a narrow
 * vertical rail, in the seat VS Code gives its Panel. Unlike the Inspector's `grid auto-cols-fr` strip, the tabs keep
 * their natural width and sit left — a full-width row split between two tabs would read as a segmented control, not a
 * tab bar.
 *
 * The whole subtree unmounts while the panel is collapsed (`app.tsx` renders it conditionally), which is what keeps the
 * Logs view's 1s Runtime poll from running unwatched.
 */
export function BottomPanel() {
    const view = usePanelLayoutStore((state) => state.bottomPanelView);
    const activeView = getBottomPanelView(view);
    const ActiveComponent = activeView.Component;
    const tabs = bottomPanelViews.map(({ id, title, icon: Icon }) => ({
        value: id,
        label: title,
        content: (
            <>
                <Icon size={14} />
                <span data-slot="chrome-tab-label">{title}</span>
            </>
        ),
    }));
    return (
        <section
            aria-label="Bottom Panel"
            className="bottom-panel flex min-h-0 min-w-0 flex-col border-t border-border bg-surface"
        >
            <div className="bottom-panel-header flex items-stretch">
                <ChromeTabs
                    ariaLabel="Bottom Panel"
                    className="bottom-panel-tabs flex h-9 items-end"
                    idPrefix="bottom-panel"
                    items={tabs}
                    tabClassName="h-9 gap-1.5 px-3 text-[11px]"
                    value={view}
                    onValueChange={(next) => executeCommand(getBottomPanelView(next).commandId)}
                    renderTab={(item, tab) => (
                        <CommandTooltip commandId={getBottomPanelView(item.value).commandId}>
                            {tab}
                        </CommandTooltip>
                    )}
                />
                <span className="ml-auto flex items-center pr-1">
                    <CommandTooltip commandId="bottomPanel.toggle">
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Close Bottom Panel"
                            onClick={() => executeCommand('bottomPanel.toggle')}
                        >
                            <X size={14} />
                        </Button>
                    </CommandTooltip>
                </span>
            </div>
            {tabs.map(({ value }) => {
                const isActive = value === view;
                return (
                    <ChromeTabPanel
                        key={value}
                        active={isActive}
                        className="flex min-h-0 flex-1 flex-col overflow-hidden [&>*]:min-h-0 [&>*]:flex-1"
                        idPrefix="bottom-panel"
                        value={value}
                    >
                        {isActive && <ActiveComponent />}
                    </ChromeTabPanel>
                );
            })}
        </section>
    );
}
