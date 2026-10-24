#!/usr/bin/env node
/**
 * verify-vps-run.mjs — fail-closed verification of an exact successful private-source build run.
 *
 * Contract (provided by the production-signing workflow environment):
 *   SOURCE_REPOSITORY  "owner/name" of the private source repository
 *   SOURCE_READ_TOKEN  fine-grained token with Actions: Read-only and Contents: Read-only
 *                      on the source repository only
 *   VPS_RUN_ID         Actions run ID of the successful private main push build
 *   EXPECTED_SHA       full 40-character lowercase commit SHA the run must be pinned to
 *   EXPECTED_BRANCH    branch the run must be on (expected "main")
 *   SOURCE_WORKFLOW_PATH  workflow path the run must belong to (expected ".github/workflows/build.yml")
 *
 * Using the GitHub REST API only, the script verifies:
 *   - the run belongs to the exact expected workflow (matched by workflow_id against the
 *     workflow registered at SOURCE_WORKFLOW_PATH in the source repository)
 *   - the run's head_repository is the configured source repository
 *   - the run exists and is a completed, successful push on the expected branch and SHA
 *   - exactly one non-expired artifact named "alookhor-vps-<EXPECTED_SHA>" exists on that run
 *
 * Error messages identify the failing endpoint precisely and never include the token
 * or any other secret. This verifies run and artifact metadata only. It does not download,
 * inspect, sign, or deploy the artifact. Exit code 0 on success; 1 with a clear message otherwise.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const GITHUB_API_BASE = 'https://api.github.com';
export const ARTIFACT_NAME_PREFIX = 'alookhor-vps-';
export const DEFAULT_WORKFLOW_PATH = '.github/workflows/build.yml';

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

class VerificationError extends Error {}

function fail(message) {
  throw new VerificationError(message);
}

/** Expected artifact name for a commit SHA: "alookhor-vps-<sha>". */
function artifactNameFor(sha) {
  return `${ARTIFACT_NAME_PREFIX}${sha}`;
}

/** Per-endpoint hint appended to precise 404 messages. */
const NOT_FOUND_HINTS = {
  'Source run': 'Confirm the run ID and the token\'s read access to the source repository.',
  'Artifacts list': 'The run may not exist or may have no artifacts.',
  'Workflow list': 'Confirm the token\'s read access to the source repository.',
};

/**
 * Validate the required environment contract.
 * Returns a normalized object on success; throws VerificationError otherwise.
 */
function checkEnv(env = process.env) {
  const repository = String(env.SOURCE_REPOSITORY ?? '').trim();
  const token = String(env.SOURCE_READ_TOKEN ?? '').trim();
  const runId = String(env.VPS_RUN_ID ?? '').trim();
  const expectedSha = String(env.EXPECTED_SHA ?? '').trim();
  const expectedBranch = String(env.EXPECTED_BRANCH ?? '').trim();
  const expectedWorkflowPath = String(env.SOURCE_WORKFLOW_PATH ?? DEFAULT_WORKFLOW_PATH).trim();

  if (!REPOSITORY_PATTERN.test(repository)) {
    fail('SOURCE_REPOSITORY must be a GitHub repository in "owner/name" form.');
  }
  if (!token) {
    fail('SOURCE_READ_TOKEN is not configured. Use a fine-grained token with Actions: Read-only and Contents: Read-only on the source repository.');
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    fail('VPS_RUN_ID must be a positive numeric Actions run ID (1 to 20 digits).');
  }
  if (!SHA_PATTERN.test(expectedSha)) {
    fail('EXPECTED_SHA must be a full 40-character lowercase commit SHA.');
  }
  if (!expectedBranch) {
    fail('EXPECTED_BRANCH must be set (expected "main").');
  }
  if (!WORKFLOW_PATH_PATTERN.test(expectedWorkflowPath)) {
    fail('SOURCE_WORKFLOW_PATH must be a workflow path in ".github/workflows/<name>.yml" form.');
  }

  return { repository, token, runId, expectedSha, expectedBranch, expectedWorkflowPath };
}

/** Authenticated GET against the GitHub REST API; returns the parsed JSON body.
 *  Error messages name the failing endpoint (label) and never include credentials. */
async function githubApiGet(url, token, fetchImpl = fetch, label = 'GitHub API') {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (cause) {
    fail(`Could not reach the GitHub API at ${url}: ${cause?.message ?? cause}`);
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body (proxy error page, empty body, etc.) — handled by the status checks.
  }

  const status = response.status;
  if (status < 200 || status >= 300) {
    const detail = body && typeof body.message === 'string' ? body.message : `HTTP ${status}`;
    if (status === 401) {
      fail(`The source read token was rejected (401) while requesting the ${label} at ${url}: ${detail}`);
    }
    if (status === 403) {
      fail(`The source read token lacks access or is rate limited (403) while requesting the ${label} at ${url}: ${detail}`);
    }
    if (status === 404) {
      const hint = NOT_FOUND_HINTS[label] ?? 'Confirm the resource and the token\'s read access to the source repository.';
      fail(`${label} not found at ${url} (404). ${hint}`);
    }
    fail(`GitHub API request failed (${status}) for the ${label} at ${url}: ${detail}`);
  }

  if (body === null) {
    fail(`Unexpected empty response from the GitHub API for the ${label} at ${url}.`);
  }

  return body;
}

