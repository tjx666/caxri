import { Code2, Plus, TerminalSquare } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useSelectedSession, useSessionState } from '../../stores/selectors';
import { useActiveWork } from '../../stores/session-view';
import { EditorSurface } from '../editor/editor-surface';
import { chooseProjectDirectory } from '../session/session-actions';
import { createTerminal } from '../terminal/terminal-actions';
import { TerminalLayoutView } from '../terminal/terminal-layout-view';
import { WorkTabStrip } from '../tabs/work-tab-strip';
import { workPanelId, workTabId } from '../tabs/work-tab-accessibility';

function WorkSurface({ sessionId }: { sessionId: string }) {
    const activeWork = useActiveWork();
    const hasLayout = Boolean(useSessionState()?.layout.root);
    const tabPanelProps = activeWork
        ? {
              'aria-labelledby': workTabId(sessionId, activeWork),
              'id': workPanelId(sessionId, activeWork),
              'role': 'tabpanel' as const,
          }
        : undefined;
    /**
     * One selected tab owns the work surface even when a Terminal layout splits that surface into
     * multiple panes. The individual panes are not tabs, so only the active work item labels this
     * panel; no panel is exposed before there is an active item.
     */
    if (activeWork?.kind === 'editor')
        return (
            <div className="work-surface relative min-h-0 flex-1" {...tabPanelProps}>
                <EditorSurface path={activeWork.path} />
            </div>
        );
    return (
        <div className="work-surface relative min-h-0 flex-1" {...tabPanelProps}>
            {hasLayout ? (
                <TerminalLayoutView />
            ) : (
                <div className="empty-work flex h-full flex-col items-center justify-center gap-3 text-muted">
                    <TerminalSquare size={30} />
                    <p>No Terminal in this Session.</p>
                    <Button onClick={() => void createTerminal('shell')}>New Terminal</Button>
                </div>
            )}
        </div>
    );
}

function Welcome() {
    return (
        <div className="welcome flex h-full max-w-[540px] flex-col items-center justify-center gap-3 mx-auto p-6 text-center text-muted">
            <Code2 size={38} />
            <h1 className="mt-1 mx-0 mb-0 text-foreground text-[15px]">
                Project-first development.
            </h1>
            <p className="m-0 leading-relaxed">
                Add a local folder as a Project, then keep every Agent and Shell Session together
                beneath it.
            </p>
            <Button onClick={() => void chooseProjectDirectory()}>
                <Plus size={15} /> Add Project
            </Button>
        </div>
    );
}

export function Workbench() {
    const session = useSelectedSession();
    return (
        <section className="workbench flex min-w-0 min-h-0 flex-col bg-background">
            {session ? (
                <>
                    <WorkTabStrip />
                    <WorkSurface sessionId={session.id} />
                </>
            ) : (
                <Welcome />
            )}
        </section>
    );
}
