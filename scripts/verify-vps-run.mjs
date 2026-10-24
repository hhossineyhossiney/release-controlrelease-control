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
 *
 * Using the GitHub REST API only, the script verifies:
 *   - the run exists and is a completed, successful push on the expected branch and SHA
 *   - exactly one non-expired artifact named "alookhor-vps-<EXPECTED_SHA>" exists on that run
 *
 * This verifies run and artifact metadata only. It does not download, inspect, sign, or
 * deploy the artifact. Exit code 0 on success; 1 with a clear message otherwise.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const GITHUB_API_BASE = 'https://api.github.com';
export const ARTIFACT_NAME_PREFIX = 'alookhor-vps-';

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;

class VerificationError extends Error {}

function fail(message) {
  throw new VerificationError(message);
}

/** Expected artifact name for a commit SHA: "alookhor-vps-<sha>". */
function artifactNameFor(sha) {
  return `${ARTIFACT_NAME_PREFIX}${sha}`;
}

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

  return { repository, token, runId, expectedSha, expectedBranch };
}

/** Authenticated GET against the GitHub REST API; returns the parsed JSON body. */
async function githubApiGet(url, token, fetchImpl = fetch) {
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
      fail(`The source read token was rejected (401): ${detail}`);
    }
    if (status === 403) {
      fail(`The source read token lacks access or is rate limited (403): ${detail}`);
    }
    if (status === 404) {
      fail(`Run not found at ${url} (404). Confirm the run ID and the token's read access to the source repository.`);
    }
    fail(`GitHub API request failed (${status}) for ${url}: ${detail}`);
  }

  if (body === null) {
    fail(`Unexpected empty response from the GitHub API at ${url}.`);
  }

  return body;
}

/**
 * Verify the exact source run and its artifact metadata.
 * Throws VerificationError on any mismatch; returns a summary object on success.
 */
async function verifyRun({ repository, token, runId, expectedSha, expectedBranch, apiBase = GITHUB_API_BASE, fetchImpl = fetch }) {
  const runUrl = `${apiBase}/repos/${repository}/actions/runs/${runId}`;
  const run = await githubApiGet(runUrl, token, fetchImpl);

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
  if (problems.length > 0) {
    fail(`Source run ${runId} does not match the required private main build:\n  - ${problems.join('\n  - ')}`);
  }

  const expectedArtifactName = artifactNameFor(expectedSha);
  const artifactsBody = await githubApiGet(`${runUrl}/artifacts?per_page=100`, token, fetchImpl);
  const artifacts = Array.isArray(artifactsBody.artifacts) ? artifactsBody.artifacts : [];
  const matching = artifacts.filter((artifact) => artifact.name === expectedArtifactName && artifact.expired === false);
  if (matching.length !== 1) {
    fail(`Expected exactly one non-expired artifact named "${expectedArtifactName}" on run ${runId}; found ${matching.length}.`);
  }

  return {
    run: {
      id: run.id,
      name: run.name,
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
  const { run, artifact } = result;
  return [
    `Verified run ${run.id}: ${run.event} on ${run.head_branch} at ${run.head_sha} (${run.status}/${run.conclusion}).`,
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

export { VerificationError, checkEnv, artifactNameFor, githubApiGet, verifyRun, main };
