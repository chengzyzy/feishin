import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeLogText } from '../../src/shared/utils/log-redaction.ts';
import { sanitizeForDiagnostics } from '../../src/shared/utils/sanitize-for-diagnostics.ts';

test('diagnostics config path redacts credential markers and keeps safe settings', () => {
    const config = {
        general: { accent: 'blue', apiKey: 'config-marker-key' },
        remote: { password: 'config-marker-password', port: 4333, username: 'marker' },
        server: { 'server-1': 'config-marker-encrypted' },
    };

    const redacted = sanitizeForDiagnostics(config);

    assert.equal(redacted.general.accent, 'blue');
    assert.equal(redacted.general.apiKey, '[Redacted]');
    assert.equal(redacted.remote.password, '[Redacted]');
    assert.equal(redacted.server['server-1'], '[Redacted]');
    assert.doesNotMatch(JSON.stringify(redacted), /config-marker/);
    assert.match(JSON.stringify(config), /config-marker/);
});

test('diagnostics log path redacts URLs and auth headers without rewriting the source', () => {
    const originalLog = [
        'GET https://user:log-marker-password@music.example.test/stream?token=log-marker-token&p=log-marker-p&s=log-marker-s&x=keep',
        'Authorization: Bearer log-marker-bearer',
        'normal line stays',
    ].join('\n');

    const redacted = sanitizeLogText(originalLog);

    assert.doesNotMatch(redacted, /log-marker-password/);
    assert.doesNotMatch(redacted, /log-marker-token/);
    assert.doesNotMatch(redacted, /log-marker-bearer/);
    assert.doesNotMatch(redacted, /log-marker-p&/);
    assert.doesNotMatch(redacted, /log-marker-s&/);
    assert.match(redacted, /x=keep/);
    assert.match(redacted, /normal line stays/);
    assert.match(originalLog, /log-marker-token/);
});
