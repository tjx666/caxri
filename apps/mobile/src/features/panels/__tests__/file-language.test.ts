import '../../../components/prism-grammars';

import { Prism } from 'prism-react-renderer';
import { describe, expect, it } from 'vitest';

import { codeLanguage, fenceLanguage, fileLanguage } from '../file-language';

describe('fileLanguage', () => {
    it('maps common source files to a bundled Prism grammar', () => {
        expect(fileLanguage('auth.test.ts')).toBe('typescript');
        expect(fileLanguage('index.auth.HTML')).toBe('markup');
        expect(fileLanguage('App.tsx')).toBe('tsx');
    });

    it('previews dotfiles, extensionless, and unknown files as plain text', () => {
        expect(fileLanguage('.gitignore')).toBeNull();
        expect(fileLanguage('Makefile')).toBeNull();
        expect(fileLanguage('notes.unknown')).toBeNull();
    });

    it('only names grammars the renderer actually bundles', () => {
        for (const name of [
            'a.c',
            'a.cpp',
            'a.css',
            'a.go',
            'a.gql',
            'a.html',
            'a.js',
            'a.json',
            'a.jsx',
        ])
            expect(Prism.languages[fileLanguage(name) ?? '']).toBeDefined();
        for (const name of [
            'a.kt',
            'a.m',
            'a.md',
            'a.py',
            'a.rs',
            'a.sql',
            'a.swift',
            'a.ts',
            'a.tsx',
            'a.yaml',
            'a.sh',
            'a.diff',
        ])
            expect(Prism.languages[fileLanguage(name) ?? '']).toBeDefined();
    });

    it('maps the language Agent Chat infers for output, painting anything unknown as plain text', () => {
        expect(codeLanguage('shell')).toBe('bash');
        expect(codeLanguage('diff')).toBe('diff');
        expect(codeLanguage('json')).toBe('json');
        expect(codeLanguage('TS')).toBe('typescript');
        expect(codeLanguage('unknownext')).toBeNull();
        expect(codeLanguage(undefined)).toBeNull();
    });
});

describe('fenceLanguage', () => {
    it('reads a fence by extension, Prism name, or alias, ignoring the rest of the info string', () => {
        expect(fenceLanguage('ts')).toBe('typescript');
        expect(fenceLanguage('TypeScript')).toBe('typescript');
        expect(fenceLanguage('bash')).toBe('bash');
        expect(fenceLanguage('sh')).toBe('bash');
        expect(fenceLanguage('json')).toBe('json');
        expect(fenceLanguage('diff')).toBe('diff');
        expect(fenceLanguage('python')).toBe('python');
        expect(fenceLanguage('golang')).toBe('go');
        expect(fenceLanguage(' tsx title="App.tsx"')).toBe('tsx');
    });

    it('keeps a fence without a known language plain', () => {
        expect(fenceLanguage('')).toBeNull();
        expect(fenceLanguage(undefined)).toBeNull();
        expect(fenceLanguage('text')).toBeNull();
        expect(fenceLanguage('brainfuck')).toBeNull();
    });

    it('only names grammars the renderer actually bundles', () => {
        for (const info of [
            'ts',
            'typescript',
            'bash',
            'json',
            'diff',
            'golang',
            'html',
            'objc',
            'console',
        ])
            expect(Prism.languages[fenceLanguage(info) ?? '']).toBeDefined();
    });
});
