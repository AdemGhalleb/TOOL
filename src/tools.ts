import {spawn, type ChildProcess} from 'node:child_process';
import {
  open,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {ToolCancellationError, ToolCleanupError} from './types.ts';
import type {ToolSpec} from './types.ts';

const MAX_TEXT = 12_000;
export const COMMAND_TERMINATION_GRACE_MS = 500;
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_CLOSE_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 1_000_000;
const COMMAND_PROCESS_POLL_MS = 50;

export const SEARCH_LIMITS = {
  maxFiles: 1_000,
  maxFileBytes: 1_024 * 1_024,
  maxTotalBytes: 5 * 1_024 * 1_024,
  maxMatches: 50,
} as const;

const COMMAND_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
  'COMSPEC',
] as const;

function assertActive(context: {signal?: AbortSignal}): void {
  if (context.signal?.aborted) {
    throw new ToolCancellationError();
  }
}

function appendBounded(chunks: Buffer[], chunk: Buffer, total: {value: number}): boolean {
  const remaining = COMMAND_MAX_BUFFER - total.value;
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  total.value += chunk.length;
  return total.value > COMMAND_MAX_BUFFER;
}

function processStillExists(executable: string, pid: number): Promise<boolean> {
  return new Promise(resolve => {
    let checker: ChildProcess;
    try {
      checker = spawn(executable, ['/FI', `PID eq ${pid}`, '/NH'], {
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      });
    } catch {
      resolve(true);
      return;
    }

    let output = '';
    checker.stdout?.on('data', chunk => { output += String(chunk); });
    checker.once('error', () => resolve(true));
    checker.once('close', code => {
      resolve(code !== 0 || new RegExp(`\\b${pid}\\b`).test(output));
    });
  });
}

function waitForProcessExit(executable: string, pid: number): Promise<boolean> {
  return new Promise(resolve => {
    const deadline = Date.now() + COMMAND_CLOSE_TIMEOUT_MS;
    const poll = async (): Promise<void> => {
      if (!(await processStillExists(executable, pid))) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(() => { void poll(); }, COMMAND_PROCESS_POLL_MS);
    };
    void poll();
  });
}

function invokeTaskkill(pid: number, force: boolean): Promise<boolean> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const executable = systemRoot
    ? join(systemRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe';
  return new Promise(resolveTaskkill => {
    let killer: ChildProcess;
    try {
      killer = spawn(executable, ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        stdio: 'ignore', windowsHide: true,
      });
    } catch {
      resolveTaskkill(false);
      return;
    }

    let settled = false;
    const settle = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      resolveTaskkill(succeeded);
    };
    const limit = setTimeout(() => {
      try { killer.kill(); } catch {}
      settle(false);
    }, COMMAND_CLOSE_TIMEOUT_MS);
    killer.once('error', () => settle(false));
    killer.once('close', async code => {
      settle(code === 0 && await waitForProcessExit(executable, pid));
    });
  });
}

