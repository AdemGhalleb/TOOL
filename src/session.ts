import {
  readFile as readFileDefault,
  rename as renameDefault,
  stat as statDefault,
  unlink as unlinkDefault,
  writeFile as writeFileDefault,
} from 'node:fs/promises';
import {resolve} from 'node:path';
import process from 'node:process';
import type {Message, ToolCall} from './types.ts';

const SESSION_PATH = resolve(process.cwd(), '.agent-session.json');

/** Limits for untrusted data stored in the local session file. */
export const SESSION_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxMessages: 1_000,
  maxMessageContentChars: 100_000,
  maxToolCalls: 64,
  maxToolCallIdChars: 1_000,
  maxToolNameChars: 1_000,
  maxToolArgumentsChars: 100_000,
} as const;

interface SessionFileSystem {
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{size: number}>;
  writeFile(path: string, data: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const fileSystem: SessionFileSystem = {
  readFile: path => readFileDefault(path, 'utf8'),
  stat: statDefault,
  writeFile: (path, data) => writeFileDefault(path, data, 'utf8'),
  rename: renameDefault,
  unlink: unlinkDefault,
};

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function boundedString(
  value: unknown,
  maxLength: number,
  field: string,
): value is string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`Invalid session ${field}.`);
  }
  return true;
}

function validateToolCall(value: unknown): ToolCall {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'type', 'function']) ||
    !boundedString(value.id, SESSION_LIMITS.maxToolCallIdChars, 'tool call id') ||
    value.type !== 'function' ||
    !isRecord(value.function) ||
    !hasOnlyKeys(value.function, ['name', 'arguments']) ||
    !boundedString(
      value.function.name,
      SESSION_LIMITS.maxToolNameChars,
      'tool name',
    ) ||
    !boundedString(
      value.function.arguments,
      SESSION_LIMITS.maxToolArgumentsChars,
      'tool arguments',
    )
  ) {
    throw new Error('Invalid session tool call.');
  }

  return {
    id: value.id,
    type: 'function',
    function: {
      name: value.function.name,
      arguments: value.function.arguments,
    },
  };
}

function validateMessage(value: unknown): Message {
  if (!isRecord(value) || typeof value.role !== 'string') {
    throw new Error('Invalid session message.');
  }

  if (value.role === 'system' || value.role === 'user') {
    if (
      !hasOnlyKeys(value, ['role', 'content']) ||
      !boundedString(
        value.content,
        SESSION_LIMITS.maxMessageContentChars,
        'message content',
      )
    ) {
      throw new Error('Invalid session message.');
    }
    return {role: value.role, content: value.content};
  }

  if (value.role === 'assistant') {
    if (
      !hasOnlyKeys(value, ['role', 'content', 'tool_calls']) ||
      (value.content !== null &&
        !boundedString(
          value.content,
          SESSION_LIMITS.maxMessageContentChars,
          'message content',
        ))
    ) {
      throw new Error('Invalid session assistant message.');
    }

    let toolCalls: ToolCall[] | undefined;
    if (value.tool_calls !== undefined) {
      if (
        !Array.isArray(value.tool_calls) ||
        value.tool_calls.length > SESSION_LIMITS.maxToolCalls
      ) {
        throw new Error('Invalid session tool calls.');
      }
      toolCalls = value.tool_calls.map(validateToolCall);
    }
    return toolCalls === undefined
      ? {role: 'assistant', content: value.content}
      : {role: 'assistant', content: value.content, tool_calls: toolCalls};
  }

  if (
    value.role === 'tool' &&
    hasOnlyKeys(value, ['role', 'tool_call_id', 'content']) &&
    boundedString(
      value.tool_call_id,
      SESSION_LIMITS.maxToolCallIdChars,
      'tool call id',
    ) &&
    boundedString(
      value.content,
      SESSION_LIMITS.maxMessageContentChars,
      'message content',
    )
  ) {
    return {
      role: 'tool',
      tool_call_id: value.tool_call_id,
      content: value.content,
    };
  }

  throw new Error('Invalid session message role.');
}

export function validateSessionData(value: unknown): Message[] {
  if (!Array.isArray(value) || value.length > SESSION_LIMITS.maxMessages) {
    throw new Error('Invalid session message list.');
  }
  return value.map(validateMessage);
}

function warnRecovery(path: string, reason: string): void {
  console.warn(`Could not load session history from ${path}: ${reason} Starting a fresh session.`);
}

export async function loadSession(
  path = SESSION_PATH,
  fs: SessionFileSystem = fileSystem,
): Promise<Message[]> {
  try {
    const fileInfo = await fs.stat(path);
    if (fileInfo.size > SESSION_LIMITS.maxFileBytes) {
      warnRecovery(path, 'the file exceeds the configured size limit.');
      return [];
    }

    const source = await fs.readFile(path);
    if (Buffer.byteLength(source, 'utf8') > SESSION_LIMITS.maxFileBytes) {
      warnRecovery(path, 'the file exceeds the configured size limit.');
      return [];
    }
    const parsed: unknown = JSON.parse(source);
    return validateSessionData(parsed);
  } catch (error) {
    if (isErrno(error) && error.code === 'ENOENT') {
      return [];
    }
    warnRecovery(
      path,
      error instanceof Error ? error.message : 'the file is invalid.',
    );
    return [];
  }
}

export async function saveSession(
  messages: Message[],
  path = SESSION_PATH,
  fs: SessionFileSystem = fileSystem,
): Promise<void> {
  const validatedMessages = validateSessionData(messages);
  const serialized = JSON.stringify(validatedMessages, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > SESSION_LIMITS.maxFileBytes) {
    throw new Error('Session data exceeds the configured file size limit.');
  }

  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, serialized);
    await fs.rename(temporaryPath, path);
  } catch (error) {
    try {
      await fs.unlink(temporaryPath);
    } catch (cleanupError) {
      if (!(isErrno(cleanupError) && cleanupError.code === 'ENOENT')) {
        console.warn(`Could not clean up temporary session file ${temporaryPath}.`);
      }
    }
    throw error;
  }
}
