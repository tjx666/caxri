/**
 * Positive fixture proving `@stylistic/lines-between-class-members` stays silent for the intended layout: packed
 * consecutive fields, a blank line before and after methods, and adjacent TypeScript overload signatures. See
 * `scripts/__tests__/eslint-toolchain-contract.test.ts`. This file is not imported by any production or test module.
 */
export class SpacedMethodsFixture {
    firstField = 1;
    secondField = 2;

    overloaded(value: string): string;
    overloaded(value: number): number;
    overloaded(value: string | number): string | number {
        return value;
    }

    other(): void {
        return;
    }
}
