import type { TranslatedNamespace } from '@caxri/protocol';

import type { connection as source } from '../en/connection';

export const connection: TranslatedNamespace<typeof source> = {
    'connection.error.capacity': 'Caxri 当前无法处理更多此类请求，请稍后再试。',
    'connection.error.conflict': '电脑上的内容已发生变化，请重新打开后重试。',
    'connection.error.forbidden': '此手机无权执行该操作。',
    'connection.error.notFound': '该项目在电脑上已不存在。',
    'connection.error.pathDenied': 'Caxri 无法使用该位置。',
    'connection.error.timeout': 'Caxri 未及时响应。请确认电脑上的 Caxri 正在运行，然后重试。',
    'connection.error.unavailable': '电脑上暂时无法使用此功能。',
    'connection.forget.confirm': '忘记',
    'connection.forget.message':
        '这台手机将不再连接到 {{host}}。如需重新连接，请在电脑上 Caxri 的“设置 → 移动设备”中点击“生成配对码”并重新配对。',
    'connection.forget.title': '忘记这台电脑？',
};
