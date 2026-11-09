const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkRelease } = require('./release-check.cjs');

const script = path.join(__dirname, 'release-check.cjs');
const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// A throwaway checkout with package.json and, optionally, the notes file.
function checkout(version, notes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-yt-release-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pi-yt', version }));
  if (notes !== undefined) {
    fs.mkdirSync(path.join(dir, '.github', 'release-notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'release-notes', `v${version}.md`), notes);
  }
  return dir;
}

function cli(cwd, ...args) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { status, stdout, stderr };
}

test('accepts a vX.Y.Z tag matching package.json with release notes', () => {
  assert.equal(checkRelease({ tag: 'v1.2.3', version: '1.2.3', notes: 'Fixes\n\n- Something\n' }), undefined);
  assert.equal(checkRelease({ tag: 'v0.10.0', version: '0.10.0', notes: 'x' }), undefined);
});

test('rejects tags that are not vX.Y.Z', () => {
  for (const tag of ['1.2.3', 'v1.2', 'v1.2.3.4', 'v1.2.3-rc.1', 'v1.2.3+build', 'V1.2.3', ' v1.2.3', 'v1.2.3\n', '', undefined]) {
    assert.throws(() => checkRelease({ tag, version: '1.2.3', notes: 'x' }), {
      message: `Release tag "${tag ?? ''}" must look like vX.Y.Z.`,
    });
  }
});

test('rejects a tag that does not match the package.json version', () => {
  assert.throws(() => checkRelease({ tag: 'v1.2.4', version: '1.2.3', notes: 'x' }), {
    message: 'Release tag v1.2.4 does not match package.json version 1.2.3; expected v1.2.3.',
  });
});

test('rejects missing release notes', () => {
  assert.throws(() => checkRelease({ tag: 'v1.2.3', version: '1.2.3', notes: null }), {
    message: 'Missing release notes: add .github/release-notes/v1.2.3.md before tagging.',
  });
});

test('rejects empty or whitespace-only release notes', () => {
  for (const notes of ['', ' ', '\n\t \r\n']) {
    assert.throws(() => checkRelease({ tag: 'v1.2.3', version: '1.2.3', notes }), {
      message: 'Empty release notes: .github/release-notes/v1.2.3.md has no text.',
    });
  }
});

test('CLI reads package.json and the notes file for the given tag', () => {
  assert.deepEqual(cli(checkout('1.2.3', 'Fixes\n')), {
    status: 1,
    stdout: '',
    stderr: 'Release tag "" must look like vX.Y.Z.\n',
  });
  assert.deepEqual(cli(checkout('1.2.3', 'Fixes\n'), 'v1.2.3'), {
    status: 0,
    stdout: 'Release v1.2.3 is ready: .github/release-notes/v1.2.3.md\n',
    stderr: '',
  });
  assert.deepEqual(cli(checkout('1.2.3', 'Fixes\n'), 'v1.2.4'), {
    status: 1,
    stdout: '',
    stderr: 'Release tag v1.2.4 does not match package.json version 1.2.3; expected v1.2.3.\n',
  });
  assert.deepEqual(cli(checkout('1.2.3'), 'v1.2.3'), {
    status: 1,
    stdout: '',
    stderr: 'Missing release notes: add .github/release-notes/v1.2.3.md before tagging.\n',
  });
  assert.deepEqual(cli(checkout('1.2.3', '  \n'), 'v1.2.3'), {
    status: 1,
    stdout: '',
    stderr: 'Empty release notes: .github/release-notes/v1.2.3.md has no text.\n',
  });
});

// Split release.yml into top-level jobs keyed by id.
function jobs(workflow) {
  const body = workflow.split(/^jobs:\n/m)[1];
  const result = {};
  for (const chunk of body.split(/^(?=  [\w-]+:\n)/m)) {
    const id = /^  ([\w-]+):\n/.exec(chunk)?.[1];
    if (id) result[id] = chunk;
  }
  return result;
}

test('release workflow runs on version tags only, with minimal permissions per job', () => {
  const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  const on = workflow.split(/^on:\n/m)[1].split(/^\S/m)[0];
  assert.equal(on, "  push:\n    tags: ['v*.*.*']\n\n");
  assert.match(workflow, /^permissions: \{\}$/m);

  const { verify, publish, 'github-release': release, ...rest } = jobs(workflow);
  assert.deepEqual(Object.keys(rest), []);
  const permissions = job => job.split('    permissions:\n')[1].split(/^    \S/m)[0];
  assert.equal(permissions(verify), '      contents: read\n');
  assert.equal(permissions(publish), '      contents: read\n      id-token: write\n');
  assert.equal(permissions(release), '      contents: write\n');
  assert.equal(workflow.match(/id-token: write/g).length, 1);
  assert.equal(workflow.match(/contents: write/g).length, 1);

  assert.doesNotMatch(verify, /^    needs:/m);
  assert.match(verify, /node \.github\/scripts\/release-check\.cjs "\$GITHUB_REF_NAME"/);
  assert.match(verify, /node --test \.github\/scripts\/release-check\.test\.cjs/);
  for (const command of ['npm ci --ignore-scripts', 'npm test', 'npm run typecheck', 'npm run lint', 'npm pack --dry-run']) {
    assert.match(verify, new RegExp(`run: ${command}$`, 'm'));
  }

  assert.match(publish, /^    needs: verify$/m);
  assert.match(publish, /^    environment: npm$/m);
  assert.match(publish, /registry-url: 'https:\/\/registry\.npmjs\.org'/);
  assert.match(publish, /run: npm publish --provenance$/m);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);

  assert.match(release, /^    needs: publish$/m);
  assert.match(release, /gh release create "\$GITHUB_REF_NAME" --verify-tag --title "\$GITHUB_REF_NAME" --notes-file "\.github\/release-notes\/\$GITHUB_REF_NAME\.md"$/m);
  assert.doesNotMatch(workflow, /--generate-notes/);
});

test('release workflow pins actions and keeps expressions out of run scripts', () => {
  const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  const uses = workflow.match(/^\s*(?:- )?uses: .*$/gm);
  assert.ok(uses.length >= 4);
  for (const line of uses) {
    assert.match(line, /^\s*(?:- )?uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  }
  assert.equal(workflow.match(/persist-credentials: false/g).length, workflow.match(/actions\/checkout@/g).length);
  // Every run script, inline or block, is free of ${{ }} expressions.
  const lines = workflow.split('\n');
  lines.forEach((line, index) => {
    const run = /^(\s*)(?:- )?run: ?(.*)$/.exec(line);
    if (!run) return;
    const script = [run[2]];
    if (/^[|>]/.test(run[2])) {
      for (let next = index + 1; next < lines.length && (lines[next] === '' || /^\s/.test(lines[next])
        && lines[next].search(/\S/) > run[1].length); next++) script.push(lines[next]);
    }
    assert.doesNotMatch(script.join('\n'), /\$\{\{/, `line ${index + 1}`);
  });
});
