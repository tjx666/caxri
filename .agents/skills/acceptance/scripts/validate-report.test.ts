import { describe, expect, it } from 'vitest';

import { validateReportLanguage } from './validate-report';

const chineseReport = {
    cases: [
        {
            category: '终端布局',
            name: '终端内容填满工作区',
            observation: '终端视口周围没有露出应用背景。',
        },
    ],
    entry: '在 Caxri Electron 中打开首个 Session 终端。',
    plan: [
        {
            category: '终端布局',
            expected: '终端视口周围不出现应用背景色条。',
            method: '启动隔离的 Caxri 并检查稳定后的终端布局。',
            title: '终端内容填满工作区',
        },
    ],
    summary: { conclusion: '当前 PR 头提交满足计划中的桌面验收项。' },
    title: '验收 Caxri 终端布局',
};

describe('Acceptance report language', () => {
    it('accepts Simplified Chinese human-facing report text', () => {
        expect(() =>
            validateReportLanguage({
                notes: '本轮验收无已知限制。',
                report: chineseReport,
                requirement: 'Caxri 终端应完整填满工作区。',
            }),
        ).not.toThrow();
    });

    it('accepts short fields when their prose is entirely Chinese', () => {
        expect(() =>
            validateReportLanguage({
                report: {
                    ...chineseReport,
                    cases: [{ ...chineseReport.cases[0], category: '终端', name: '标题栏' }],
                    plan: [{ ...chineseReport.plan[0], category: '终端', title: '标题栏' }],
                },
                requirement: '终端布局。',
            }),
        ).not.toThrow();
    });

    it('accepts short Chinese fields with English technical identifiers', () => {
        expect(() =>
            validateReportLanguage({
                report: {
                    ...chineseReport,
                    cases: [{ ...chineseReport.cases[0], category: 'Git 面板', name: 'IPC 契约' }],
                    plan: [{ ...chineseReport.plan[0], category: 'Git 面板', title: 'IPC 契约' }],
                },
                requirement: '验证 Git 面板与 IPC 契约。',
            }),
        ).not.toThrow();
    });

    it('ignores Markdown structure, link targets, and code when validating notes', () => {
        expect(() =>
            validateReportLanguage({
                notes: [
                    '后续事项：见 https://github.com/tjx666/caxri/issues/42',
                    '后续事项参见 [issue caxri#42](https://github.com/tjx666/caxri/issues/42)。',
                    '---',
                    '| 项目 | 状态 |',
                    '| --- | --- |',
                    '![终端截图](assets/terminal.png)',
                    '```sh',
                    'bun run test',
                    '```',
                ].join('\n'),
                report: chineseReport,
                requirement: 'Caxri 终端应完整填满工作区。',
            }),
        ).not.toThrow();
    });

    it('rejects an English-only human-facing field', () => {
        expect(() =>
            validateReportLanguage({
                report: { ...chineseReport, title: 'Verify Caxri terminal layout' },
                requirement: 'Caxri 终端应完整填满工作区。',
            }),
        ).toThrow('must be primarily Chinese');
    });

    it('rejects an English-only Acceptance requirement', () => {
        expect(() =>
            validateReportLanguage({
                report: chineseReport,
                requirement: 'Caxri should fill the workspace',
            }),
        ).toThrow('must be primarily Chinese');
    });

    it('rejects English prose padded with a Chinese token or hidden comment', () => {
        expect(() =>
            validateReportLanguage({
                notes: '<!-- 中文占位 -->\nThis report is written entirely in English.',
                report: chineseReport,
                requirement: 'Caxri 终端应完整填满工作区。',
            }),
        ).toThrow('must be primarily Chinese');
        expect(() =>
            validateReportLanguage({
                notes: '本轮暂无补充说明。\nThis line is still written in English.',
                report: chineseReport,
                requirement: 'Caxri 终端应完整填满工作区。',
            }),
        ).toThrow('report.md line 2 must be primarily Chinese');
        expect(() =>
            validateReportLanguage({
                report: { ...chineseReport, title: 'Verify every Caxri interaction 中文' },
                requirement: 'Caxri 终端应完整填满工作区。',
            }),
        ).toThrow('must be primarily Chinese');
    });

    it('reports the original file line for invalid notes', () => {
        expect(() =>
            validateReportLanguage({
                notes: '本轮暂无补充说明。\n\n```sh\nbun run test\n```\n\nEnglish prose remains here.',
                report: chineseReport,
                requirement: 'Caxri 终端应完整填满工作区。',
            }),
        ).toThrow('report.md line 7 must be primarily Chinese');
    });
});
