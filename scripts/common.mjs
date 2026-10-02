// Copyright 2026 Heapy
// SPDX-License-Identifier: Apache-2.0

import { appendFile, access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function bool(value, name) {
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
  return value === 'true';
}
export function names(value, name) {
  return value.split(/[\s,]+/).filter(Boolean).map(item => {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:@/-]*$/.test(item) || item.includes('..')) throw new Error(`Invalid ${name}: ${item}`);
    return item;
  });
}
export function escapeCommand(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}
export function escapeMarkdown(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('\n', ' ');
}
export async function output(name, value, env = process.env) {
  if (/[\r\n]/.test(String(value))) throw new Error(`Multiline output ${name}`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
export async function summary(markdown, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, markdown);
}
export async function projectDirectory(value, env = process.env) {
  const workspace = await realpath(env.GITHUB_WORKSPACE || process.cwd());
  const dir = await realpath(path.resolve(workspace, value || '.'));
  const relative = path.relative(workspace, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('working-directory must stay inside GITHUB_WORKSPACE');
  return dir;
}
export async function executable(directory, env = process.env, local = false) {
  const filename = process.platform === 'win32' ? 'kotlin.bat' : 'kotlin';
  const candidates = local ? [path.join(directory, filename)]
    : [...(env.KOTLIN_TOOLCHAIN_BIN ? [path.join(env.KOTLIN_TOOLCHAIN_BIN, filename)] : []),
       ...(env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, filename))];
  for (const candidate of candidates) {
    try { await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return candidate; }
    catch { /* Try next PATH entry. */ }
  }
  throw new Error('Kotlin Toolchain is unavailable. Run Heapy/setup-ktc first.');
}
export function run(exe, args, { cwd, env = process.env, quiet = false, timeout = 20 * 60_000 } = {}) {
  let command = exe, argv = args;
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(exe)) {
    if ([exe, ...args].some(arg => /["%\r\n]/.test(arg))) throw new Error('Unsafe Windows command argument');
    const originalPath = (env.Path || env.PATH || '').split(';').filter(dir => !/strawberry|[\\/]git[\\/](usr|mingw64)[\\/]bin/i.test(dir)).join(';');
    env = { ...env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = path.join(env.SystemRoot || 'C:\\Windows', 'System32') + ';' + originalPath;
    command = 'cmd.exe';
    argv = ['/d', '/v:off', '/s', '/c', `"${[exe, ...args].map(arg => `"${arg}"`).join(' ')}"`];
  }
  const result = spawnSync(command, argv, { cwd, env, encoding: 'utf8', timeout,
    windowsVerbatimArguments: command === 'cmd.exe', maxBuffer: 32 * 1024 * 1024 });
  if (!quiet) {
    const marker = randomUUID();
    if (env.GITHUB_ACTIONS) console.log(`::stop-commands::${marker}`);
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (env.GITHUB_ACTIONS) console.log(`\n::${marker}::`);
  }
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}
export function requireToolchain(exe, cwd, env = process.env) {
  const result = run(exe, ['--version'], { cwd, env, quiet: true });
  if (result.status !== 0 || !/Kotlin Toolchain version /.test(result.stdout)) throw new Error('Expected JetBrains Kotlin Toolchain; install it with Heapy/setup-ktc');
  return result.stdout.trim();
}
