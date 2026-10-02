// 앱 레포의 의존성 업데이트 PR을 CI 결과에 따라 처리한다.
// 패치 버전은 CI가 통과하면 바로 머지하고, 마이너·메이저는 Discord에 머지 버튼을 보낸다.
import { OWNER, SOURCES } from "./config";
import {
  type Bump,
  editInteractionMessage,
  parseMergeButtonId,
  sendChannelMessage,
  type UpdatePr,
  type UpdateStatus,
  updateMessage,
} from "./discord";
import type { Env } from "./env";
import {
  createAppJwt,
  createInstallationToken,
  deleteBranch,
  getAppSlug,
  getFileContent,
  getPullRequest,
  getRepoInstallationId,
  listPullRequestNumbersForCommit,
  listWorkflowRuns,
  mergePullRequest,
  type PullRequest,
} from "./github";

type WorkflowRunEvent = {
  action: string;
  workflow_run: { head_sha: string; pull_requests: { number: number }[] };
  repository: { name: string };
  installation: { id: number };
};

type ComponentInteraction = {
  application_id: string;
  token: string;
  member?: { user: { id: string }; roles: string[] };
  data: { custom_id: string };
};

// 머지까지 하려면 Contents·Pull requests 쓰기, CI 결과를 읽으려면 Actions 읽기가 필요하다.
const PERMISSIONS = { contents: "write", pull_requests: "write", actions: "read" } as const;

// CI가 이 결론이면 통과로 본다
const PASSING = new Set(["success", "skipped", "neutral"]);

async function handleWorkflowRun(env: Env, event: WorkflowRunEvent): Promise<void> {
  const repo = event.repository.name;
  const { head_sha: sha } = event.workflow_run;
  if (packagesFor(repo).length === 0) return;

  const jwt = await createAppJwt(env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_PRIVATE_KEY);
  const [slug, token] = await Promise.all([
    getAppSlug(jwt),
    createInstallationToken(jwt, event.installation.id, [repo], PERMISSIONS),
  ]);

  // pull_request_target으로 도는 워크플로(PR 제목 검사 등)는 웹훅에 PR 목록이 비어 오므로 커밋으로 찾는다
  let numbers = event.workflow_run.pull_requests.map((pr) => pr.number);
  if (numbers.length === 0) numbers = await listPullRequestNumbersForCommit(token, OWNER, repo, sha);

  for (const number of numbers) {
    const found = await findUpdatePr(token, slug, repo, number);
    // 오래된 커밋의 CI 결과면 무시한다. 최신 커밋의 CI가 끝날 때 다시 불린다
    if (!found || found.pr.state !== "open" || found.pr.head.sha !== sha) continue;

    const status = await checkMergeable(token, repo, found.pr);
    // 다른 워크플로가 아직 돌고 있으면, 마지막 워크플로가 끝날 때 처리한다
    if (status === "pending") continue;

    if (status.kind === "ready" && found.update.bump === "patch") {
      const result = await merge(token, repo, found.pr);
      // 다른 실행이 먼저 머지하고 알림도 보냈다
      if (result === "duplicate") continue;
      await notify(env, found.update, result ?? { kind: "merged", by: null });
    } else {
      await notify(env, found.update, status);
    }
  }
}

