import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEnv,
  verifyRun,
  artifactNameFor,
  VerificationError,
  DEFAULT_WORKFLOW_PATH,
} from './verify-vps-run.mjs';

const SHA = 'a'.repeat(40);
const WORKFLOW_ID = 12345;
const WORKFLOW_PATH = '.github/workflows/build.yml';
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
    name: 'build',
    workflow_id: WORKFLOW_ID,
    path: WORKFLOW_PATH,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: SHA,
    head_repository: { full_name: VALID_ENV.SOURCE_REPOSITORY },
    html_url: 'https://github.com/hhossineyhossiney/alookhor-store/actions/runs/1234567890',
    ...overrides,
  };
}

function workflowsJson(overrides = {}) {
  return {
    total_count: 1,
    workflows: [{ id: WORKFLOW_ID, name: 'build', path: WORKFLOW_PATH, state: 'active' }],
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

/** Standard route table: workflows list -> run -> artifacts list. */
function standardRoutes({ run = runJson(), workflows = workflowsJson(), artifacts = [artifactJson()] } = {}) {
  return {
    [`/actions/workflows`]: () => jsonResponse(workflows),
    [`/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ total_count: artifacts.length, artifacts })
        : jsonResponse(run),
  };
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
    expectedWorkflowPath: DEFAULT_WORKFLOW_PATH,
  });
});

test('checkEnv defaults SOURCE_WORKFLOW_PATH to build.yml when unset', () => {
  const env = checkEnv(VALID_ENV);
  assert.equal(env.expectedWorkflowPath, DEFAULT_WORKFLOW_PATH);
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

test('checkEnv rejects an invalid workflow path', () => {
  assert.throws(() => checkEnv({ ...VALID_ENV, SOURCE_WORKFLOW_PATH: 'build.yml' }), VerificationError);
  assert.throws(() => checkEnv({ ...VALID_ENV, SOURCE_WORKFLOW_PATH: '.github/workflows/build' }), VerificationError);
  assert.throws(() => checkEnv({ ...VALID_ENV, SOURCE_WORKFLOW_PATH: '' }), VerificationError);
});

test('verifyRun accepts a successful exact private main push run with one artifact', async () => {
  const fetchImpl = fakeFetch(standardRoutes());
  const result = await verifyRun({ ...checkEnv(VALID_ENV), fetchImpl });
  assert.equal(result.expectedWorkflowId, WORKFLOW_ID);
  assert.equal(result.expectedWorkflowPath, WORKFLOW_PATH);
  assert.equal(result.run.id, 1234567890);
  assert.equal(result.run.workflow_id, WORKFLOW_ID);
  assert.equal(result.run.head_branch, 'main');
  assert.equal(result.run.head_sha, SHA);
  assert.equal(result.artifact.name, `alookhor-vps-${SHA}`);
  assert.equal(result.artifact.expired, false);
});

test('verifyRun honors a custom SOURCE_WORKFLOW_PATH', async () => {
  const customPath = '.github/workflows/ci.yml';
  const fetchImpl = fakeFetch({
    [`/actions/workflows`]: () => jsonResponse({
      total_count: 2,
      workflows: [
        { id: WORKFLOW_ID, name: 'build', path: WORKFLOW_PATH, state: 'active' },
        { id: 54321, name: 'ci', path: customPath, state: 'active' },
      ],
    }),
    [`/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ total_count: 1, artifacts: [artifactJson()] })
        : jsonResponse(runJson({ workflow_id: 54321 })),
  });
  const result = await verifyRun({ ...checkEnv({ ...VALID_ENV, SOURCE_WORKFLOW_PATH: customPath }), fetchImpl });
  assert.equal(result.expectedWorkflowPath, customPath);
  assert.equal(result.expectedWorkflowId, 54321);
});

