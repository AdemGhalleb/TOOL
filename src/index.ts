/// <reference types="node" />
import 'dotenv/config';

import {mkdir, realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import process from 'node:process';
import {runAgent} from './agent.ts';
import {runTui} from './tui/index.tsx';
import type {AgentHooks, Message} from './types.ts';
import {tools} from './tools.ts';
async function main(): Promise<void> {
  // Keep one canonical workspace and conversation trace outside the TUI.
  const configuredRoot = resolve(process.cwd(), 'workspace');
  await mkdir(configuredRoot, {recursive: true});
  const workspaceRoot = await realpath(configuredRoot);
  let messages: Message[] = [];

  async function respond(message: string, hooks?: AgentHooks): Promise<string> {
    // Use UI hooks when available. Defaults keep the TUI compatible.
    const activeHooks: AgentHooks = hooks ?? {
      emit() {},
      approve: () => Promise.resolve(false),
    };
    const result = await runAgent(
      message,
      {...activeHooks, workspaceRoot},
      messages,
      tools,
    );
    // Preserve the returned trace for the next submission.
    messages = result.messages;
    return result.answer;
  }

  runTui(respond);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});