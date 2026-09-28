import type { SourceControlAction, SourceControlViewModel } from '@caxri/protocol';
import { isEqual } from 'es-toolkit';

function* sourceControlActions(model: SourceControlViewModel): Generator<SourceControlAction> {
    yield model.refreshAction;
    yield* model.headerActions ?? [];
    for (const provider of model.providers) {
        yield* provider.actions;
        for (const group of provider.groups) {
            yield* group.actions;
            for (const resource of group.resources) {
                if (resource.action) yield resource.action;
                yield* resource.actions ?? [];
            }
        }
    }
}

/**
 * Finds the action in a newer model that runs the same command as `action`.
 *
 * Action ids are minted per model revision, so a click that lost the race against a background refresh cannot be
 * replayed by id. The command binding is the provider's own statement of what the action does — the bundled Git
 * extension binds repository ids and paths, which stay stable across revisions — so the same binding in the fresh model
 * is the same user intent. A binding that disappeared or became disabled means the intent no longer applies.
 */
export function findSourceControlActionByCommand(
    model: SourceControlViewModel,
    command: SourceControlAction['command'],
): SourceControlAction | undefined {
    for (const candidate of sourceControlActions(model))
        if (
            candidate.command.id === command.id &&
            isEqual(candidate.command.arguments ?? [], command.arguments ?? [])
        )
            return candidate.disabled ? undefined : candidate;
    return undefined;
}

/**
 * The provider refused an action because its model revision had already moved on; see `ExtensionService.viewOperation`.
 */
export const SUPERSEDED = Symbol('superseded');

/**
 * Bounds replays when refreshes keep landing, e.g. an Agent rewriting files in a loop.
 */
const MAX_ACTION_ATTEMPTS = 3;

/**
 * Runs a clicked action against the latest model instead of dropping it.
 *
 * A background refresh — routinely a file watcher — can be in flight when the click lands, or can replace the model
 * between the click and the provider's revision check. Either way the click's action id belongs to a model about to be
 * discarded, so this waits for the refresh (`refetch` joins an in-flight one), re-resolves the action by its command,
 * and runs that. Dropping the click with a warning used to lose a Discard the user plainly asked for.
 */
export async function runSourceControlActionAgainstLatest<Result>(input: {
    action: SourceControlAction;
    isRefreshing: boolean;
    model: SourceControlViewModel;
    refetch: () => Promise<SourceControlViewModel | undefined>;
    run: (action: SourceControlAction, revision: string) => Promise<Result | typeof SUPERSEDED>;
}): Promise<typeof SUPERSEDED | { result: Result; revision: string }> {
    let model: SourceControlViewModel | undefined = input.model;
    let target: SourceControlAction | undefined = input.action;
    for (let attempt = 0; attempt < MAX_ACTION_ATTEMPTS; attempt += 1) {
        if (attempt > 0 || input.isRefreshing) {
            // Each attempt depends on the model the previous refresh produced, so these awaits are sequential by design.
            // eslint-disable-next-line no-await-in-loop
            model = await input.refetch();
            target = model && findSourceControlActionByCommand(model, input.action.command);
        }
        if (!model || !target) return SUPERSEDED;
        // eslint-disable-next-line no-await-in-loop
        const result = await input.run(target, model.revision);
        if (result !== SUPERSEDED) return { result, revision: model.revision };
    }
    return SUPERSEDED;
}
