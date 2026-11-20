import type {
  AssistantMessage,
  ChatCompletionResponse,
  Message,
  ToolSpec,
} from './types.ts';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const MODEL = 'openrouter/free';

export type ProviderErrorKind =
  | 'authentication'
  | 'invalid_request'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'invalid_json'
  | 'invalid_response'
  | 'empty_response'
  | 'unexpected_finish'
  | 'malformed_tool_call';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly transient = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ModelRequestOptions {
  fetchFn?: typeof fetch;
  apiKey?: string;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  maxRetries?: number;
  deadlineMs?: number;
  onRetry?: (attempt: number, delayMs: number, kind: ProviderErrorKind) => void | Promise<void>;
  onValidationFailure?: (kind: ProviderErrorKind) => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortError(signal: AbortSignal): ProviderError {
  return signal.reason === 'deadline'
    ? new ProviderError('timeout', 'The model request deadline expired.', true)
    : new ProviderError('aborted', 'The model request was cancelled.', false);
}

export function normalizeAssistantMessage(
  value: unknown,
  strictToolArguments = true,
): AssistantMessage {
  if (!isRecord(value) || value.role !== 'assistant') {
    throw new ProviderError('invalid_response', 'Provider returned an invalid assistant message.', false);
  }

  if (
    value.content !== null &&
    value.content !== undefined &&
    typeof value.content !== 'string'
  ) {
    throw new ProviderError('invalid_response', 'Provider returned an unexpected content type.', false);
  }

  const content = typeof value.content === 'string' ? value.content : null;
  let toolCalls: AssistantMessage['tool_calls'];
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls)) {
      throw new ProviderError('malformed_tool_call', 'Provider returned invalid tool calls.', false);
    }
    if (value.tool_calls.length > 64) {
      throw new ProviderError('malformed_tool_call', 'Provider returned too many tool calls.', false);
    }

    const ids = new Set<string>();
    toolCalls = [];
    for (const call of value.tool_calls) {
      if (
        !isRecord(call) ||
        typeof call.id !== 'string' ||
        call.id.length === 0 ||
        call.type !== 'function' ||
        !isRecord(call.function)
      ) {
        throw new ProviderError('malformed_tool_call', 'Provider returned a malformed tool call.', false);
      }
      if (ids.has(call.id)) {
        throw new ProviderError('malformed_tool_call', 'Provider returned duplicate tool-call IDs.', false);
      }
      ids.add(call.id);
      if (typeof call.function.name !== 'string' || call.function.name.trim().length === 0) {
        throw new ProviderError('malformed_tool_call', 'Provider returned a tool call without a name.', false);
      }
      if (typeof call.function.arguments !== 'string') {
        throw new ProviderError('malformed_tool_call', 'Provider returned malformed tool arguments.', false);
      }
      if (strictToolArguments) {
        let argumentsValue: unknown;
        try {
          argumentsValue = JSON.parse(call.function.arguments);
        } catch {
          throw new ProviderError('malformed_tool_call', 'Provider returned malformed tool arguments.', false);
        }
        if (!isRecord(argumentsValue)) {
          throw new ProviderError('malformed_tool_call', 'Provider returned non-object tool arguments.', false);
        }
      }
      toolCalls.push({
        id: call.id,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      });
    }
  }

  if ((toolCalls?.length ?? 0) === 0 && (!content || content.trim().length === 0)) {
    throw new ProviderError('empty_response', 'Provider returned empty model content.', false);
  }

  return toolCalls === undefined
    ? {role: 'assistant', content}
    : {role: 'assistant', content, tool_calls: toolCalls};
}

function parseRetryAfter(response: Response, now: () => number): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(10_000, Math.ceil(seconds * 1000));
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(10_000, Math.max(0, date - now()));
  }
  return undefined;
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

