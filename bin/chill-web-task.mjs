#!/usr/bin/env node
// Task Scheduler entry for Web and the public link connector on Windows. A task
// cannot set environment variables or redirect output, so this reads the service
// file written by `server start` (or the connector), runs server.mjs or the
// file's `command` with that environment and logs its output. The program is an
// ordinary child: if this process is ended, so is the program.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomically } from '../lib/storage.mjs';

const file = process.argv[2];
const service = JSON.parse(await readFile(file, 'utf8'));
const log = openSync(service.log, 'a');
const [command, args] = service.command ? [service.command, service.args] : [process.execPath, [service.entry, ...service.args]];
const child = spawn(command, args, { cwd: service.cwd, env: { ...process.env, ...service.env }, stdio: ['ignore', log, log], windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
await writeJsonAtomically(service.state, { task: process.pid, pid: child.pid, startedAt: Date.now() });
child.on('exit', code => { process.exitCode = code ?? 1; });
