export function buildOptions(options: object, timeout?: number) {
    return {
        ...options,
        ...(timeout !== undefined ? { timeout } : {}),
    };
}

export type ExternalValue = unknown;

export function invoke(operation: () => string): string {
    return Reflect.apply(operation, undefined, []);
}

export function widenThenAssert(): { readonly id: string } {
    const source = { id: 'known' };
    const widened: unknown = source;
    return widened as { readonly id: string };
}
