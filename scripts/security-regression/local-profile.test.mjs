/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../../src/main/local-profile.ts', import.meta.url), 'utf8');
const configureProfile = compileFunction(
    ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    ['require', 'exports'],
);

const run = ({ customProfile = false, name = 'feishin-local', packaged = true } = {}) => {
    const writes = [];
    const imports = {
        electron: {
            app: {
                commandLine: { hasSwitch: () => customProfile },
                getAppPath: () => '/application',
                getPath: () => '/profiles',
                isPackaged: packaged,
                setPath: (...args) => writes.push(args),
            },
        },
        'node:fs': {
            mkdirSync: () => undefined,
            readFileSync: () => JSON.stringify({ name }),
        },
        'node:path': { join },
    };
    configureProfile((name) => imports[name], {});
    return writes;
};

test('the renamed packaged fork uses its existing profile directory', () => {
    assert.deepEqual(run(), [['userData', '/profiles/Feishin Local']]);
});

test('explicit test profiles, development and other distributions keep their own profile', () => {
    assert.deepEqual(run({ customProfile: true }), []);
    assert.deepEqual(run({ packaged: false }), []);
    assert.deepEqual(run({ name: 'feishin' }), []);
});

test('profile selection precedes modules that initialize persistent settings', async () => {
    const entry = await readFile(new URL('../../src/main/index.ts', import.meta.url), 'utf8');
    const profileImport = entry.indexOf("import './local-profile'");
    const settingsImport = entry.indexOf("from './features/core/settings'");
    assert.ok(profileImport >= 0 && profileImport < settingsImport);
});
