import { LlmMessage, ToolDefinition, LlmResponse } from './types';

export interface LlmProvider {
  readonly providerName: string;
  readonly modelName: string;

  chat(
    messages: LlmMessage[],
    tools?: ToolDefinition[],
  ): Promise<LlmResponse>;
}
