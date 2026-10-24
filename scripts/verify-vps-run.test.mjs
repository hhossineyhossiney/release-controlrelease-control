import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEnv, verifyRun, artifactNameFor, VerificationError } from './verify-vps-run.mjs';

const SHA = 'a'.repeat(40);
const VALID_ENV = {
  SOURCE_REPOSITORY: 'hhossineyhossiney/alookhor-store',
  SOURCE_READ_TOKEN: 'ghs_read_only_token',
  VPS_RUN_ID: '1234567890',
  EXPECTED_SHA: SHA,
  EXPECTED_BRANCH: 'main',
};

function runJson(overrides = {}) {
  return {
    id: 1234567890,
    name: 'alookhor-vps main build',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: SHA,
    html_url: 'https://github.com/hhossineyhossiney/alookhor-store/actions/runs/1234567890',
    ...overrides,
  };
}

function artifactJson(overrides = {}) {
  return {
    name: artifactNameFor(SHA),
    expired: false,
    size_in_bytes: 2048,
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return { status, json: async () => body };
}

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.includes(prefix)) {
        return handler(url);
      }
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

test('artifactNameFor builds the expected artifact name', () => {
  assert.equal(artifactNameFor(SHA), `alookhor-vps-${SHA}`);
});

test('checkEnv accepts and normalizes a valid environment', () => {
  const env = checkEnv({ ...VALID_ENV, EXPECTED_SHA: `  ${SHA}  ` });
  assert.deepEqual(env, {
    repository: VALID_ENV.SOURCE_REPOSITORY,
    token: VALID_ENV.SOURCE_READ_TOKEN,
    runId: VALID_ENV.VPS_RUN_ID,
    expectedSha: SHA,
    expectedBranch: VALID_ENV.EXPECTED_BRANCH,
  });
});

test('checkEnv rejects a missing token', () => {
  assert.throws(
    () => checkEnv({ ...VALID_ENV, SOURCE_READ_TOKEN: '' }),
    (err) => err instanceof VerificationError && err.message.includes('SOURCE_READ_TOKEN'),
  );
});

test('checkEnv rejects an invalid repository', () => {
  assert.throws(() => checkEnv({ ...VALID_ENV, SOURCE_REPOSITORY: 'not-a-repo' }), VerificationError);
  assert.throws(() => checkEnv({ ...VALID_ENV, SOURCE_REPOSITORY: 'owner/' }), VerificationError);
  assert.throws(() => checkEnv({ ...VALID_ENV, SOURCE_REPOSITORY: '/repo' }), VerificationError);
});

test('checkEnv rejects an invalid run ID', () => {
  assert.throws(() => checkEnv({ ...VALID_ENV, VPS_RUN_ID: '0' }), VerificationError);
  assert.throws(() => checkEnv({ ...VALID_ENV, VPS_RUN_ID: '-1' }), VerificationError);
  assert.throws(() => checkEnv({ ...VALID_ENV, VPS_RUN_ID: '12a' }), VerificationError);
});

test('checkEnv rejects an invalid SHA', () => {
  assert.throws(() => checkEnv({ ...VALID_ENV, EXPECTED_SHA: 'abc' }), VerificationError);
  assert.throws(() => checkEnv({ ...VALID_ENV, EXPECTED_SHA: SHA.slice(0, 39) }), VerificationError);
  assert.throws(() => checkEnv({ ...VALID_ENV, EXPECTED_SHA: SHA.replace('a', 'Z') }), VerificationError);
});

test('checkEnv rejects a missing branch', () => {
  assert.throws(() => checkEnv({ ...VALID_ENV, EXPECTED_BRANCH: '' }), VerificationError);
});

test('verifyRun accepts a successful exact private main push run with one artifact', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ total_count: 1, artifacts: [artifactJson()] })
        : jsonResponse(runJson()),
  });
  const result = await verifyRun({ ...checkEnv(VALID_ENV), fetchImpl });
  assert.equal(result.run.id, 1234567890);
  assert.equal(result.run.head_branch, 'main');
  assert.equal(result.run.head_sha, SHA);
  assert.equal(result.artifact.name, `alookhor-vps-${SHA}`);
  assert.equal(result.artifact.expired, false);
});

test('verifyRun rejects a run that is not completed', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ total_count: 1, artifacts: [artifactJson()] })
        : jsonResponse(runJson({ status: 'in_progress', conclusion: null })),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /status is "in_progress", expected "completed"/.test(err.message),
  );
});

test('verifyRun rejects a run with a non-success conclusion', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ total_count: 1, artifacts: [artifactJson()] })
        : jsonResponse(runJson({ conclusion: 'failure' })),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /conclusion is "failure", expected "success"/.test(err.message),
  );
});

test('verifyRun rejects a non-push run', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ total_count: 1, artifacts: [artifactJson()] })
        : jsonResponse(runJson({ event: 'workflow_dispatch' })),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /event is "workflow_dispatch", expected "push"/.test(err.message),
  );
});

test('verifyRun rejects a run on a different branch', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ total_count: 1, artifacts: [artifactJson()] })
        : jsonResponse(runJson({ head_branch: 'develop' })),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /head branch is "develop", expected "main"/.test(err.message),
  );
});

test('verifyRun rejects a run pinned to a different SHA', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ total_count: 1, artifacts: [artifactJson()] })
        : jsonResponse(runJson({ head_sha: 'b'.repeat(40) })),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /head SHA is "bbbb/.test(err.message),
  );
});

test('verifyRun rejects an unknown run (404)', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: () => jsonResponse({ message: 'Not Found' }, 404),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /Run not found .* \(404\)/.test(err.message),
  );
});

test('verifyRun rejects a rejected token (401)', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: () => jsonResponse({ message: 'Bad credentials' }, 401),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /token was rejected \(401\)/.test(err.message),
  );
});

test('verifyRun rejects an insufficient or rate-limited token (403)', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: () => jsonResponse({ message: 'Resource not accessible by integration' }, 403),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /lacks access or is rate limited \(403\)/.test(err.message),
  );
});

test('verifyRun rejects a network failure with a clear message', async () => {
  const fetchImpl = async () => {
    throw new Error('ENOTFOUND api.github.com');
  };
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /Could not reach the GitHub API/.test(err.message),
  );
});

test('verifyRun rejects an unexpected empty API response', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: () => ({
      status: 200,
      json: async () => {
        throw new Error('Unexpected end of JSON input');
      },
    }),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /Unexpected empty response/.test(err.message),
  );
});

test('verifyRun rejects when no artifact matches the expected name', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ total_count: 1, artifacts: [artifactJson({ name: 'some-other-artifact' })] })
        : jsonResponse(runJson()),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /Expected exactly one non-expired artifact named "alookhor-vps-/.test(err.message),
  );
});

test('verifyRun rejects when two artifacts match the expected name', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ total_count: 2, artifacts: [artifactJson(), artifactJson()] })
        : jsonResponse(runJson()),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /found 2\./.test(err.message),
  );
});

test('verifyRun rejects a matching artifact that has expired', async () => {
  const fetchImpl = fakeFetch({
    [`/repos/${VALID_ENV.SOURCE_REPOSITORY}/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ total_count: 1, artifacts: [artifactJson({ expired: true })] })
        : jsonResponse(runJson()),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /found 0\./.test(err.message),
  );
});