export async function callModel(
  messages: Message[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  options: ModelRequestOptions = {},
): Promise<AssistantMessage> {
  const apiKey = options.apiKey ?? (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env?.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new ProviderError(
      'authentication',
      'OPENROUTER_API_KEY is missing from .env.',
      false,
    );
  }

  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
  };

  if (tools.length > 0) {
    body.tools = tools.map(tool => tool.definition);
    body.tool_choice = 'auto';
  }

  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;
  const maxRetries = options.maxRetries ?? 2;
  const startedAt = now();
  const controllerSignal = signal ?? new AbortController().signal;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (controllerSignal.aborted) throw abortError(controllerSignal);
    if (options.deadlineMs !== undefined &&
      now() - startedAt >= options.deadlineMs) {
      throw new ProviderError('timeout', 'The model request deadline expired.', true);
    }

    let response: Response;
    try {
      response = await fetchFn(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controllerSignal,
      });
    } catch (error) {
      if (controllerSignal.aborted) throw abortError(controllerSignal);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError('timeout', 'The model request timed out.', true);
      }
      const networkError = new ProviderError(
        'network',
        'Could not connect to the model provider.',
        true,
      );
      if (attempt >= maxRetries) throw networkError;
      const delayMs = Math.min(2000, 250 * (2 ** attempt));
      if (options.deadlineMs !== undefined &&
        now() - startedAt + delayMs >= options.deadlineMs) {
        throw networkError;
      }
      await options.onRetry?.(attempt + 1, delayMs, 'network');
      await wait(delayMs, controllerSignal);
      continue;
    }

    if (!response.ok) {
      let error: ProviderError;
      if (response.status === 400) {
        error = new ProviderError('invalid_request', 'OpenRouter rejected the model request.', false, response.status);
      } else if (response.status === 401 || response.status === 403) {
        error = new ProviderError('authentication', 'OpenRouter authentication or authorization failed.', false, response.status);
      } else if (response.status === 429) {
        error = new ProviderError('rate_limit', 'OpenRouter rate-limited the model request.', true, response.status);
      } else if (response.status === 408) {
        error = new ProviderError('timeout', 'The model provider timed out the request.', true, response.status);
      } else if (response.status >= 500) {
        error = new ProviderError('server', 'The model provider returned a server error.', true, response.status);
      } else {
        error = new ProviderError('invalid_request', 'OpenRouter rejected the model request.', false, response.status);
      }

      if (!error.transient || attempt >= maxRetries) throw error;
      const exponentialDelay = Math.min(2000, 250 * (2 ** attempt));
      const delayMs = error.kind === 'rate_limit'
        ? Math.max(parseRetryAfter(response, now) ?? 0, exponentialDelay)
        : exponentialDelay;
      if (options.deadlineMs !== undefined &&
        now() - startedAt + delayMs >= options.deadlineMs) {
        throw error;
      }
      await options.onRetry?.(attempt + 1, delayMs, error.kind);
      await wait(delayMs, controllerSignal);
      continue;
    }

    let data: unknown;
    try {
      const text = await response.text();
      data = text.length === 0 ? null : JSON.parse(text);
    } catch {
      const error = new ProviderError('invalid_json', 'OpenRouter returned invalid JSON.', false);
      await options.onValidationFailure?.(error.kind);
      throw error;
    }

    if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0) {
      const error = new ProviderError('invalid_response', 'OpenRouter returned an unexpected response structure.', false);
      await options.onValidationFailure?.(error.kind);
      throw error;
    }
    const choice = data.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message)) {
      const error = new ProviderError('invalid_response', 'OpenRouter returned no valid assistant message.', false);
      await options.onValidationFailure?.(error.kind);
      throw error;
    }
    if (
      choice.finish_reason !== undefined &&
      choice.finish_reason !== null &&
      !['stop', 'length', 'tool_calls', 'content_filter', 'end_turn'].includes(String(choice.finish_reason))
    ) {
      const error = new ProviderError('unexpected_finish', 'OpenRouter returned an unexpected finish reason.', false);
      await options.onValidationFailure?.(error.kind);
      throw error;
    }

    try {
      return normalizeAssistantMessage(choice.message);
    } catch (error) {
      if (error instanceof ProviderError) {
        await options.onValidationFailure?.(error.kind);
      }
      throw error;
    }
  }

  throw new ProviderError('server', 'The model request failed after bounded retries.', true);
}