export function executeCommand(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onSpawn?: () => void;
    onClose?: () => void;
  },
): Promise<{exitCode: number; stdout: string; stderr: string; error: string | null}> {
  assertActive(options);
  return new Promise((resolveCommand, rejectCommand) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [], {
        cwd: options.cwd, env: options.env, shell: true, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { rejectCommand(error); return; }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutSize = {value: 0};
    const stderrSize = {value: 0};
    let spawnError: Error | null = null;
    let stopReason: 'cancelled' | 'timeout' | 'maxBuffer' | null = null;
    let escalation: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let closeTimeout: NodeJS.Timeout | undefined;
    let closed = false;
    let treeCleanupFailed = false;
    let treeCleanupConfirmed = false;
    let termination: Promise<void> = Promise.resolve();
    const sendSignal = (force: boolean): Promise<void> => {
      if (process.platform === 'win32') {
        if (!child.pid) {
          treeCleanupFailed = true;
          child.kill(force ? 'SIGKILL' : 'SIGTERM');
          return Promise.resolve();
        }
        const attempt = invokeTaskkill(child.pid, force).then(succeeded => {
          if (!succeeded) {
            if (!treeCleanupConfirmed) treeCleanupFailed = true;
            // Keep the direct child stoppable if taskkill is unavailable or denies access.
            try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {}
          } else {
            treeCleanupConfirmed = true;
            treeCleanupFailed = false;
          }
        });
        termination = attempt;
        return attempt;
      } else {
        try {
          if (child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
          else child.kill(force ? 'SIGKILL' : 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return Promise.resolve();
          child.kill(force ? 'SIGKILL' : 'SIGTERM');
        }
        return Promise.resolve();
      }
    };
    const beginStop = (reason: typeof stopReason): void => {
      if (closed || stopReason) return;
      stopReason = reason;
      const forceImmediately = process.platform === 'win32' && reason === 'cancelled';
      void sendSignal(forceImmediately);
      if (!forceImmediately) {
        escalation = setTimeout(() => { void sendSignal(true); }, COMMAND_TERMINATION_GRACE_MS);
      }
      closeTimeout = setTimeout(() => {
        if (closed) return;
        cleanup();
        rejectCommand(new ToolCleanupError());
      }, COMMAND_CLOSE_TIMEOUT_MS);
    };
    const onAbort = () => beginStop('cancelled');
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      clearTimeout(closeTimeout);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (appendBounded(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), stdoutSize)) beginStop('maxBuffer');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (appendBounded(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), stderrSize)) beginStop('maxBuffer');
    });
    child.on('error', error => { spawnError = error; });
    child.once('spawn', () => {
      options.onSpawn?.();
      // An abort can race with asynchronous process creation before a PID exists.
      if (stopReason) void sendSignal(false);
    });
    child.once('close', async (code, signal) => {
      closed = true;
      options.onClose?.();
      cleanup();
      await termination;
      if (stopReason === 'cancelled') {
        if (treeCleanupFailed) {
          rejectCommand(new ToolCleanupError());
          return;
        }
        rejectCommand(new ToolCancellationError());
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString('utf8').slice(0, MAX_TEXT);
      const stderrText = Buffer.concat(stderr).toString('utf8').slice(0, MAX_TEXT);
      const error = stopReason === 'timeout' ? 'Command timed out.'
        : stopReason === 'maxBuffer' ? 'Command output exceeded the maximum buffer.'
          : spawnError?.message ?? (code === 0 ? null : `Command exited ${signal ? `from ${signal}` : `with code ${code ?? 1}`}.`);
      resolveCommand({exitCode: code ?? 1, stdout: stdoutText, stderr: stderrText, error});
    });
    options.signal?.addEventListener('abort', onAbort, {once: true});
    if (options.signal?.aborted) onAbort();
    timeout = setTimeout(() => beginStop('timeout'), COMMAND_TIMEOUT_MS);
  });
}

export function buildCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const name of COMMAND_ENV_ALLOWLIST) {
    const key = Object.keys(source).find(
      candidate => candidate.toUpperCase() === name,
    );
    if (key !== undefined && source[key] !== undefined) {
      environment[key] = source[key];
    }
  }

  return environment;
}

function requiredString(
  args: Record<string, unknown>,
  name: string,
  allowEmpty = false,
): string {
  const value = args[name];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`,
    );
  }

  return value;
}

async function boundedPath(root: string, inputPath: string): Promise<string> {
  const rootPath = await realpath(root);
  const targetPath = await realpath(resolve(root, inputPath));
  const relativeTarget = relative(rootPath, targetPath);

  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`Path escapes the workspace: ${inputPath}`);
  }

  return targetPath;
}

function mutationPath(root: string, inputPath: string): string {
  // Resolve the proposed target without requiring it to exist yet.
  const target = resolve(root, inputPath);
  const relativeTarget = relative(root, target);

  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`Path escapes the workspace: ${inputPath}`);
  }

  return target;
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function assertNoSymlinkPath(
  root: string,
  target: string,
): Promise<void> {
  let current = root;

  // Check every existing segment before a mutation is approved.
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = resolve(current, part);

    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed: ${part}`);
      }
    } catch (error) {
      if (isErrno(error) && error.code === 'ENOENT') {
        return;
      }

      throw error;
    }
  }
}

type SearchState = {
  filesConsidered: number;
  bytesRead: number;
  matches: string[];
  truncated: boolean;
  stop: boolean;
};