// Discord 머지 버튼 클릭. 3초 안에 응답해야 해서 응답을 먼저 돌려주고 머지는 백그라운드에서 한다.
function handleMergeClick(env: Env, interaction: ComponentInteraction, ctx: ExecutionContext): Response {
  const target = parseMergeButtonId(interaction.data.custom_id);
  const allowed = (env.DISCORD_MERGE_ROLE_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const member = interaction.member;

  if (!target) return ephemeral("알 수 없는 버튼이에요.");
  if (!member || !member.roles.some((role) => allowed.includes(role))) return ephemeral("머지 권한이 없어요.");

  ctx.waitUntil(
    mergeFromButton(env, target, member.user.id)
      .then((message) => message && editInteractionMessage(interaction.application_id, interaction.token, message))
      .catch((error) => console.error(error)),
  );
  // DEFERRED_UPDATE_MESSAGE: 버튼 메시지는 나중에 고친다
  return Response.json({ type: 6 });
}

async function mergeFromButton(env: Env, target: { repo: string; number: number; sha: string }, userId: string) {
  const jwt = await createAppJwt(env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_PRIVATE_KEY);
  const [slug, installationId] = await Promise.all([getAppSlug(jwt), getRepoInstallationId(jwt, OWNER, target.repo)]);
  const token = await createInstallationToken(jwt, installationId, [target.repo], PERMISSIONS);

  const found = await findUpdatePr(token, slug, target.repo, target.number);
  if (!found) return null;
  const { pr, update } = found;

  const fail = (reason: string) => updateMessage(update, { kind: "merge-failed", reason });
  if (pr.merged) return fail("이미 머지된 PR이에요.");
  if (pr.state !== "open") return fail("닫힌 PR이에요.");
  // 메시지를 보낸 뒤 커밋이 추가됐으면 그 커밋은 검토 전이므로 머지하지 않는다
  if (pr.head.sha !== target.sha)
    return fail("메시지를 보낸 뒤 새 커밋이 올라왔어요. 새 CI가 끝나면 다시 알려 드려요.");

  const status = await checkMergeable(token, target.repo, pr);
  if (status === "pending") return fail("CI가 아직 돌고 있어요.");
  if (status.kind !== "ready") return updateMessage(update, status);

  const result = await merge(token, target.repo, pr);
  // 버튼을 거의 동시에 두 번 누른 경우. 먼저 처리된 쪽이 메시지를 고친다
  if (result === "duplicate") return null;
  return updateMessage(update, result ?? { kind: "merged", by: userId });
}

// 이 App이 만든 의존성 업데이트 PR이면 버전 정보와 함께 돌려준다
async function findUpdatePr(
  token: string,
  slug: string,
  repo: string,
  number: number,
): Promise<{ pr: PullRequest; update: UpdatePr } | null> {
  const pr = await getPullRequest(token, OWNER, repo, number);
  if (pr.user.login !== `${slug}[bot]` || pr.head.repo?.full_name !== `${OWNER}/${repo}`) return null;

  // 업데이트 워크플로가 만드는 브랜치: chore/<스코프 뺀 패키지 이름>-<버전>
  const packageName = packagesFor(repo).find((name) => pr.head.ref.startsWith(`chore/${name.split("/").pop()}-`));
  if (!packageName) return null;

  const [from, to] = await Promise.all(
    [pr.base.sha, pr.head.sha].map(async (ref) =>
      dependencyVersion(await getFileContent(token, OWNER, repo, "package.json", ref), packageName),
    ),
  );
  if (!from || !to) return null;

  return {
    pr,
    update: { repo, number, url: pr.html_url, sha: pr.head.sha, packageName, from, to, bump: bumpOf(from, to) },
  };
}

async function checkMergeable(token: string, repo: string, pr: PullRequest): Promise<UpdateStatus | "pending"> {
  const runs = await listWorkflowRuns(token, OWNER, repo, pr.head.sha);
  if (runs.length === 0 || runs.some((run) => run.status !== "completed")) return "pending";

  const failed = runs.filter((run) => !PASSING.has(run.conclusion ?? "")).map((run) => run.name);
  if (failed.length > 0) return { kind: "ci-failed", failed };

  // mergeable은 GitHub이 백그라운드에서 계산하므로 처음엔 null일 수 있다
  let mergeable = pr.mergeable;
  for (let attempt = 0; mergeable === null && attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    mergeable = (await getPullRequest(token, OWNER, repo, pr.number)).mergeable;
  }
  if (mergeable === false) return { kind: "conflict" };
  if (mergeable === null) return "pending";
  return { kind: "ready" };
}

// 머지에 성공하면 null, 실패하면 실패 상태를 돌려준다.
// 워크플로 두 개가 동시에 끝나 같은 PR을 두 번 머지하려 한 경우는 "duplicate"로 알린다
async function merge(token: string, repo: string, pr: PullRequest): Promise<UpdateStatus | "duplicate" | null> {
  try {
    await mergePullRequest(token, OWNER, repo, pr.number, pr.head.sha);
  } catch (error) {
    if ((await getPullRequest(token, OWNER, repo, pr.number)).merged) return "duplicate";
    console.error(error);
    return { kind: "merge-failed", reason: "GitHub이 머지를 거부했어요. PR을 확인해 주세요." };
  }
  await deleteBranch(token, OWNER, repo, pr.head.ref).catch((error) => console.error(error));
  return null;
}

async function notify(env: Env, update: UpdatePr, status: UpdateStatus): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_CHANNEL_ID) {
    console.warn("DISCORD_BOT_TOKEN·DISCORD_CHANNEL_ID가 없어 업데이트 PR 알림을 보내지 않습니다.");
    return;
  }
  await sendChannelMessage(env.DISCORD_BOT_TOKEN, env.DISCORD_CHANNEL_ID, updateMessage(update, status));
}

function packagesFor(repo: string): string[] {
  return Object.values(SOURCES)
    .filter((source) => source.consumers.includes(repo))
    .map((source) => source.packageName);
}

// package.json의 의존성 범위(^1.5.1 등)에서 버전만 꺼낸다
function dependencyVersion(packageJson: string, packageName: string): string | null {
  const manifest = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>;
  const range = manifest.dependencies?.[packageName] ?? manifest.devDependencies?.[packageName];
  return range?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

function bumpOf(from: string, to: string): Bump {
  const [fromMajor, fromMinor] = from.split(".").map(Number);
  const [toMajor, toMinor] = to.split(".").map(Number);
  if (toMajor !== fromMajor) return "major";
  // 0.x에서는 마이너도 깨지는 변경일 수 있지만, 어차피 버튼으로 받으므로 따로 나누지 않는다
  if (toMinor !== fromMinor) return "minor";
  return "patch";
}

function ephemeral(content: string): Response {
  // CHANNEL_MESSAGE_WITH_SOURCE + EPHEMERAL: 누른 사람에게만 보인다
  return Response.json({ type: 4, data: { content, flags: 64 } });
}

export type { ComponentInteraction, WorkflowRunEvent };
export { handleMergeClick, handleWorkflowRun };
