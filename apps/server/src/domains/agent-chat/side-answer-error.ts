import { CaxriError } from '@caxri/protocol';

/**
 * A provider that finished a side question without an answer, as opposed to one that failed; the log tells them apart.
 */
export class EmptySideAnswerError extends CaxriError {
    constructor(provider: string) {
        super('UNAVAILABLE', `${provider} did not answer the side question`);
    }
}
