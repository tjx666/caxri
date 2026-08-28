import { Code2, Plus } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useSelectedSession } from '../../stores/selectors';
import { chooseProjectDirectory } from '../session/session-actions';
import { PaneView } from './pane-view';

function Welcome() {
    return (
        <div className="welcome mx-auto flex h-full max-w-[540px] flex-col items-center justify-center gap-3 p-6 text-center text-muted">
            <Code2 size={38} />
            <h1 className="mx-0 mt-1 mb-0 text-[15px] text-foreground">
                Project-first development.
            </h1>
            <p className="m-0 leading-relaxed">
                Add a folder as a Project, then keep every Agent and Shell Session together beneath
                it.
            </p>
            <Button
                onClick={() => {
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, chooseProjectDirectory() reports its own errors via tryCommand
                    void chooseProjectDirectory();
                }}
            >
                <Plus size={15} /> Add Project
            </Button>
        </div>
    );
}

/**
 * The Workbench is now nothing but the pane tree: there is no Workbench-level tab strip and no Terminal-versus-Editor
 * surface switch, because every tab lives in the bar of the pane that holds it.
 */
export function Workbench() {
    const session = useSelectedSession();
    return (
        <section className="workbench flex min-h-0 min-w-0 flex-col bg-background">
            {session ? <PaneView /> : <Welcome />}
        </section>
    );
}
