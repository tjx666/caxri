import type { GoState } from './state-model';

export function assertNoPendingValidation(state: GoState): void {
    const pending = state.validations.find(({ result }) => result === 'pending');
    if (pending) {
        throw new Error(
            `Validation ${pending.id} is still pending; evidence-consuming commands require a terminal receipt`,
        );
    }
}

export function assertAllValidationArtifactsAreValid(state: GoState): void {
    const invalidArtifact = state.validations.find(
        ({ logIntegrityError }) => logIntegrityError !== null,
    );
    if (invalidArtifact) {
        throw new Error(
            `Validation ${invalidArtifact.id} artifact is invalid: ${invalidArtifact.logIntegrityError}`,
        );
    }
}

function validationCommandIdentity(validation: GoState['validations'][number]): string {
    return validation.commandDigest ?? validation.command;
}

function isPassingWithoutArtifactError(validation: GoState['validations'][number]): boolean {
    return (
        validation.artifactVersion === 1 &&
        validation.exitCode === 0 &&
        validation.integrityError === null &&
        validation.logError === null &&
        validation.termination === 'exit'
    );
}

/**
 * A full audit persists damaged receipts as failed. Evidence for the same head may proceed only after a later exact
 * command replacement passes, preserving recovery without allowing the corrupted receipt to authorize delivery.
 */
export function assertCurrentHeadArtifactsAreRecoverable(state: GoState, headSha?: string): void {
    if (!headSha) return;
    const passedReplacements = new Set<string>();
    for (let index = state.validations.length - 1; index >= 0; index -= 1) {
        const validation = state.validations[index];
        if (validation.headSha !== headSha) continue;
        const identity = validationCommandIdentity(validation);
        if (validation.result === 'passed') {
            passedReplacements.add(identity);
            continue;
        }
        if (
            validation.logIntegrityError &&
            isPassingWithoutArtifactError(validation) &&
            !passedReplacements.has(identity)
        ) {
            throw new Error(
                `Validation ${validation.id} artifact is invalid and has no passed replacement for head ${headSha}`,
            );
        }
    }
}
