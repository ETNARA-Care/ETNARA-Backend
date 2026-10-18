/** Phase 13 pilot: explicitly invoked AI analysis, never autonomous execution. */
export const TOWER_AI_PILOT_AGENTS = ['technology-2', 'technology-3', 'technology-4'] as const;
export type TowerAiAgentId = typeof TOWER_AI_PILOT_AGENTS[number];
export function parseTowerAiRequest(value: unknown): { agentId: TowerAiAgentId; question: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['agentId','question'].includes(k)) ||
    typeof v.agentId !== 'string' || !TOWER_AI_PILOT_AGENTS.some(a => a === v.agentId) ||
    typeof v.question !== 'string') return null;
  const question = v.question.trim();
  if (question.length < 8 || question.length > 1500) return null;
  return { agentId: v.agentId as TowerAiAgentId, question };
}
const roles: Record<TowerAiAgentId, string> = {
  'technology-2': 'LEO, software engineer. Provide cautious technical analysis and suggested verification steps.',
  'technology-3': 'ORION, systems engineer. Provide cautious architecture and operations analysis.',
  'technology-4': 'AXEL, site reliability engineer. Provide cautious reliability and incident triage analysis.',
};
export async function runTowerAiPilot(input: {agentId: TowerAiAgentId; question: string}): Promise<{answer:string;model:string}|null> {
  const key = process.env.TOWER_AI_API_KEY;
  const model = process.env.TOWER_AI_MODEL;
  if (process.env.TOWER_AI_ENABLED !== 'true' || !key || !model || !/^[a-zA-Z0-9._-]{3,100}$/.test(model)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: controller.signal,
      headers: {'Authorization': `Bearer ${key}`, 'Content-Type':'application/json'},
      body: JSON.stringify({
        model, store: false, max_output_tokens: 450,
        instructions: `You are ${roles[input.agentId]} You are advising an authorized platform administrator. You have NO access to live systems, credentials, files or patient data. Do not claim to have executed commands, monitored systems, inspected repositories, or verified facts. Never request secrets or personal health information. Provide proposals only; human approval is required for all actions.`,
        input: input.question,
      }),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object') return null;
    const result = data as {output?: Array<{type?:string;content?:Array<{type?:string;text?:string}>}>};
    const answer = (result.output ?? []).flatMap(item => item.content ?? []).filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text!).join('\n').slice(0,5000).trim();
    return answer ? {answer,model} : null;
  } finally { clearTimeout(timeout); }
}
