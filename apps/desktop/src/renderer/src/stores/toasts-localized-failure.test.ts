import { CaxriError, SERVER_BUSY_DETAILS } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/caxri', () => ({ caxri: { request: vi.fn() } }));

import { applyLanguagePreference, translate } from '../i18n';
import { useNotificationStore } from './notifications';
import { describeFailureNotice, dismissToast, tryCommand } from './toasts';

/**
 * The failure sentence in a locale the Server's English messages are not written in: the reason comes from the error
 * code or a recognized message, and the raw text moves to Copy details.
 */
describe('failure notice in a locale the Server does not write', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
            setTimeout(callback, 0),
        );
        vi.stubGlobal('cancelAnimationFrame', clearTimeout);
        dismissToast();
        useNotificationStore.setState({ entries: [], isOpen: false, mutedTypes: [], sequence: 0 });
        applyLanguagePreference('zh-CN');
    });
    afterEach(() => {
        applyLanguagePreference(null);
        dismissToast();
        vi.unstubAllGlobals();
    });

    it.each([
        ['CONFLICT', '与较新的更改冲突，请刷新后重试。'],
        ['NOT_FOUND', '目标已不存在。'],
        ['PATH_DENIED', '不允许访问该位置。'],
        ['UNAVAILABLE', 'Caxri 尚未就绪。'],
        ['INTERNAL', '发生内部错误。'],
    ] as const)(
        'maps %s to a localized reason and keeps the raw text as detail',
        (code, reason) => {
            expect(
                describeFailureNotice(
                    new CaxriError(code, 'Branch main already exists'),
                    '重命名失败',
                    translate,
                ),
            ).toEqual({
                message: `重命名失败：${reason}`,
                detail: 'Branch main already exists',
            });
        },
    );

    it('never leaves English or an English period in the toast sentence', () => {
        const { message } = describeFailureNotice(
            new Error('socket hang up'),
            '保存失败',
            translate,
        );
        expect(message).toBe('保存失败：无法完成该操作。');
        expect(message).not.toMatch(/[A-Za-z]|\.$/u);
    });

    it('still prefers the errno reason, which already names the cause', () => {
        const error = Object.assign(new Error("ENOENT: open '/tmp/a.txt'"), { code: 'ENOENT' });
        expect(describeFailureNotice(error, '保存失败', translate).message).toBe(
            '保存失败：该文件已不存在。',
        );
    });

    it('names the full Terminal limit and how to free one instead of a bare "limit reached"', () => {
        const global = new CaxriError('CAPACITY', 'Caxri supports at most 64 running Terminals', {
            terminalLimit: 'global',
            limit: 64,
        });
        expect(describeFailureNotice(global, '创建会话失败', translate)).toEqual({
            message: '创建会话失败：已有 64 个 Agent 和终端在运行，请先停止或归档一些再试。',
        });
        const session = new CaxriError('CAPACITY', 'A Session supports at most 16', {
            terminalLimit: 'session',
            limit: 16,
        });
        expect(describeFailureNotice(session, '无法新建终端', translate).message).toBe(
            '无法新建终端：此会话已有 16 个 Agent 和终端在运行，请先关闭一些再试。',
        );
    });

    it('names a busy Server instead of a capacity limit the user never reached', () => {
        const error = new CaxriError(
            'CAPACITY',
            'Too many requests are in flight',
            SERVER_BUSY_DETAILS,
        );
        expect(describeFailureNotice(error, '无法从 Server 刷新项目和会话', translate)).toEqual({
            message: '无法从 Server 刷新项目和会话：Caxri 正忙，请稍后再试。',
        });
    });

    it('names a binary file instead of the misleading IO reason', () => {
        const error = new CaxriError('IO', 'Binary files cannot be opened in the editor');
        expect(describeFailureNotice(error, '无法打开文件', translate).message).toBe(
            '无法打开文件：二进制文件无法在编辑器中打开。',
        );
    });

    it('names a pull request that moved since its merge button was drawn', () => {
        const error = new CaxriError(
            'GIT',
            'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)',
        );
        expect(describeFailureNotice(error, '无法合并 #42', translate).message).toBe(
            '无法合并 #42：这个 Pull Request 有新的提交，请确认后重新合并。',
        );
    });

    it("quotes GitHub's refusal instead of the bare Git reason when a merge is refused", () => {
        const error = new CaxriError(
            'GIT',
            'GitHub refused the merge: Pull request acme/widget#42 is not mergeable: the base branch policy prohibits the merge.',
        );
        expect(describeFailureNotice(error, '无法合并 #42', translate)).toEqual({
            message:
                '无法合并 #42：GitHub 拒绝了合并：Pull request acme/widget#42 is not mergeable: the base branch policy prohibits the merge。',
        });
    });

    it('names an unreachable GitHub instead of a not-ready Server when a merge lost the network', () => {
        const error = new CaxriError(
            'UNAVAILABLE',
            'Could not reach GitHub; check the network and merge again',
        );
        expect(describeFailureNotice(error, '无法合并 #42', translate).message).toBe(
            '无法合并 #42：无法连接 GitHub，请检查网络后重试。',
        );
    });

    it.each([
        [
            'GitHub API rate limit reached; retry after it resets',
            '已达到 GitHub API 限额，请等额度恢复后重试。',
        ],
        [
            'GitHub CLI is not logged in; run `gh auth login`',
            'GitHub CLI 未登录，请运行 gh auth login 后重试。',
        ],
        [
            'GitHub CLI is not signed in; run gh auth login',
            'GitHub CLI 未登录，请运行 gh auth login 后重试。',
        ],
        ['GitHub CLI is not available on PATH', '未找到 GitHub CLI（gh），请先安装。'],
    ] as const)(
        'names the GitHub cause of an UNAVAILABLE merge instead of a not-ready Caxri: %s',
        (message, reason) => {
            const error = new CaxriError('UNAVAILABLE', message);
            expect(describeFailureNotice(error, '无法合并 #42', translate).message).toBe(
                `无法合并 #42：${reason}`,
            );
        },
    );

    it('tryCommand offers the hidden raw text through Copy details', async () => {
        await tryCommand('保存失败', () =>
            Promise.reject(new CaxriError('CONFLICT', 'Branch main already exists')),
        );

        const [entry] = useNotificationStore.getState().entries;
        expect(entry.message).toBe('保存失败：与较新的更改冲突，请刷新后重试。');
        expect(entry.action).toEqual({
            id: 'diagnostics.copyFailure',
            params: { text: 'Branch main already exists' },
        });
    });
});
