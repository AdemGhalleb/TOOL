import type {Message} from './types.ts';

/** Conservative fallback budget for model input plus the reserved response. */
export const DEFAULT_CONTEXT_BUDGET = {
  maxContextTokens: 8_192,
  reservedOutputTokens: 1_024,
} as const;

const ESTIMATED_CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;

export interface ContextBudget {
  maxContextTokens?: number;
  maxInputTokens?: number;
  reservedOutputTokens?: number;
}

export class ContextBudgetError extends Error {
  constructor(message = 'The conversation cannot fit within the configured context budget.') {
    super(message);
    this.name = 'ContextBudgetError';
  }
}

interface ConversationGroup {
  messages: Message[];
  estimatedTokens: number;
}

function estimateMessageTokens(message: Message): number {
  const contentLength = typeof message.content === 'string'
    ? message.content.length
    : 0;
  const toolCallLength = message.role === 'assistant'
    ? (message.tool_calls ?? []).reduce(
        (total, call) =>
          total +
          call.id.length +
          call.function.name.length +
          call.function.arguments.length,
        0,
      )
    : message.role === 'tool'
      ? message.tool_call_id.length
      : 0;

  return MESSAGE_OVERHEAD_TOKENS +
    Math.ceil((contentLength + toolCallLength) / ESTIMATED_CHARS_PER_TOKEN);
}

function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
}

function hasToolCalls(message: Message): message is Extract<Message, {role: 'assistant'}> {
  return message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0;
}

function validateToolExchange(messages: Message[]): boolean {
  const pending = new Map<string, number>();
  let sawToolResult = false;

  for (const message of messages) {
    if (hasToolCalls(message)) {
      for (const call of message.tool_calls ?? []) {
        pending.set(call.id, (pending.get(call.id) ?? 0) + 1);
      }
      continue;
    }
    if (message.role !== 'tool') continue;

    sawToolResult = true;
    const remaining = pending.get(message.tool_call_id) ?? 0;
    if (remaining === 0) return false;
    if (remaining === 1) pending.delete(message.tool_call_id);
    else pending.set(message.tool_call_id, remaining - 1);
  }

  return !sawToolResult && pending.size === 0 ||
    sawToolResult && pending.size === 0;
}

function groupConversation(messages: Message[]): ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  let current: Message[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    if (!validateToolExchange(current)) {
      throw new ContextBudgetError(
        'The conversation contains an incomplete or orphaned tool-call exchange.',
      );
    }
    groups.push({
      messages: current,
      estimatedTokens: estimateMessagesTokens(current),
    });
    current = [];
  };

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user' && current.length > 0) flush();
    current.push(message);
  }
  flush();
  return groups;
}

function getBudget(budget: ContextBudget = {}): number {
  const maxInputTokens = budget.maxInputTokens;
  const maxContextTokens =
    budget.maxContextTokens ?? DEFAULT_CONTEXT_BUDGET.maxContextTokens;
  const reservedOutputTokens =
    budget.reservedOutputTokens ?? DEFAULT_CONTEXT_BUDGET.reservedOutputTokens;
  if (
    (maxInputTokens !== undefined &&
      (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0)) ||
    !Number.isSafeInteger(maxContextTokens) ||
    maxContextTokens <= 0 ||
    !Number.isSafeInteger(reservedOutputTokens) ||
    reservedOutputTokens < 0
  ) {
    throw new ContextBudgetError('Context budget values must be positive safe integers.');
  }
  if (maxInputTokens !== undefined) return maxInputTokens;
  if (reservedOutputTokens >= maxContextTokens) {
    throw new ContextBudgetError(
      'Reserved output space must be smaller than the total context budget.',
    );
  }
  return maxContextTokens - reservedOutputTokens;
}

/**
 * Selects recent complete exchanges without mutating the persisted/run history.
 * Token counts are conservative estimates until a provider tokenizer is added.
 */
export function prepareContext(
  messages: Message[],
  budget: ContextBudget = {},
): Message[] {
  const maxInputTokens = getBudget(budget);
  const systemMessages = messages.filter(message => message.role === 'system');
  const groups = groupConversation(messages);
  const latestGroup = groups.at(-1);
  if (!latestGroup) {
    const systemTokens = estimateMessagesTokens(systemMessages);
    if (systemTokens > maxInputTokens) {
      throw new ContextBudgetError('System instructions exceed the configured context budget.');
    }
    return [...systemMessages];
  }

  const selected = [latestGroup];
  let usedTokens =
    estimateMessagesTokens(systemMessages) + latestGroup.estimatedTokens;
  if (usedTokens > maxInputTokens) {
    throw new ContextBudgetError(
      'The latest user request and system instructions exceed the configured context budget.',
    );
  }

  for (let index = groups.length - 2; index >= 0; index -= 1) {
    const group = groups[index];
    if (usedTokens + group.estimatedTokens > maxInputTokens) continue;
    selected.unshift(group);
    usedTokens += group.estimatedTokens;
  }

  return [
    ...systemMessages,
    ...selected.flatMap(group => group.messages),
  ];
}
