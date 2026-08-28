/**
 * Negative fixture proving `@stylistic/lines-between-class-members` is wired in `eslint.config.ts`; see
 * `scripts/__tests__/eslint-toolchain-contract.test.ts`. Adjacent methods with no blank line must trip the rule. This
 * file is not imported by any production or test module.
 */
export class PackedMethodsFixture {
    first(): void {
        return;
    }
    second(): void {
        return;
    }
}
