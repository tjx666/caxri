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
