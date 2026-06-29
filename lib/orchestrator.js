import { requireUser } from './auth.js';

const WORKERS = [
  { id: 'legion', label: 'Legion AI', caps: ['chat', 'review', 'plan'] },
  { id: 'terminal', label: 'Terminal', caps: ['shell', 'git', 'wrangler'] },
  { id: 'npm', label: 'npm / pnpm', caps: ['install', 'build', 'test', 'dev'] },
  { id: 'node', label: 'Node runtime', caps: ['script', 'server'] },
  { id: 'vscode', label: 'VS Code / Cursor', caps: ['open', 'edit'] },
  { id: 'webgl', label: 'WebGL / Forge 3D', caps: ['preview', 'glb', 'scene'] },
  { id: 'coder', label: 'GrudgeChain Coder IDE', caps: ['ide', 'monaco', 'preview'] },
  { id: 'forge', label: 'Forge deploy', caps: ['upload', 'ingest', 'r2'] },
  { id: 'pod', label: 'Dev pod', caps: ['spawn', 'status'] },
];

function classifyTask(task) {
  const t = task.toLowerCase();
  const hits = new Set();
  if (/npm|install|build|test|package\.json|pnpm/.test(t)) hits.add('npm');
  if (/terminal|shell|git |wrangler|command/.test(t)) hits.add('terminal');
  if (/node |\.js|\.ts|server|express/.test(t)) hits.add('node');
  if (/vscode|cursor|editor|open project/.test(t)) hits.add('vscode');
  if (/webgl|three|glb|gltf|forge|3d|mesh/.test(t)) hits.add('webgl');
  if (/coder|ide|monaco/.test(t)) hits.add('coder');
  if (/deploy|upload|r2|ingest|fleet/.test(t)) hits.add('forge');
  if (/pod|container|sandbox|dev env/.test(t)) hits.add('pod');
  if (hits.size === 0 || /review|explain|fix|agent|ai/.test(t)) hits.add('legion');
  return [...hits];
}

function buildPlan(task, workers, project) {
  const steps = [];
  let n = 1;
  if (workers.includes('npm') && /install/.test(task.toLowerCase())) {
    steps.push({ step: n++, worker: 'npm', action: 'install', detail: 'npm install in project root', command: 'npm install', auto: true });
  }
  if (workers.includes('npm') && /build/.test(task.toLowerCase())) {
    steps.push({ step: n++, worker: 'npm', action: 'build', detail: 'npm run build', command: 'npm run build', auto: true });
  }
  if (workers.includes('npm') && /dev|start/.test(task.toLowerCase())) {
    steps.push({ step: n++, worker: 'npm', action: 'dev', detail: 'npm run dev', command: 'npm run dev', auto: false });
  }
  if (workers.includes('terminal')) {
    steps.push({ step: n++, worker: 'terminal', action: 'exec', detail: 'Run allow-listed shell commands locally', auto: false });
  }
  if (workers.includes('vscode')) {
    steps.push({ step: n++, worker: 'vscode', action: 'open', detail: `Open ${project?.name ?? 'workspace'} in VS Code/Cursor`, auto: true });
  }
  if (workers.includes('webgl')) {
    steps.push({ step: n++, worker: 'webgl', action: 'open_forge', detail: 'Launch Forge 3D WebGL viewport', auto: true });
  }
  if (workers.includes('coder')) {
    steps.push({ step: n++, worker: 'coder', action: 'launch', detail: 'Start GrudgeChain Coder on localhost', auto: false });
  }
  if (workers.includes('node')) {
    steps.push({ step: n++, worker: 'node', action: 'run', detail: 'Execute Node script in workspace', auto: false });
  }
  if (workers.includes('forge')) {
    steps.push({ step: n++, worker: 'forge', action: 'deploy', detail: 'Export GLB → ingest → fleet R2', auto: false });
  }
  if (workers.includes('pod')) {
    steps.push({ step: n++, worker: 'pod', action: 'status', detail: 'List local dev pods (Coder, Ollama, Forge)', auto: true });
  }
  steps.push({
    step: n++,
    worker: 'legion',
    action: 'dev_review',
    detail: 'Legion reviews plan output and suggests fixes',
    auto: true,
  });
  return steps;
}

export async function handleOrchestratorRun(request, env, auth, requestId) {
  const userErr = requireUser(auth);
  if (userErr) return json(userErr, 401);

  const body = await request.json().catch(() => ({}));
  const task = String(body.task || body.goal || '').trim();
  if (!task) return json({ error: 'task is required' }, 400);

  const projectId = body.projectId || null;
  let project = null;
  if (projectId) {
    project = await env.DB.prepare(
      `SELECT p.* FROM projects p
       LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
       WHERE p.id = ? AND (p.owner_id = ? OR m.user_id IS NOT NULL)`,
    ).bind(auth.userId, projectId, auth.userId).first();
  }

  const workers = classifyTask(task);
  const plan = buildPlan(task, workers, project);
  const runId = crypto.randomUUID().replace(/-/g, '');

  const summary = [
    `GRUDA Orchestrator — ${workers.length} worker(s): ${workers.join(', ')}`,
    project ? `Project: ${project.name} (${project.visibility})` : 'Workspace mode (no project)',
    '',
    ...plan.map((s) => `${s.step}. [${s.worker}] ${s.action} — ${s.detail}`),
  ].join('\n');

  await env.DB.prepare(
    `INSERT INTO agent_runs (id, project_id, user_id, task, role, status, steps_json, result, finished_at)
     VALUES (?, ?, ?, ?, 'orchestrator', 'planned', ?, ?, datetime('now'))`,
  ).bind(runId, projectId, auth.userId, task, JSON.stringify(plan), summary).run();

  return json({
    ok: true,
    runId,
    requestId,
    status: 'planned',
    workers: WORKERS.filter((w) => workers.includes(w.id)),
    plan,
    summary,
    executeLocally: plan.filter((s) => s.auto),
    message: 'Execute auto steps via Forge Dev Portal; confirm manual steps in UI.',
  });
}

export async function handlePodsRouter(request, env, auth, url, method) {
  const userErr = requireUser(auth);
  if (userErr) return json(userErr, 401);

  if (url.pathname === '/v1/pods' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT * FROM dev_pods WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50',
    ).bind(auth.userId).all();
    return json({ ok: true, pods: rows.results || [] });
  }

  if (url.pathname === '/v1/pods' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = crypto.randomUUID().replace(/-/g, '');
    const kind = String(body.kind || 'node').slice(0, 32);
    await env.DB.prepare(
      `INSERT INTO dev_pods (id, user_id, project_id, name, kind, url, status, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, 'stopped', ?)`,
    ).bind(
      id,
      auth.userId,
      body.projectId || null,
      String(body.name || 'Dev Pod').slice(0, 80),
      kind,
      body.url || null,
      JSON.stringify(body.meta || {}),
    ).run();
    const pod = await env.DB.prepare('SELECT * FROM dev_pods WHERE id = ?').bind(id).first();
    return json({ ok: true, pod }, 201);
  }

  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}