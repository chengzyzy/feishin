/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    prepareSettingsImport,
    readSettingsImportFile,
    SETTINGS_IMPORT_MAX_BYTES,
} from '../../src/shared/utils/settings-import.ts';

const currentSettings = {
    playback: { mpvExtraParameters: ['--local-only-flag=1'], type: 'web' },
    remote: { enabled: false, password: 'local-password', port: 4333, username: 'local' },
};

const createHooks = (overrides = {}) => {
    const calls = [];
    return {
        calls,
        hooks: {
            currentSettings,
            currentVersion: 34,
            migrate: (settings, version) => {
                calls.push(['migrate', version]);
                return { ...settings, migrated: true };
            },
            validate: (settings) => {
                calls.push(['validate', settings]);
                if (settings.bad === true) {
                    return {
                        error: { issues: [{ message: 'bad value', path: ['general', 'bad'] }] },
                        success: false,
                    };
                }
                return { data: settings, success: true };
            },
            ...overrides,
        },
    };
};

const imported = {
    general: { accent: 'blue' },
    playback: { mpvExtraParameters: ['--from-file=evil'], type: 'local' },
    remote: { enabled: true, password: 'file-password', port: 9999, username: 'file' },
    version: 20,
};

test('valid import migrates, validates and preserves local-only settings', () => {
    const { calls, hooks } = createHooks();
    const result = prepareSettingsImport(JSON.stringify(imported), hooks);

    assert.equal(result.ok, true);
    assert.deepEqual(calls[0][0], 'migrate');
    assert.equal(calls[0][1], 20);
    assert.deepEqual(calls[1][0], 'validate');
    assert.deepEqual(result.settings.remote, currentSettings.remote);
    assert.deepEqual(result.settings.playback.mpvExtraParameters, ['--local-only-flag=1']);
    assert.equal(result.settings.migrated, true);
});

test('empty input is rejected before parsing', () => {
    const { hooks } = createHooks();
    assert.deepEqual(prepareSettingsImport('   ', hooks), { code: 'empty', ok: false });
});

test('oversized input is rejected', () => {
    const { hooks } = createHooks();
    const oversized = `"${'x'.repeat(SETTINGS_IMPORT_MAX_BYTES)}"`;
    assert.deepEqual(prepareSettingsImport(oversized, hooks), { code: 'too-large', ok: false });
});

test('invalid JSON, root and version are rejected with distinct codes', () => {
    const { hooks } = createHooks();
    assert.equal(prepareSettingsImport('{not json', hooks).code, 'invalid-json');
    assert.equal(prepareSettingsImport('[]', hooks).code, 'invalid-root');
    assert.equal(
        prepareSettingsImport(JSON.stringify({ ...imported, version: '20' }), hooks).code,
        'invalid-version',
    );
    assert.equal(
        prepareSettingsImport(JSON.stringify({ ...imported, version: -1 }), hooks).code,
        'invalid-version',
    );
    assert.equal(
        prepareSettingsImport(JSON.stringify({ ...imported, version: 99 }), hooks).code,
        'invalid-version',
    );
});

test('migration and schema failures are reported and stop later stages', () => {
    const migrateError = createHooks({
        migrate: () => {
            throw new Error('migration marker');
        },
    });
    const migrated = prepareSettingsImport(JSON.stringify(imported), migrateError.hooks);
    assert.equal(migrated.code, 'migration-failed');
    assert.match(migrated.detail, /migration marker/);

    const invalid = createHooks();
    const invalidResult = prepareSettingsImport(
        JSON.stringify({ ...imported, bad: true }),
        invalid.hooks,
    );
    assert.equal(invalidResult.code, 'schema-invalid');
    assert.match(invalidResult.detail, /general\.bad/);
    assert.deepEqual(invalid.calls, [
        ['migrate', 20],
        ['validate', invalid.calls[1][1]],
    ]);
});

test('file read path enforces size before reading and reports read failures', async () => {
    const { hooks } = createHooks();
    let readCalled = false;
    const tooLarge = await readSettingsImportFile(
        {
            size: SETTINGS_IMPORT_MAX_BYTES + 1,
            text: async () => {
                readCalled = true;
                return '';
            },
        },
        hooks,
    );
    assert.equal(tooLarge.code, 'too-large');
    assert.equal(readCalled, false);

    const failed = await readSettingsImportFile(
        {
            size: 10,
            text: async () => {
                throw new Error('read marker');
            },
        },
        hooks,
    );
    assert.equal(failed.code, 'read-failed');
    assert.match(failed.detail, /read marker/);

    const success = await readSettingsImportFile(
        {
            size: JSON.stringify(imported).length,
            text: async () => JSON.stringify(imported),
        },
        hooks,
    );
    assert.equal(success.ok, true);
    assert.deepEqual(success.settings.remote, currentSettings.remote);
});
