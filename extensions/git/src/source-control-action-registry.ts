import type { ActionRegistration, RegisterSourceControlAction } from './source-control-model';

interface RegisteredAction {
    command: ActionRegistration['command'];
    revision: string;
}

/**
 * The commands behind the action ids one scope handed to the Renderer, each bound to the revision it was issued for.
 */
export class SourceControlActionRegistry {
    private readonly actions = new Map<string, RegisteredAction>();
    private sequence = 0;

    /**
     * Forgets every action when the scope moves to a new revision. Ids restart too: every action is bound to its
     * revision anyway, and a re-read of an unchanged repository then hands the Renderer an equal model, which query
     * structural sharing keeps by reference instead of re-rendering every Source Control row for fresh ids (#3413).
     */
    clear(): void {
        this.actions.clear();
        this.sequence = 0;
    }

    get(id: string): RegisteredAction | undefined {
        return this.actions.get(id);
    }

    registerFor(revision: () => string): RegisterSourceControlAction {
        return (action) => {
            const id = `action-${++this.sequence}`;
            this.actions.set(id, { command: action.command, revision: revision() });
            return { id, ...action };
        };
    }
}
