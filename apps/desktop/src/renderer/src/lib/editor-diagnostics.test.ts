import { describe, expect, it, vi } from 'vitest';

import type { TypeScriptLanguageDefaults } from './editor-diagnostics';
import { configureTypeScriptDiagnostics } from './editor-diagnostics';

function createLanguageDefaults(): TypeScriptLanguageDefaults {
    return {
        javascriptDefaults: { setDiagnosticsOptions: vi.fn() },
        typescriptDefaults: { setDiagnosticsOptions: vi.fn() },
    };
}

describe('configureTypeScriptDiagnostics', () => {
    it('turns off the semantic and suggestion diagnostics the worker cannot resolve without a project', () => {
        const typescript = createLanguageDefaults();

        configureTypeScriptDiagnostics(typescript);

        expect(typescript.typescriptDefaults.setDiagnosticsOptions).toHaveBeenCalledWith(
            expect.objectContaining({ noSemanticValidation: true, noSuggestionDiagnostics: true }),
        );
    });

    it('keeps syntax validation on so real syntax errors still surface', () => {
        const typescript = createLanguageDefaults();

        configureTypeScriptDiagnostics(typescript);

        expect(typescript.typescriptDefaults.setDiagnosticsOptions).toHaveBeenCalledWith(
            expect.objectContaining({ noSyntaxValidation: false }),
        );
    });

    it('configures JavaScript identically, since it shares the same worker and missing project context', () => {
        const typescript = createLanguageDefaults();

        configureTypeScriptDiagnostics(typescript);

        const [typescriptOptions] = vi.mocked(typescript.typescriptDefaults.setDiagnosticsOptions)
            .mock.calls[0];
        expect(typescript.javascriptDefaults.setDiagnosticsOptions).toHaveBeenCalledWith(
            typescriptOptions,
        );
    });
});
