const API = "https://api.github.com";

const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "passu-release-bot",
  "X-GitHub-Api-Version": "2022-11-28",
};

// GitHub App으로 인증하기 위한 JWT(RS256). iss에는 App의 Client ID를 쓴다.
async function createAppJwt(clientId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // 서버 시계 오차를 고려해 발급 시각을 60초 앞당기고, 최대 10분보다 짧게 만료시킨다.
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: clientId }));
  const data = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    toPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${base64url(new Uint8Array(signature))}`;
}

// 설치(installation) 토큰을 지정한 레포와 권한으로 좁혀서 발급한다.
async function createInstallationToken(
  jwt: string,
  installationId: number,
  repositories: string[],
  permissions: Record<string, "read" | "write">,
): Promise<string> {
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ repositories, permissions }),
  });
  if (!res.ok) throw new Error(`설치 토큰 발급 실패 (${res.status}): ${await res.text()}`);
  const { token } = (await res.json()) as { token: string };
  return token;
}

async function dispatch(token: string, owner: string, repo: string, eventType: string, payload: object): Promise<void> {
  const res = await fetch(`${API}/repos/${owner}/${repo}/dispatches`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });
  if (!res.ok) throw new Error(`${owner}/${repo} dispatch 실패 (${res.status}): ${await res.text()}`);
}

async function request<T>(token: string, method: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...HEADERS, Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} 실패 (${res.status}): ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

// 레포에 설치된 App의 installation ID. Discord 버튼처럼 GitHub 웹훅 밖에서 호출될 때 쓴다.
async function getRepoInstallationId(jwt: string, owner: string, repo: string): Promise<number> {
  const { id } = await request<{ id: number }>(jwt, "GET", `/repos/${owner}/${repo}/installation`);
  return id;
}

// App 자신의 slug. PR 작성자가 이 App(`<slug>[bot]`)인지 확인할 때 쓴다.
async function getAppSlug(jwt: string): Promise<string> {
  const { slug } = await request<{ slug: string }>(jwt, "GET", "/app");
  return slug;
}

type PullRequest = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  // GitHub이 아직 계산 중이면 null
  mergeable: boolean | null;
  html_url: string;
  user: { login: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { sha: string };
};

function getPullRequest(token: string, owner: string, repo: string, number: number): Promise<PullRequest> {
  return request(token, "GET", `/repos/${owner}/${repo}/pulls/${number}`);
}

// 커밋이 들어 있는 PR 번호. pull_request_target 워크플로처럼 웹훅에 PR 목록이 비어 올 때 쓴다
async function listPullRequestNumbersForCommit(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<number[]> {
  const prs = await request<{ number: number; state: string }[]>(
    token,
    "GET",
    `/repos/${owner}/${repo}/commits/${sha}/pulls`,
  );
  return prs.filter((pr) => pr.state === "open").map((pr) => pr.number);
}

type WorkflowRun = {
  name: string;
  status: string;
  conclusion: string | null;
};

// 커밋 하나에 대해 돈 Actions 워크플로 실행 목록
async function listWorkflowRuns(token: string, owner: string, repo: string, sha: string): Promise<WorkflowRun[]> {
  const { workflow_runs } = await request<{ workflow_runs: WorkflowRun[] }>(
    token,
    "GET",
    `/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
  );
  return workflow_runs;
}

async function getFileContent(token: string, owner: string, repo: string, path: string, ref: string): Promise<string> {
  const { content } = await request<{ content: string }>(
    token,
    "GET",
    `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
  );
  const bytes = Uint8Array.from(atob(content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// sha를 넘기면 그 사이 브랜치에 새 커밋이 올라왔을 때 GitHub이 머지를 거부한다(409).
async function mergePullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
  sha: string,
): Promise<void> {
  await request(token, "PUT", `/repos/${owner}/${repo}/pulls/${number}/merge`, { merge_method: "squash", sha });
}

async function deleteBranch(token: string, owner: string, repo: string, branch: string): Promise<void> {
  await request(token, "DELETE", `/repos/${owner}/${repo}/git/refs/heads/${branch}`);
}

// GitHub에서 받은 키는 PKCS#1(BEGIN RSA PRIVATE KEY)이고 WebCrypto는 PKCS#8만 읽으므로,
// PKCS#1이면 PKCS#8 구조로 감싼다. 이미 PKCS#8(BEGIN PRIVATE KEY)이면 그대로 쓴다.
function toPkcs8(pem: string): Uint8Array {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  if (!isPkcs1) return der;

  const version = [0x02, 0x01, 0x00];
  // AlgorithmIdentifier { rsaEncryption, NULL }
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const privateKey = [0x04, ...derLength(der.length), ...der];
  const body = [...version, ...algorithm, ...privateKey];
  return Uint8Array.from([0x30, ...derLength(body.length), ...body]);
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function base64url(input: string | Uint8Array): string {
  const binary = typeof input === "string" ? unescape(encodeURIComponent(input)) : String.fromCharCode(...input);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type { PullRequest, WorkflowRun };
export {
  createAppJwt,
  createInstallationToken,
  deleteBranch,
  dispatch,
  getAppSlug,
  getFileContent,
  getPullRequest,
  getRepoInstallationId,
  listPullRequestNumbersForCommit,
  listWorkflowRuns,
  mergePullRequest,
};