/**
 * Resolve the workflow database ID registered at the expected workflow path in the
 * source repository (first page, per_page=100). Throws VerificationError when absent.
 */
async function fetchExpectedWorkflowId({ repository, token, expectedWorkflowPath, apiBase = GITHUB_API_BASE, fetchImpl = fetch }) {
  const workflowsUrl = `${apiBase}/repos/${repository}/actions/workflows?per_page=100`;
  const body = await githubApiGet(workflowsUrl, token, fetchImpl, 'Workflow list');
  const workflows = Array.isArray(body.workflows) ? body.workflows : [];
  const workflow = workflows.find((entry) => entry.path === expectedWorkflowPath);
  if (!workflow) {
    fail(`Workflow "${expectedWorkflowPath}" was not found in ${repository}. The configured source build workflow must exist in the source repository.`);
  }
  return workflow.id;
}

/**
 * Verify the exact source run and its artifact metadata.
 * Throws VerificationError on any mismatch; returns a summary object on success.
 */
async function verifyRun({ repository, token, runId, expectedSha, expectedBranch, expectedWorkflowPath, apiBase = GITHUB_API_BASE, fetchImpl = fetch }) {
  const expectedWorkflowId = await fetchExpectedWorkflowId({ repository, token, expectedWorkflowPath, apiBase, fetchImpl });

  const runUrl = `${apiBase}/repos/${repository}/actions/runs/${runId}`;
  const run = await githubApiGet(runUrl, token, fetchImpl, 'Source run');

  const problems = [];
  if (run.status !== 'completed') {
    problems.push(`run status is "${run.status}", expected "completed"`);
  }
  if (run.conclusion !== 'success') {
    problems.push(`run conclusion is "${run.conclusion}", expected "success"`);
  }
  if (run.event !== 'push') {
    problems.push(`run event is "${run.event}", expected "push"`);
  }
  if (run.head_branch !== expectedBranch) {
    problems.push(`run head branch is "${run.head_branch}", expected "${expectedBranch}"`);
  }
  if (run.head_sha !== expectedSha) {
    problems.push(`run head SHA is "${run.head_sha}", expected "${expectedSha}"`);
  }
  if (run.workflow_id === null || run.workflow_id === undefined) {
    problems.push('run has no workflow_id; cannot verify the source workflow');
  } else if (Number(run.workflow_id) !== Number(expectedWorkflowId)) {
    problems.push(`run belongs to workflow_id ${run.workflow_id}, expected ${expectedWorkflowId} for workflow "${expectedWorkflowPath}"`);
  }
  const headRepositoryFullName = run.head_repository?.full_name;
  if (!headRepositoryFullName) {
    problems.push('run has no head_repository; cannot verify the source repository');
  } else if (headRepositoryFullName !== repository) {
    problems.push(`run head repository is "${headRepositoryFullName}", expected "${repository}"`);
  }
  if (problems.length > 0) {
    fail(`Source run ${runId} does not match the required private main build:\n  - ${problems.join('\n  - ')}`);
  }

  const expectedArtifactName = artifactNameFor(expectedSha);
  const artifactsBody = await githubApiGet(`${runUrl}/artifacts?per_page=100`, token, fetchImpl, 'Artifacts list');
  const artifacts = Array.isArray(artifactsBody.artifacts) ? artifactsBody.artifacts : [];
  const matching = artifacts.filter((artifact) => artifact.name === expectedArtifactName && artifact.expired === false);
  if (matching.length !== 1) {
    fail(`Expected exactly one non-expired artifact named "${expectedArtifactName}" on run ${runId}; found ${matching.length}.`);
  }

  return {
    expectedWorkflowPath,
    expectedWorkflowId,
    run: {
      id: run.id,
      name: run.name,
      workflow_id: run.workflow_id,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      head_branch: run.head_branch,
      head_sha: run.head_sha,
      html_url: run.html_url,
    },
    artifact: matching[0],
  };
}

function formatSummary(result) {
  const { run, artifact, expectedWorkflowPath, expectedWorkflowId } = result;
  return [
    `Verified run ${run.id}: ${run.event} on ${run.head_branch} at ${run.head_sha} (${run.status}/${run.conclusion}) from workflow "${expectedWorkflowPath}" (workflow_id ${expectedWorkflowId}).`,
    `Verified exactly one non-expired artifact "${artifact.name}" (${artifact.size_in_bytes} bytes, created ${artifact.created_at}).`,
    'This verifies run and artifact metadata only. It does not download, inspect, sign, or deploy the artifact.',
  ];
}

async function main() {
  const env = checkEnv();
  const result = await verifyRun(env);
  for (const line of formatSummary(result)) {
    console.log(line);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    if (error instanceof VerificationError) {
      console.error(`ERROR: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}

export { VerificationError, checkEnv, artifactNameFor, githubApiGet, fetchExpectedWorkflowId, verifyRun, main };
