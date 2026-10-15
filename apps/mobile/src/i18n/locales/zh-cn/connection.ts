import type { TranslatedNamespace } from '@caxri/protocol';

import type { connection as source } from '../en/connection';

export const connection: TranslatedNamespace<typeof source> = {
    'connection.forget.confirm': '忘记',
    'connection.forget.message': '此手机将不再连接到 {{host}}。如需重新连接，请在桌面端重新配对。',
    'connection.forget.title': '忘记这台电脑？',
};
