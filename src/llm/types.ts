export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  callId: string;
  name: string;
  output: string;
  isError?: boolean;
}

export interface LlmMessage {
  role: LlmRole;
  content?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: {
    type: string;
    description?: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterProperty>;
    required?: string[];
  };
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: LlmUsage;
  finishReason?: string;
}

export interface LlmProviderOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}
