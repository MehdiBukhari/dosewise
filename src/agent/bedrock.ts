import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import type { Client } from '@modelcontextprotocol/client';
import { config } from '../config.js';
import { SAFETY_INSTRUCTIONS } from '../mcp/server.js';
import { callTool, type AgentResult, type AgentStep } from './mcp.js';

const MAX_TURNS = 6;

function systemPrompt(patientName: string): string {
  return [
    SAFETY_INSTRUCTIONS,
    '',
    `You are speaking as an Alexa+ experience for ${patientName}'s family. Voice first: short sentences, no markdown, no lists read aloud.`,
    'When a tool returns label evidence, say what the label says in plain words and name the source once ("the warfarin label").',
    'If the person asks about a drug, call check_drug_interaction before answering — even if you are confident.',
    'If a change to the record is needed, call propose_medication_change and then ask for a spoken yes. Only call apply_medication_change after they say yes.',
  ].join('\n');
}

function toTools(tools: Awaited<ReturnType<Client['listTools']>>['tools']): Tool[] {
  return tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: { json: (tool.inputSchema ?? { type: 'object', properties: {} }) as never },
    },
  }));
}

/**
 * A minimal Bedrock Converse agent loop over MCP tools. Deliberately not a
 * framework: judges (and reviewers) can read the whole control flow.
 */
export async function runBedrockAgent(options: {
  client: Client;
  message: string;
  transcript: string;
  patientName: string;
}): Promise<AgentResult> {
  const runtime = new BedrockRuntimeClient({ region: config.bedrock.region });
  const { tools } = await options.client.listTools();
  const toolConfig = { tools: toTools(tools) };
  const steps: AgentStep[] = [];

  const prompt = options.transcript
    ? `Conversation so far:\n${options.transcript}\n\nNow the caregiver says: ${options.message}`
    : options.message;

  const messages: Message[] = [{ role: 'user', content: [{ text: prompt }] }];

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await runtime.send(
      new ConverseCommand({
        modelId: config.bedrock.modelId,
        system: [{ text: systemPrompt(options.patientName) }],
        messages,
        toolConfig,
        inferenceConfig: { maxTokens: 700, temperature: 0.2 },
      }),
    );

    const message = response.output?.message;
    if (!message) throw new Error('Bedrock returned no message.');
    messages.push(message);

    const toolUses = (message.content ?? []).filter((block): block is ContentBlock.ToolUseMember => 'toolUse' in block && !!block.toolUse);

    if (response.stopReason !== 'tool_use' || toolUses.length === 0) {
      const reply = (message.content ?? [])
        .map((block) => ('text' in block ? block.text ?? '' : ''))
        .join(' ')
        .trim();
      return { reply: reply || 'I did not get an answer back. Try asking again.', steps, provider: 'bedrock' };
    }

    const results: ContentBlock[] = [];
    for (const use of toolUses) {
      const name = use.toolUse!.name ?? 'unknown';
      const args = (use.toolUse!.input ?? {}) as Record<string, unknown>;
      try {
        const outcome = await callTool(options.client, name, args);
        steps.push({ tool: name, args, ok: outcome.ok, text: outcome.text, ...(outcome.structured !== undefined ? { structured: outcome.structured } : {}) });
        results.push({
          toolResult: {
            toolUseId: use.toolUse!.toolUseId,
            status: outcome.ok ? 'success' : 'error',
            content: outcome.structured !== undefined ? [{ json: outcome.structured as never }] : [{ text: outcome.text }],
          },
        });
      } catch (error) {
        const text = `Tool failed: ${(error as Error).message}`;
        steps.push({ tool: name, args, ok: false, text });
        results.push({ toolResult: { toolUseId: use.toolUse!.toolUseId, status: 'error', content: [{ text }] } });
      }
    }

    messages.push({ role: 'user', content: results });
  }

  return { reply: 'That took more steps than I expected. Let me hand this to the care team instead.', steps, provider: 'bedrock' };
}
