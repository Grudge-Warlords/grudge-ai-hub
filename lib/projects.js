import { requireUser } from './auth.js';

function slugify(name) {
  return String(name || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project';
}

async function canAccessProject(env, projectId, userId) {
  const row = await env.DB.prepare(
    `SELECT p.* FROM projects p
     LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
     WHERE p.id = ? AND (p.owner_id = ? OR m.user_id IS NOT NULL OR p.visibility = 'public')`,
  ).bind(userId, projectId, userId).first();
  return row;
}

export async function handleProjectsRouter(request, env, auth, url, method) {
  const userErr = requireUser(auth);
  if (userErr) return json(userErr, 401);

  const base = '/v1/projects';

  if (url.pathname === base && method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT p.* FROM projects p
       LEFT JOIN project_members m ON m.project_id = p.id
       WHERE p.owner_id = ? OR m.user_id = ?
       ORDER BY p.updated_at DESC LIMIT 100`,
    ).bind(auth.userId, auth.userId).all();
    return json({ ok: true, projects: rows.results || [] });
  }

  if (url.pathname === base && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || 'Untitled').trim().slice(0, 80);
    const slug = slugify(body.slug || name);
    const visibility = ['private', 'team', 'public'].includes(body.visibility) ? body.visibility : 'private';
    const id = crypto.randomUUID().replace(/-/g, '');
    const storagePath = `GRUDA/projects/${auth.grudgeId || auth.userId}/${slug}/`;

    try {
      await env.DB.prepare(
        `INSERT INTO projects (id, owner_id, owner_grudge_id, name, slug, visibility, description, template, storage_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        auth.userId,
        auth.grudgeId || null,
        name,
        slug,
        visibility,
        body.description || null,
        body.template || 'blank',
        storagePath,
      ).run();
    } catch (e) {
      if (String(e?.message || '').includes('UNIQUE')) {
        return json({ error: 'Project slug already exists for your account' }, 409);
      }
      throw e;
    }

    const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();
    return json({ ok: true, project }, 201);
  }

  const match = url.pathname.match(/^\/v1\/projects\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  const projectId = match[1];
  const sub = match[2] || '';

  if (sub === '/share' && method === 'POST') {
    const project = await canAccessProject(env, projectId, auth.userId);
    if (!project) return json({ error: 'Project not found' }, 404);
    if (project.owner_id !== auth.userId) return json({ error: 'Only owner can invite members' }, 403);

    const body = await request.json().catch(() => ({}));
    const memberId = String(body.userId || '').trim();
    const memberRole = ['viewer', 'editor'].includes(body.role) ? body.role : 'viewer';
    if (!memberId) return json({ error: 'userId required' }, 400);

    await env.DB.prepare(
      `INSERT INTO project_members (project_id, user_id, role, invited_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
    ).bind(projectId, memberId, memberRole, auth.userId).run();

    return json({ ok: true, shared: { userId: memberId, role: memberRole } });
  }

  if (sub === '' && method === 'GET') {
    const project = await canAccessProject(env, projectId, auth.userId);
    if (!project) return json({ error: 'Project not found' }, 404);
    const members = await env.DB.prepare(
      'SELECT user_id, role, created_at FROM project_members WHERE project_id = ?',
    ).bind(projectId).all();
    return json({ ok: true, project, members: members.results || [] });
  }

  if (sub === '' && method === 'PATCH') {
    const project = await canAccessProject(env, projectId, auth.userId);
    if (!project) return json({ error: 'Project not found' }, 404);
    if (project.owner_id !== auth.userId) return json({ error: 'Only owner can change settings' }, 403);

    const body = await request.json().catch(() => ({}));
    const visibility = body.visibility && ['private', 'team', 'public'].includes(body.visibility)
      ? body.visibility
      : project.visibility;

    await env.DB.prepare(
      `UPDATE projects SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         visibility = ?,
         github_repo = COALESCE(?, github_repo),
         updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(
      body.name || null,
      body.description ?? null,
      visibility,
      body.githubRepo || null,
      projectId,
    ).run();

    const updated = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
    return json({ ok: true, project: updated });
  }

  if (sub === '' && method === 'DELETE') {
    const project = await canAccessProject(env, projectId, auth.userId);
    if (!project) return json({ error: 'Project not found' }, 404);
    if (project.owner_id !== auth.userId) return json({ error: 'Only owner can delete' }, 403);
    await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run();
    return json({ ok: true, deleted: projectId });
  }

  if (sub === '/files' && method === 'GET') {
    const project = await canAccessProject(env, projectId, auth.userId);
    if (!project) return json({ error: 'Project not found' }, 404);
    const files = await env.DB.prepare(
      'SELECT id, path, content_hash, updated_at FROM project_files WHERE project_id = ? ORDER BY path',
    ).bind(projectId).all();
    return json({ ok: true, files: files.results || [] });
  }

  const fileMatch = sub.match(/^\/files\/(.+)$/);
  if (fileMatch && method === 'PUT') {
    const project = await canAccessProject(env, projectId, auth.userId);
    if (!project) return json({ error: 'Project not found' }, 404);
    if (project.owner_id !== auth.userId) {
      const mem = await env.DB.prepare(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
      ).bind(projectId, auth.userId).first();
      if (!mem || mem.role !== 'editor') return json({ error: 'Editor access required' }, 403);
    }

    const path = decodeURIComponent(fileMatch[1]);
    const body = await request.json().catch(() => ({}));
    const content = String(body.content ?? '');

    await env.DB.prepare(
      `INSERT INTO project_files (project_id, path, content, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`,
    ).bind(projectId, path, content).run();

    return json({ ok: true, path });
  }

  return json({ error: 'Not found' }, 404);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}