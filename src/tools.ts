import {exec} from 'node:child_process';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import type {ToolSpec} from './types.ts';

const MAX_TEXT = 12_000;

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

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true});
  const files: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(target)));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }

  return files;
}

async function searchFiles(
  root: string,
  directory: string,
  query: string,
): Promise<string[]> {
  const matches: string[] = [];

  for (const file of await walkFiles(directory)) {
    try {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (matches.length < 50 && line.includes(query)) {
          const path = relative(root, file).split(sep).join('/');
          matches.push(`${path}:${index + 1}:${line}`);
        }
      });
    } catch {
      // Ignore unreadable or non-text files in this learning harness.
    }
  }

  return matches;
}

const pathProperty = {
  type: 'string',
  description: 'Path relative to the workspace root. Use . for the root.',
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
    const matches = await searchFiles(context.workspaceRoot, target, query);

    return {matches, truncated: matches.length === 50};
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
    if (!(await context.approve(`write ${path}`))) return {approved: false};

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
          old_text: {type: 'string', description: 'Exact text to replace once.'},
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
    if (!(await context.approve(`edit ${path}`))) return {approved: false};
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
    if (!(await context.approve(`delete ${path}`))) return {approved: false};

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
    if (!(await context.approve(`run shell command: ${command}`))) {
      return {approved: false};
    }

    // Capture bounded command output from the canonical workspace.
    return await new Promise<unknown>(done => {
      exec(command, {cwd: context.workspaceRoot, encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000}, (error, stdout, stderr) => {
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