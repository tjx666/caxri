import { CaxriError } from './errors.js';

/**
Fails compilation when a discriminated union gains a member that the caller has not handled.
 */
export function assertNever(value: never, message = 'Unhandled value'): never {
    throw new CaxriError('INTERNAL', `${message}: ${String(value)}`);
}
