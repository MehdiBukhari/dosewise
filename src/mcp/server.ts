import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import type { Store } from '../store/store.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

export const SERVER_INFO = { name: 'dosewise', version: '0.1.0' } as const;

/**
 * Server-level instructions. A host puts these in the model's system prompt, so
 * they are the safety rails that travel with the server itself rather than
 * living only inside one app's prompt.
 */
export const SAFETY_INSTRUCTIONS = `Dosewise is the medication record for one household. It answers questions a family caregiver asks out loud.

Rules that always apply:
1. Ground every drug-safety answer in check_drug_interaction. Never say a medication is safe from memory.
2. Quote the FDA label evidence you were given, or say you could not verify it. "I could not verify" is an acceptable answer; a guess is not.
3. Never give dosing advice, never suggest stopping or changing a prescription, and never interpret an INR or lab value.
4. Anything that changes the record needs two steps: propose_medication_change, then apply_medication_change with the caregiver's confirmation. Never apply a change the person did not explicitly confirm.
5. If the answer is "do not take it", name the prescriber or pharmacist to call, using list_prescribers.
6. Keep spoken answers under 40 words unless asked for detail. Say the time ("6 p.m.") rather than an ISO timestamp.
7. You are talking to a family member who may be frightened. Be calm, specific and never alarmist.`;

/**
 * `createMcpHandler` calls this once per HTTP request; a fresh instance serves
 * every request, so nothing session-scoped leaks between callers.
 */
export function createServerFactory(store: Store): McpServerFactory {
  return () => {
    const server = new McpServer(SERVER_INFO, {
      instructions: SAFETY_INSTRUCTIONS,
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    });

    registerTools(server, store);
    registerResources(server, store);
    registerPrompts(server, store);
    return server;
  };
}
