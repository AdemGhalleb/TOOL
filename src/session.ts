import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import process from 'node:process';
import type {Message} from './types.ts';

const SESSION_PATH = resolve(process.cwd(), '.agent-session.json');

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export async function loadSession(): Promise<Message[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(SESSION_PATH, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch (error) {
    if (isErrno(error) && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

export async function saveSession(messages: Message[]): Promise<void> {
  await writeFile(SESSION_PATH, JSON.stringify(messages, null, 2), 'utf8');
}