async function walkFiles(
  directory: string,
  visit: (file: string, state: SearchState) => Promise<void>,
  state: SearchState,
): Promise<void> {
  if (state.stop || state.filesConsidered >= SEARCH_LIMITS.maxFiles) {
    state.truncated = true;
    state.stop = true;
    return;
  }

  const entries = await readdir(directory, {withFileTypes: true});

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      await walkFiles(target, visit, state);
      if (state.stop) return;
    } else if (entry.isFile()) {
      if (state.filesConsidered >= SEARCH_LIMITS.maxFiles) {
        state.truncated = true;
        state.stop = true;
        return;
      }
      state.filesConsidered++;
      await visit(target, state);
      if (state.stop) return;
    }
  }
}

async function searchFiles(
  root: string,
  directory: string,
  query: string,
  signal?: AbortSignal,
): Promise<{matches: string[]; truncated: boolean}> {
  const state: SearchState = {
    filesConsidered: 0,
    bytesRead: 0,
    matches: [],
    truncated: false,
    stop: false,
  };

  await walkFiles(directory, async (file, searchState) => {
    if (signal?.aborted) throw new ToolCancellationError();
    if (searchState.bytesRead >= SEARCH_LIMITS.maxTotalBytes) {
      searchState.truncated = true;
      searchState.stop = true;
      return;
    }

    let handle;
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.size > SEARCH_LIMITS.maxFileBytes) {
        if (metadata.size > SEARCH_LIMITS.maxFileBytes) searchState.truncated = true;
        return;
      }

      handle = await open(file, 'r');
      const current = await handle.stat();
      if (!current.isFile() || current.size > SEARCH_LIMITS.maxFileBytes) {
        if (current.size > SEARCH_LIMITS.maxFileBytes) searchState.truncated = true;
        return;
      }

      const bytesAllowed = Math.min(
        current.size,
        SEARCH_LIMITS.maxFileBytes,
        SEARCH_LIMITS.maxTotalBytes - searchState.bytesRead,
      );
      const decoder = new StringDecoder('utf8');
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, bytesAllowed || 1));
      let line = '';
      let lineNumber = 1;
      let fileBytesRead = 0;

      while (fileBytesRead < bytesAllowed &&
             searchState.matches.length < SEARCH_LIMITS.maxMatches &&
             searchState.bytesRead < SEARCH_LIMITS.maxTotalBytes) {
        if (signal?.aborted) throw new ToolCancellationError();
        const length = Math.min(
          buffer.length,
          bytesAllowed - fileBytesRead,
        );
        const {bytesRead} = await handle.read(buffer, 0, length, fileBytesRead);
        if (bytesRead === 0) break;
        fileBytesRead += bytesRead;
        searchState.bytesRead += bytesRead;

        line += decoder.write(buffer.subarray(0, bytesRead));
        const completeLines = line.split('\n');
        line = completeLines.pop() ?? '';
        for (const completeLine of completeLines) {
          if (completeLine.includes(query)) {
            const path = relative(root, file).split(sep).join('/');
            searchState.matches.push(
              `${path}:${lineNumber}:${completeLine.slice(0, MAX_TEXT)}`,
            );
          }
          lineNumber++;
          if (searchState.matches.length >= SEARCH_LIMITS.maxMatches) break;
        }
      }

      line += decoder.end();
      if (searchState.matches.length < SEARCH_LIMITS.maxMatches && line.includes(query)) {
        const path = relative(root, file).split(sep).join('/');
        searchState.matches.push(
          `${path}:${lineNumber}:${line.slice(0, MAX_TEXT)}`,
        );
      }

      if (
        searchState.matches.length >= SEARCH_LIMITS.maxMatches ||
        bytesAllowed < current.size
      ) {
        searchState.truncated = true;
        searchState.stop =
          searchState.matches.length >= SEARCH_LIMITS.maxMatches ||
          bytesAllowed < current.size;
      }
    } catch (error) {
      if (error instanceof ToolCancellationError) throw error;
      // Ignore files that disappear or become unreadable during the search.
    } finally {
      await handle?.close().catch(() => {});
    }
  }, state);

  return {matches: state.matches, truncated: state.truncated};
}

const pathProperty = {
  type: 'string',
  description: 'Path relative to the workspace root. Use . for the root.',
  minLength: 1,
};

const readFileTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the workspace.',
      parameters: {
        type: 'object',
        properties: {path: pathProperty},
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const path = requiredString(args, 'path');
    assertActive(context);
    const target = await boundedPath(context.workspaceRoot, path);
    assertActive(context);
    const content = await readFile(target, 'utf8');

    return {
      path: relative(context.workspaceRoot, target).split(sep).join('/'),
      content: content.slice(0, MAX_TEXT),
      truncated: content.length > MAX_TEXT,
    };
  },
};

const listFilesTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories at a workspace path.',
      parameters: {
        type: 'object',
        properties: {path: pathProperty},
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const path = requiredString(args, 'path');
    assertActive(context);
    const target = await boundedPath(context.workspaceRoot, path);
    assertActive(context);
    const entries = await readdir(target, {withFileTypes: true});

    return entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  },
};

const searchDirectoryTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'search_directory',
      description: 'Search UTF-8 files under a workspace directory for text.',
      parameters: {
        type: 'object',
        properties: {
          path: pathProperty,
          query: {
            type: 'string',
            description: 'Case-sensitive text to find.',
            minLength: 1,
          },
        },
        required: ['path', 'query'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const path = requiredString(args, 'path');
    const query = requiredString(args, 'query');
    assertActive(context);
    const target = await boundedPath(context.workspaceRoot, path);
    assertActive(context);
    const root = await realpath(context.workspaceRoot);
    const result = await searchFiles(root, target, query, context.signal);
    assertActive(context);

    return result;
  },
};

const writeFileTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a UTF-8 file inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: pathProperty,
          content: {type: 'string', description: 'Complete new file content.'},
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    // Validate the target before requesting approval.
    const path = requiredString(args, 'path');
    const content = requiredString(args, 'content', true);
    const target = mutationPath(context.workspaceRoot, path);
    await assertNoSymlinkPath(context.workspaceRoot, target);
    if (!(await context.approve(`write ${path}`, context.signal))) {
      return {approved: false};
    }
    assertActive(context);

    // Apply only an approved workspace mutation.
    await mkdir(dirname(target), {recursive: true});
    assertActive(context);
    await writeFile(target, content, 'utf8');
    return {approved: true, path};
  },
};

const editFileTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one exact text occurrence in a workspace file.',
      parameters: {
        type: 'object',
        properties: {
          path: pathProperty,
          old_text: {
            type: 'string',
            description: 'Exact text to replace once.',
            minLength: 1,
          },
          new_text: {type: 'string', description: 'Replacement text.'},
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    // Require one unambiguous replacement inside the workspace.
    const path = requiredString(args, 'path');
    const oldText = requiredString(args, 'old_text');
    const newText = requiredString(args, 'new_text', true);
    const target = mutationPath(context.workspaceRoot, path);
    await assertNoSymlinkPath(context.workspaceRoot, target);
    const source = await readFile(target, 'utf8');
    const count = source.split(oldText).length - 1;
    if (count !== 1) throw new Error(`old_text must occur exactly once; found ${count}.`);
    if (!(await context.approve(`edit ${path}`, context.signal))) {
      return {approved: false};
    }
    assertActive(context);
    await writeFile(target, source.replace(oldText, newText), 'utf8');
    return {approved: true, path};
  },
};

const deleteFileTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete one file inside the workspace.',
      parameters: {
        type: 'object',
        properties: {path: pathProperty},
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    // Validate the file before requesting a destructive action.
    const path = requiredString(args, 'path');
    const target = mutationPath(context.workspaceRoot, path);
    await assertNoSymlinkPath(context.workspaceRoot, target);
    if (!(await context.approve(`delete ${path}`, context.signal))) {
      return {approved: false};
    }
    assertActive(context);

    await unlink(target);
    return {approved: true, path};
  },
};

const runCommandTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command from the workspace after approval.',
      parameters: {
        type: 'object',
        properties: {
          command: {type: 'string', description: 'Exact shell command to run.'},
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const command = requiredString(args, 'command');
    if (!(await context.approve(`run shell command: ${command}`, context.signal))) {
      return {approved: false};
    }
    assertActive(context);

    // Capture bounded command output from the canonical workspace.
    const result = await executeCommand(command, {
      cwd: context.workspaceRoot,
      env: buildCommandEnvironment(),
      signal: context.signal,
    });
    return {approved: true, ...result};
  },
};

export const tools: ToolSpec[] = [
  readFileTool,
  listFilesTool,
  searchDirectoryTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  runCommandTool,
];
