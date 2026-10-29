import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { skillWrite } from '../src/skill-writer.ts';
const md = '---\nname: demo\ndescription: Demo\n---\nRead [guide](references/guide.md).\n';
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const before = 'a'.repeat(40), after = 'b'.repeat(40), uri = 'skill://skillar/iyen/demo/SKILL.md';
function fixture({ existing = false, conflict = false, lost = false } = {}) {
  let head = before;
  const calls = [];
  const env = { SKILLAR_GITHUB_TOKEN: 'fixture', SKILLS_BUCKET: { get: async () => null } };
  const git = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path === '/git/ref/heads/main') return { object: { sha: head } };
    if (path === `/git/commits/${before}`) return { tree: { sha: 'tree-old' } };
    if (path === '/git/trees/tree-old?recursive=1') return { tree: existing ? [{ path: 'skills/demo/SKILL.md', type: 'blob', mode: '100644', sha: 'blob' }, { path: 'skills/demo/references/guide.md', type: 'blob', mode: '100644', sha: 'guide' }] : [] };
    if (path === '/git/blobs/blob') return { encoding: 'base64', content: Buffer.from(md).toString('base64') };
    if (path === '/git/trees') return { sha: 'tree-new' };
    if (path === '/git/commits') return { sha: after };
    if (path === '/git/refs/heads/main') {
      assert.equal(body.force, false);
      if (conflict) { head = 'c'.repeat(40); throw new Error('concurrent'); }
      head = body.sha;
      if (lost) throw new Error('response lost');
      return {};
    }
    if (path.startsWith('/actions/')) return { workflow_runs: [{ status: 'completed', conclusion: 'failure', html_url: 'https://github.com/example/run' }] };
    throw new Error(`Unexpected Git request ${path}`);
  };
  return { env, git, calls };
}
test('create commits body and supporting files together on main without claiming publication', async () => {
  const f = fixture();
  const result = await skillWrite(f.env, 'create_skill', { name: 'demo', markdown: md, files: { 'references/guide.md': 'Guide' } }, f.git);
  assert.equal(result.status, 'accepted'); assert.equal(result.commit, after); assert.equal(result.files, 2);
  const tree = f.calls.find(c => c.path === '/git/trees').body;
  assert.equal(tree.base_tree, 'tree-old'); assert.deepEqual(tree.tree.map(f => f.path), ['skills/demo/SKILL.md', 'skills/demo/references/guide.md']);
  assert.deepEqual(f.calls.find(c => c.path === '/git/commits').body.parents, [before]);
});
test('rejects traversal, invalid frontmatter, missing supporting files and duplicate creation before any mutation', async () => {
  for (const args of [
    { name: '../demo', markdown: md }, { name: 'different', markdown: md },
    { name: 'demo', markdown: md, files: { 'references/../../workflow.yml': 'bad' } },
    { name: 'demo', markdown: md },
  ]) {
    const f = fixture(); await assert.rejects(skillWrite(f.env, 'create_skill', args, f.git));
    assert.ok(f.calls.every(c => c.method === 'GET'));
  }
  const f = fixture({ existing: true });
  await assert.rejects(skillWrite(f.env, 'create_skill', { name: 'demo', markdown: md }, f.git), /already exists/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('updates use loaded SHA256, preserve support files and reject stale edits without writing', async () => {
  const f = fixture({ existing: true });
  await assert.rejects(skillWrite(f.env, 'update_skill', { uri, markdown: md + 'Changed', expected_digest: hash('stale') }, f.git), /changed since load/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
  const result = await skillWrite(f.env, 'update_skill', { uri, markdown: md + 'Changed', expected_digest: hash(md) }, f.git);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(f.calls.find(c => c.path === '/git/trees').body.tree.map(e => e.path), ['skills/demo/SKILL.md']);
});
test('a lost write response is reconciled once; a competing ref is never overwritten or retried', async () => {
  const args = { name: 'demo', markdown: md, files: { 'references/guide.md': 'Guide' } };
  const lost = fixture({ lost: true });
  assert.equal((await skillWrite(lost.env, 'create_skill', args, lost.git)).status, 'accepted');
  const conflict = fixture({ conflict: true });
  await assert.rejects(skillWrite(conflict.env, 'create_skill', args, conflict.git), /Write not confirmed/);
  assert.equal(conflict.calls.filter(c => c.path === '/git/refs/heads/main').length, 1);
});
test('unchanged Git and failed publication are never reported as live', async () => {
  const f = fixture({ existing: true });
  assert.equal((await skillWrite(f.env, 'update_skill', { uri, markdown: md, expected_digest: hash(md) }, f.git)).status, 'unchanged');
  assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.equal((await skillWrite(f.env, 'get_skill_write_status', { commit: after }, f.git)).status, 'publication_failed');
});
