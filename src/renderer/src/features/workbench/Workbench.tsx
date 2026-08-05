import { Code2, Plus, TerminalSquare } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useSelectedSession, useSessionState } from '../../state/selectors';
import { useActiveWork } from '../../state/session-view';
import { EditorSurface } from '../editor/EditorSurface';
import { chooseProjectDirectory } from '../session/session-actions';
import { createTerminal } from '../terminal/terminal-actions';
import { TerminalLayoutView } from '../terminal/TerminalLayoutView';
import { WorkTabStrip } from '../tabs/WorkTabStrip';

function WorkSurface() {
    const activeWork = useActiveWork();
    const hasLayout = Boolean(useSessionState()?.layout.root);
    if (activeWork?.kind === 'editor')
        return (
            <div className="work-surface">
                <EditorSurface path={activeWork.path} />
            </div>
        );
    return (
        <div className="work-surface">
            {hasLayout ? (
                <TerminalLayoutView />
            ) : (
                <div className="empty-work">
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
        <div className="welcome">
            <Code2 size={38} />
            <h1>Project-first development.</h1>
            <p>
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
        <section className="workbench">
            {session ? (
                <>
                    <WorkTabStrip />
                    <WorkSurface />
                </>
            ) : (
                <Welcome />
            )}
        </section>
    );
}
