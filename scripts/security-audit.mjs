#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const outputDir = option('--output', 'dist/audit');
const timeoutMs = Number(option('--timeout-ms', '180000'));

const ALLOWED_ADVISORIES = new Map([
    [
        'GHSA-3g3m-2fjr-6pw4|glob|10.5.0',
        'accepted moderate build-tooling risk; build-time dependency only',
    ],
    [
        'GHSA-3g3m-2fjr-6pw4|glob|11.1.0',
        'accepted moderate build-tooling risk; build-time dependency only',
    ],
    [
        'GHSA-g3hv-75wg-m249|minimatch|9.0.9',
        'accepted moderate build-tooling risk; build-time dependency only',
    ],
    [
        'GHSA-g3hv-75wg-m249|minimatch|10.2.6',
        'accepted moderate build-tooling risk; build-time dependency only',
    ],
    [
        'GHSA-gcqx-w48m-w2h4|deepmerge|4.3.1',
        'accepted low-severity transitive risk from react-player and workbox; no direct untrusted merge path in the app',
    ],
    [
        'GHSA-mrhx-c7xc-m3w5|zod|3.25.76',
        'accepted Zod 3 compatibility risk; settings imports are size-limited and validated',
    ],
]);

const severityRank = { critical: 4, high: 3, info: 0, low: 1, moderate: 2 };

mkdirSync(outputDir, { recursive: true });

const started = Date.now();
const command = process.env.PNPM_BIN || 'pnpm';
const result = spawnSync(command, ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
});
const elapsedMs = Date.now() - started;

const stdout = result.stdout || '';
const stderr = result.stderr || '';
writeFileSync(path.join(outputDir, 'audit.json'), stdout);
writeFileSync(path.join(outputDir, 'audit.stderr.log'), stderr);
writeFileSync(
    path.join(outputDir, 'audit-command.txt'),
    [
        `command=${command} audit --json`,
        `timeout_ms=${timeoutMs}`,
        `elapsed_ms=${elapsedMs}`,
        `exit=${result.status === null ? 'null' : result.status}`,
        `signal=${result.signal || ''}`,
        `error=${result.error ? String(result.error.message) : ''}`,
    ].join('\n'),
);

let audit;
try {
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
        throw new Error(`pnpm audit exited with status ${result.status}`);
    }
    audit = JSON.parse(stdout);
    const counts = audit?.metadata?.vulnerabilities;
    if (
        !audit?.advisories ||
        typeof audit.advisories !== 'object' ||
        Array.isArray(audit.advisories) ||
        !Number.isInteger(counts?.high) ||
        !Number.isInteger(counts?.critical)
    ) {
        throw new Error('pnpm audit did not return advisory results');
    }
} catch (error) {
    const summary = `AUDIT_COMMAND_FAILED: ${error.message}`;
    writeFileSync(path.join(outputDir, 'audit-summary.txt'), `${summary}\n`);
    console.error(summary);
    process.exit(1);
}

const lines = ['Dependency audit summary (not a zero-vulnerability claim)'];
if (result.status !== 0) lines.push(`AUDIT_EXIT_CODE: ${result.status}`);

let unexpectedHighOrCritical = 0;
const advisories = Object.values(audit.advisories || {});
for (const advisory of advisories) {
    if ((severityRank[advisory.severity] || 0) >= severityRank.high && !advisory.findings?.length) {
        unexpectedHighOrCritical += 1;
    }
    for (const finding of advisory.findings || []) {
        const key = `${advisory.github_advisory_id}|${advisory.module_name}|${finding.version}`;
        const acceptedReason = ALLOWED_ADVISORIES.get(key);
        const severity = advisory.severity || 'unknown';
        const accepted = Boolean(acceptedReason);
        if (!accepted && (severityRank[severity] || 0) >= severityRank.high) {
            unexpectedHighOrCritical += 1;
        }
        lines.push(
            [
                `severity=${severity}`,
                `advisory=${advisory.github_advisory_id}`,
                `package=${advisory.module_name}@${finding.version}`,
                `dev=${Boolean(finding.dev)}`,
                accepted ? 'accepted=yes' : 'accepted=no',
                acceptedReason ? `reason=${acceptedReason}` : '',
            ]
                .filter(Boolean)
                .join(' '),
        );
    }
}

const counts = audit.metadata?.vulnerabilities || {};
lines.push(`counts=${JSON.stringify(counts)}`);
if (unexpectedHighOrCritical > 0) {
    lines.push(`UNEXPECTED_HIGH_OR_CRITICAL=${unexpectedHighOrCritical}`);
} else {
    lines.push('unexpected_high_or_critical=0');
}
writeFileSync(path.join(outputDir, 'audit-summary.txt'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));

if (unexpectedHighOrCritical > 0) {
    console.error(`unexpected high/critical advisories: ${unexpectedHighOrCritical}`);
    process.exit(1);
}
