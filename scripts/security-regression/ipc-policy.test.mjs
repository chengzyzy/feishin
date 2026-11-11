import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isAllowedSettingsKey,
    isHttpUrl,
    isValidServerId,
    isValidStoredPassword,
    validateSettingsWrite,
} from '../../src/main/security/ipc-policy.ts';

test('allowed renderer settings accept the expected value types', () => {
    assert.equal(validateSettingsWrite('ignore_cors', true).ok, true);
    assert.equal(validateSettingsWrite('window_enable_tray', false).ok, true);
    assert.equal(validateSettingsWrite('window_window_bar_style', 'macos').ok, true);
    assert.equal(validateSettingsWrite('playbackType', 'local').ok, true);
    assert.equal(validateSettingsWrite('password_store', 'gnome_libsecret').ok, true);
    assert.equal(validateSettingsWrite('lyrics', ['NetEase', 'lrclib.net']).ok, true);
});

test('wrong types and unknown keys are rejected', () => {
    assert.equal(validateSettingsWrite('ignore_ssl', 'true').ok, false);
    assert.equal(validateSettingsWrite('playbackType', 'shell').ok, false);
    assert.equal(validateSettingsWrite('window_enable_tray', null).ok, false);
    assert.equal(validateSettingsWrite('lyrics', ['ok', 1]).ok, false);
    assert.equal(validateSettingsWrite('not-a-setting', true).ok, false);
});

test('prototype properties cannot be used as settings keys', () => {
    for (const key of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']) {
        assert.equal(isAllowedSettingsKey(key), false, key);
        assert.equal(validateSettingsWrite(key, true).ok, false, key);
    }

    assert.equal(isAllowedSettingsKey('ignore_ssl'), true);
});

test('protected path and credential keys cannot be written through generic settings-set', () => {
    for (const key of [
        'mpv_path',
        'local_font_path',
        'server',
        'release_channel',
        'disable_auto_updates',
        'bounds',
    ]) {
        const decision = validateSettingsWrite(key, '/tmp/marker');
        assert.equal(decision.ok, false, key);
    }
});

test('credential inputs are length- and shape-checked', () => {
    assert.equal(isValidServerId('server_1-abc'), true);
    assert.equal(isValidServerId('server 1'), false);
    assert.equal(isValidServerId('x'.repeat(129)), false);
    assert.equal(isValidStoredPassword('secret'), true);
    assert.equal(isValidStoredPassword(''), false);
    assert.equal(isValidStoredPassword('x'.repeat(4097)), false);
});

test('download URLs are limited to http and https', () => {
    assert.equal(isHttpUrl('https://music.example.test/track/1'), true);
    assert.equal(isHttpUrl('http://127.0.0.1:4533/stream'), true);
    assert.equal(isHttpUrl('file:///tmp/marker'), false);
    assert.equal(isHttpUrl('javascript:alert(1)'), false);
    assert.equal(isHttpUrl('x'.repeat(5000)), false);
});
