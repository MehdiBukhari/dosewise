import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export interface AgentStep {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  text: string;
  structured?: unknown;
}

export interface AgentResult {
  reply: string;
  steps: AgentStep[];
  provider: 'bedrock' | 'scripted';
  pendingConfirmation?: { token: string; summary: string };
}

export interface ToolCallResult {
  ok: boolean;
  text: string;
  structured?: unknown;
}

/**
 * One short-lived MCP session per chat turn, authenticated with the same bearer
 * token the browser sent. The agent has no special access: it is just another
 * MCP client talking to the same Streamable HTTP endpoint a host would.
 */
export async function withMcpClient<T>(
  options: { url: string; token: string },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: 'dosewise-alexa-simulator', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` } },
  });

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  };

  const text = (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');

  return {
    ok: !result.isError,
    text,
    ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
  };
}
