import { DISPATCH_EVENT, OWNER, SOURCES } from "./config";
import { notifyRelease } from "./discord";
import type { Env } from "./env";
import { createAppJwt, createInstallationToken, dispatch } from "./github";
import { type ComponentInteraction, handleMergeClick, handleWorkflowRun, type WorkflowRunEvent } from "./updates";
import { verifyDiscordSignature, verifySignature } from "./verify";

type ReleaseEvent = {
  action: string;
  release: { tag_name: string; html_url: string; body: string | null; prerelease: boolean };
  repository: { full_name: string };
  installation: { id: number };
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method !== "POST") return new Response("passu-release-bot", { status: 200 });

    const body = await request.text();
    // Discord 앱 설정의 Interactions Endpoint URL은 /discord로 등록한다
    if (new URL(request.url).pathname === "/discord") return handleDiscord(env, request, body, ctx);

    if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("X-Hub-Signature-256")))) {
      return new Response("invalid signature", { status: 401 });
    }

    // GitHub 웹훅은 10초 안에 응답해야 하므로 먼저 응답하고 나머지는 백그라운드에서 처리한다.
    switch (request.headers.get("X-GitHub-Event")) {
      case "release": {
        const event = JSON.parse(body) as ReleaseEvent;
        const source = SOURCES[event.repository.full_name];
        if (event.action !== "published" || !source) break;
        ctx.waitUntil(handleRelease(env, event, source.packageName, source.consumers));
        return new Response("accepted", { status: 202 });
      }
      case "workflow_run": {
        const event = JSON.parse(body) as WorkflowRunEvent;
        if (event.action !== "completed") break;
        ctx.waitUntil(handleWorkflowRun(env, event).catch((error) => console.error(error)));
        return new Response("accepted", { status: 202 });
      }
    }
    return new Response("ignored", { status: 202 });
  },
} satisfies ExportedHandler<Env>;

async function handleDiscord(env: Env, request: Request, body: string, ctx: ExecutionContext): Promise<Response> {
  const valid =
    env.DISCORD_PUBLIC_KEY &&
    (await verifyDiscordSignature(
      env.DISCORD_PUBLIC_KEY,
      body,
      request.headers.get("X-Signature-Ed25519"),
      request.headers.get("X-Signature-Timestamp"),
    ));
  if (!valid) return new Response("invalid signature", { status: 401 });

  const interaction = JSON.parse(body) as { type: number } & ComponentInteraction;
  // PING: Discord가 엔드포인트를 등록할 때 보낸다
  if (interaction.type === 1) return Response.json({ type: 1 });
  // MESSAGE_COMPONENT: 버튼 클릭
  if (interaction.type === 3) return handleMergeClick(env, interaction, ctx);
  return new Response("unsupported interaction", { status: 400 });
}

async function handleRelease(env: Env, event: ReleaseEvent, packageName: string, consumers: string[]): Promise<void> {
  const version = event.release.tag_name.replace(/^v/, "");
  // 프리릴리스는 알림만 보내고 앱 레포에는 반영하지 않는다.
  const targets = event.release.prerelease ? [] : consumers;

  const results = await Promise.allSettled([
    notifyRelease(env.DISCORD_WEBHOOK_URL, {
      packageName,
      version,
      releaseUrl: event.release.html_url,
      notes: event.release.body ?? "",
      consumers: targets,
    }),
    requestUpdates(env, event.installation.id, targets, { package: packageName, version, release_url: event.release.html_url }),
  ]);

  for (const result of results) {
    if (result.status === "rejected") console.error(result.reason);
  }
}

async function requestUpdates(env: Env, installationId: number, repos: string[], payload: object): Promise<void> {
  if (repos.length === 0) return;

  const jwt = await createAppJwt(env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_PRIVATE_KEY);
  // repository_dispatch는 Contents 쓰기 권한이 필요하다.
  const token = await createInstallationToken(jwt, installationId, repos, { contents: "write" });

  const results = await Promise.allSettled(repos.map((repo) => dispatch(token, OWNER, repo, DISPATCH_EVENT, payload)));
  for (const result of results) {
    if (result.status === "rejected") console.error(result.reason);
  }
}
