import assert from 'node:assert/strict';
import test from 'node:test';

import {
    redactUrlForLog,
    sanitizeLogText,
    summarizeUrlForLog,
} from '../../src/shared/utils/log-redaction.ts';

test('URL userinfo and authentication query values are redacted', () => {
    const raw =
        'request https://alice:secret@music.example.test/api?token=abc123&username=alice&u=alice&p=subsonic-password&s=subsonic-salt&x=keep';
    const redacted = sanitizeLogText(raw);

    assert.match(redacted, /music\.example\.test/);
    assert.doesNotMatch(redacted, /secret/);
    assert.doesNotMatch(redacted, /abc123/);
    assert.doesNotMatch(redacted, /username=alice/);
    assert.doesNotMatch(redacted, /u=alice/);
    assert.doesNotMatch(redacted, /subsonic-password/);
    assert.doesNotMatch(redacted, /subsonic-salt/);
    assert.doesNotMatch(redacted, /p=subsonic-password/);
    assert.doesNotMatch(redacted, /s=subsonic-salt/);
    assert.match(redacted, /x=keep/);
    assert.match(redacted, /redacted/);
});

test('authorization headers and bearer tokens are redacted', () => {
    const redacted = sanitizeLogText('Authorization: Bearer abc.def.ghi\nX-Test: keep');
    assert.doesNotMatch(redacted, /abc\.def\.ghi/);
    assert.match(redacted, /X-Test: keep/);
});

test('media URL summary drops query, hash and userinfo', () => {
    const summary = summarizeUrlForLog(
        'https://user:pass@media.example.test/stream/1?token=marker#fragment',
    );
    assert.equal(summary, 'https://media.example.test/stream/1?[redacted]');
    assert.doesNotMatch(summary, /marker/);
    assert.doesNotMatch(summary, /pass/);
});

test('malformed URL does not echo the original text', () => {
    assert.equal(redactUrlForLog('not a url'), '[redacted-url]');
    assert.equal(summarizeUrlForLog('not a url'), '[redacted-url]');
});