test('verifyRun rejects a run that is not completed', async () => {
  const fetchImpl = fakeFetch(standardRoutes({ run: runJson({ status: 'in_progress', conclusion: null }) }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /status is "in_progress", expected "completed"/.test(err.message),
  );
});

test('verifyRun rejects a run with a non-success conclusion', async () => {
  const fetchImpl = fakeFetch(standardRoutes({ run: runJson({ conclusion: 'failure' }) }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /conclusion is "failure", expected "success"/.test(err.message),
  );
});

test('verifyRun rejects a non-push run', async () => {
  const fetchImpl = fakeFetch(standardRoutes({ run: runJson({ event: 'workflow_dispatch' }) }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /event is "workflow_dispatch", expected "push"/.test(err.message),
  );
});

test('verifyRun rejects a run on a different branch', async () => {
  const fetchImpl = fakeFetch(standardRoutes({ run: runJson({ head_branch: 'develop' }) }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /head branch is "develop", expected "main"/.test(err.message),
  );
});

test('verifyRun rejects a run pinned to a different SHA', async () => {
  const fetchImpl = fakeFetch(standardRoutes({ run: runJson({ head_sha: 'b'.repeat(40) }) }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /head SHA is "bbbb/.test(err.message),
  );
});

test('verifyRun rejects a run belonging to a different workflow', async () => {
  const fetchImpl = fakeFetch(standardRoutes({ run: runJson({ workflow_id: 99999 }) }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /workflow_id 99999, expected 12345/.test(err.message),
  );
});

test('verifyRun rejects a run with a missing workflow_id', async () => {
  const fetchImpl = fakeFetch(standardRoutes({ run: runJson({ workflow_id: null }) }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /no workflow_id/.test(err.message),
  );
});

test('verifyRun rejects when the configured workflow path does not exist in the repository', async () => {
  const fetchImpl = fakeFetch(standardRoutes({
    workflows: {
      total_count: 1,
      workflows: [{ id: 1, name: 'deploy', path: '.github/workflows/deploy.yml', state: 'active' }],
    },
  }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /Workflow "\.github\/workflows\/build\.yml" was not found/.test(err.message),
  );
});

test('verifyRun rejects a run from a different repository', async () => {
  const fetchImpl = fakeFetch(standardRoutes({
    run: runJson({ head_repository: { full_name: 'evil/other-repo' } }),
  }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /head repository is "evil\/other-repo", expected "hhossineyhossiney\/alookhor-store"/.test(err.message),
  );
});

test('verifyRun rejects a run without a head repository', async () => {
  const fetchImpl = fakeFetch(standardRoutes({ run: runJson({ head_repository: null }) }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /no head_repository/.test(err.message),
  );
});

test('verifyRun rejects an unknown source run (404) with an endpoint-precise message', async () => {
  const fetchImpl = fakeFetch({
    [`/actions/workflows`]: () => jsonResponse(workflowsJson()),
    [`/actions/runs/`]: () => jsonResponse({ message: 'Not Found' }, 404),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /Source run not found/.test(err.message),
  );
});

test('verifyRun reports an artifacts endpoint 404 precisely, not as a missing run', async () => {
  const fetchImpl = fakeFetch({
    [`/actions/workflows`]: () => jsonResponse(workflowsJson()),
    [`/actions/runs/`]: (url) =>
      url.includes('/artifacts')
        ? jsonResponse({ message: 'Not Found' }, 404)
        : jsonResponse(runJson()),
  });
  try {
    await verifyRun({ ...checkEnv(VALID_ENV), fetchImpl });
    assert.fail('expected verifyRun to reject');
  } catch (err) {
    assert.ok(err instanceof VerificationError);
    assert.match(err.message, /Artifacts list not found/);
    assert.doesNotMatch(err.message, /Source run not found|Run not found/);
  }
});

test('verifyRun reports a workflows endpoint 404 precisely', async () => {
  const fetchImpl = fakeFetch({
    [`/actions/workflows`]: () => jsonResponse({ message: 'Not Found' }, 404),
  });
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /Workflow list not found/.test(err.message),
  );
});

test('verifyRun rejects a rejected token (401) and never includes the token in messages', async () => {
  const fetchImpl = fakeFetch({
    [`/actions/workflows`]: () => jsonResponse({ message: 'Bad credentials' }, 401),
  });
  try {
    await verifyRun({ ...checkEnv(VALID_ENV), fetchImpl });
    assert.fail('expected verifyRun to reject');
  } catch (err) {
    assert.ok(err instanceof VerificationError);
    assert.match(err.message, /token was rejected \(401\)/);
    assert.ok(!err.message.includes(VALID_ENV.SOURCE_READ_TOKEN), 'error message must not include the token');
  }
});

test('verifyRun rejects an insufficient or rate-limited token (403)', async () => {
  const fetchImpl = fakeFetch({
    [`/actions/workflows`]: () => jsonResponse({ message: 'Resource not accessible by integration' }, 403),
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
    [`/actions/workflows`]: () => ({
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
  const fetchImpl = fakeFetch(standardRoutes({
    artifacts: [artifactJson({ name: 'some-other-artifact' })],
  }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /Expected exactly one non-expired artifact named "alookhor-vps-/.test(err.message),
  );
});

test('verifyRun rejects when two artifacts match the expected name', async () => {
  const fetchImpl = fakeFetch(standardRoutes({ artifacts: [artifactJson(), artifactJson()] }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /found 2\./.test(err.message),
  );
});

test('verifyRun rejects a matching artifact that has expired', async () => {
  const fetchImpl = fakeFetch(standardRoutes({ artifacts: [artifactJson({ expired: true })] }));
  await assert.rejects(
    verifyRun({ ...checkEnv(VALID_ENV), fetchImpl }),
    (err) => err instanceof VerificationError && /found 0\./.test(err.message),
  );
});
