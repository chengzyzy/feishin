#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const META_PATTERN = /<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i;
const CONTENT_PATTERN = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i;
const INLINE_SCRIPT_PATTERN = /<script\b([^>]*)>/gi;
const SRC_ATTRIBUTE_PATTERN = /\bsrc\s*=\s*(["'])(.*?)\1/i;

const directiveMap = (policy) => {
    const result = new Map();
    for (const part of policy.split(';')) {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) continue;
        result.set(tokens[0].toLowerCase(), new Set(tokens.slice(1)));
    }
    return result;
};

/** Pure validator used by the CLI and the security regression tests. */
export const validateCspHtml = (html) => {
    const errors = [];
    const metaMatches = [...html.matchAll(new RegExp(META_PATTERN.source, 'gi'))];
    if (metaMatches.length !== 1) {
        errors.push(`expected exactly one CSP meta tag, found ${metaMatches.length}`);
    }

    let policy = '';
    if (metaMatches.length === 1) {
        const content = metaMatches[0][0].match(CONTENT_PATTERN);
        if (!content) {
            errors.push('CSP meta tag has no content attribute');
        } else {
            policy = content[2].trim();
            if (!policy) errors.push('CSP meta tag has empty content');
        }
    }

    if (policy) {
        const directives = directiveMap(policy);
        const script = directives.get('script-src');
        const style = directives.get('style-src');
        const defaultSource = directives.get('default-src');
        const image = directives.get('img-src');
        const media = directives.get('media-src');
        const connect = directives.get('connect-src');
        const object = directives.get('object-src');

        if (!script) errors.push('missing script-src');
        if (!style) errors.push('missing style-src');
        if (!defaultSource?.has("'self'")) errors.push("default-src must include 'self'");
        if (!script?.has("'self'")) errors.push("script-src must include 'self'");
        const allowedScriptSources = new Set([
            "'none'",
            "'self'",
            "'unsafe-eval'",
            "'wasm-unsafe-eval'",
        ]);
        for (const directive of ['script-src', 'script-src-elem', 'script-src-attr']) {
            for (const source of directives.get(directive) ?? []) {
                if (!allowedScriptSources.has(source)) {
                    errors.push(`${directive} must not include ${source}`);
                }
            }
        }
        if (!style?.has("'self'") || !style?.has("'unsafe-inline'")) {
            errors.push("style-src must include 'self' and 'unsafe-inline' for Mantine styles");
        }
        if (!image?.has('http:') || !image?.has('https:')) {
            errors.push('img-src must allow HTTP(S) library artwork');
        }
        if (!media?.has('http:') || !media?.has('https:')) {
            errors.push('media-src must allow HTTP(S) media streams');
        }
        if (
            !connect?.has('http:') ||
            !connect?.has('https:') ||
            !connect?.has('ws:') ||
            !connect?.has('wss:')
        ) {
            errors.push('connect-src must allow the library and WebSocket endpoints');
        }
        if (!object?.has("'none'")) errors.push("object-src must be 'none'");
    }

    for (const match of html.matchAll(INLINE_SCRIPT_PATTERN)) {
        const attributes = match[1] || '';
        if (!SRC_ATTRIBUTE_PATTERN.test(attributes)) {
            errors.push('document contains an inline script');
            break;
        }
    }

    return { errors, ok: errors.length === 0, policy };
};

const isMain =
    process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    const target = path.resolve(process.argv[2] || 'out/renderer/index.html');
    let html;
    try {
        html = readFileSync(target, 'utf8');
    } catch (error) {
        console.error(`CSP verification failed: cannot read ${target}: ${error.message}`);
        process.exit(1);
    }

    const result = validateCspHtml(html);
    if (!result.ok) {
        console.error(`CSP verification failed for ${target}`);
        for (const error of result.errors) console.error(`- ${error}`);
        process.exit(1);
    }
    console.log(`CSP verification passed: ${target}`);
    console.log(`policy: ${result.policy}`);
}
