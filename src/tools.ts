import {exec} from 'node:child_process';
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
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {ToolCancellationError} from './types.ts';
import type {ToolSpec} from './types.ts';

const MAX_TEXT = 12_000;

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
): Promise<{matches: string[]; truncated: boolean}> {
  const state: SearchState = {
    filesConsidered: 0,
    bytesRead: 0,
    matches: [],
    truncated: false,
    stop: false,
  };

  await walkFiles(directory, async (file, searchState) => {
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
    } catch {
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
    const target = await boundedPath(context.workspaceRoot, path);
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
    const target = await boundedPath(context.workspaceRoot, path);
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
    const target = await boundedPath(context.workspaceRoot, path);
    const result = await searchFiles(context.workspaceRoot, target, query);

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
    return await new Promise<unknown>(done => {
      exec(command, {cwd: context.workspaceRoot, encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000, env: buildCommandEnvironment()}, (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        done({approved: true, exitCode, stdout: String(stdout).slice(0, MAX_TEXT), stderr: String(stderr).slice(0, MAX_TEXT), error: error?.message ?? null});
      });
    });
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
