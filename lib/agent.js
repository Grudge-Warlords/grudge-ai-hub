import { requireUser } from './auth.js';

const AGENT_TOOLS = [
  { id: 'read_file', description: 'Read a file from the active project' },
  { id: 'write_file', description: 'Write a file to the active project (requires approval when destructive)' },
  { id: 'list_files', description: 'List project files' },
  { id: 'search_assets', description: 'Search Grudge ObjectStore assets' },
  { id: 'run_dev_review', description: 'Escalate to VPS dev review endpoint' },
];

export async function handleAgentRun(request, env, auth, requestId) {
  const userErr = requireUser(auth);
  if (userErr) return json(userErr, 401);

  const body = await request.json().catch(() => ({}));
  const task = String(body.task || body.message || '').trim();
  if (!task) return json({ error: 'task is required' }, 400);

  const runId = crypto.randomUUID().replace(/-/g, '');
  const role = String(body.role || 'dev').slice(0, 32);
  const maxSteps = Math.min(12, Math.max(1, parseInt(body.maxSteps || '6', 10)));
  const projectId = body.projectId || null;

  const steps = [
    { step: 1, action: 'plan', detail: `Analyze task: ${task.slice(0, 200)}` },
    { step: 2, action: 'tool', tool: 'list_files', detail: projectId ? 'Load project context' : 'No project — workspace mode' },
  ];

  let assistantText = `GRUDA Agent plan for: ${task}\n\n`;
  assistantText += `1. Inspect project files and Grudge fleet context\n`;
  assistantText += `2. Propose changes (no cross-user access — project visibility enforced)\n`;
  assistantText += `3. Run dev review via Legion when code is involved\n`;
  assistantText += `\nTools available: ${AGENT_TOOLS.map((t) => t.id).join(', ')}`;

  if (projectId) {
    const project = await env.DB.prepare(
      `SELECT p.* FROM projects p
       LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
       WHERE p.id = ? AND (p.owner_id = ? OR m.user_id IS NOT NULL)`,
    ).bind(auth.userId, projectId, auth.userId).first();
    if (project) {
      steps.push({ step: 3, action: 'context', detail: `Project: ${project.name} (${project.visibility})` });
      assistantText += `\n\nActive project: **${project.name}** — visibility \`${project.visibility}\`.`;
    }
  }

  steps.push({ step: steps.length + 1, action: 'respond', detail: 'Return plan to client for approval loop' });

  await env.DB.prepare(
    `INSERT INTO agent_runs (id, project_id, user_id, task, role, status, steps_json, result, finished_at)
     VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, datetime('now'))`,
  ).bind(runId, projectId, auth.userId, task, role, JSON.stringify(steps), assistantText).run();

  return json({
    ok: true,
    runId,
    requestId,
    status: 'completed',
    role,
    maxSteps,
    tools: AGENT_TOOLS,
    steps,
    response: assistantText,
    message: 'Agentic loop v1 — plan + tool registry. Wire tool execution in agent loop v2.',
  });
}

export async function handleAgentRunGet(env, auth, runId) {
  const userErr = requireUser(auth);
  if (userErr) return json(userErr, 401);

  const row = await env.DB.prepare(
    'SELECT * FROM agent_runs WHERE id = ? AND user_id = ?',
  ).bind(runId, auth.userId).first();
  if (!row) return json({ error: 'Run not found' }, 404);

  return json({
    ok: true,
    run: {
      ...row,
      steps: JSON.parse(row.steps_json || '[]'),
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}