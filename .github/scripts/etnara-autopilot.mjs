import fs from "node:fs";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const {
  GH_TOKEN,
  ISSUE_NUMBER,
  ISSUE_TITLE,
  ISSUE_BODY,
  REPOSITORY,
} = process.env;

function read(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
}

const projectContext = `
AGENTS.md:
${read("AGENTS.md")}

AGENT_STATE:
${read("docs/AGENT_STATE.md")}

ETNARA_BACKLOG:
${read("docs/ETNARA_BACKLOG.md")}

PRODUCT_RULES:
${read("docs/PRODUCT_RULES.md")}

MANAGER_AGENT_PROMPT:
${read("docs/MANAGER_AGENT_PROMPT.md")}
`;

const response = await openai.responses.create({
  model: "gpt-5.6-terra",
  reasoning: { effort: "medium" },
  input: `
You are the ETNARA Manager Agent.

This is SAFE DIAGNOSTIC MODE.
Do not modify files.
Do not propose destructive database actions.
Do not reveal secrets.

Repository:
${REPOSITORY}

GitHub Issue #${ISSUE_NUMBER}
Title:
${ISSUE_TITLE}

Body:
${ISSUE_BODY}

Repository instructions and persistent project state:

${projectContext}

Analyze this issue against the repository rules.

Return a concise report containing:

1. Selected task
2. Current diagnosis
3. What appears already completed
4. What still needs verification/work
5. Files likely involved
6. Security/RLS considerations
7. Acceptance criteria
8. Recommended next action

Do not claim that code was inspected unless the supplied repository context actually proves it.
This stage performs diagnosis only.
`,
});

const report = response.output_text;

const [owner, repo] = REPOSITORY.split("/");

const result = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/issues/${ISSUE_NUMBER}/comments`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      body: `## 🤖 ETNARA Autopilot — Diagnostic Report\n\n${report}\n\n---\n*Automatic diagnostic mode. No code was modified.*`,
    }),
  }
);

if (!result.ok) {
  const error = await result.text();
  throw new Error(`GitHub comment failed: ${result.status} ${error}`);
}

console.log(`ETNARA Autopilot analyzed Issue #${ISSUE_NUMBER}.`);
