import { LlmMessage, ToolDefinition, LlmResponse } from './types';

export interface LlmChatOptions {
  /** Cancels the in-flight request (and any pending retry back-off). */
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly providerName: string;
  readonly modelName: string;

  chat(
    messages: LlmMessage[],
    tools?: ToolDefinition[],
    options?: LlmChatOptions,
  ): Promise<LlmResponse>;
}
