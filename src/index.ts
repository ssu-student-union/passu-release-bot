import { DISPATCH_EVENT, OWNER, SOURCES } from "./config";
import { notifyRelease } from "./discord";
import { createAppJwt, createInstallationToken, dispatch } from "./github";
import { verifySignature } from "./verify";

type Env = {
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  DISCORD_WEBHOOK_URL: string;
};

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
    if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("X-Hub-Signature-256")))) {
      return new Response("invalid signature", { status: 401 });
    }

    if (request.headers.get("X-GitHub-Event") !== "release") return new Response("ignored", { status: 202 });

    const event = JSON.parse(body) as ReleaseEvent;
    const source = SOURCES[event.repository.full_name];
    if (event.action !== "published" || !source) return new Response("ignored", { status: 202 });

    // GitHub 웹훅은 10초 안에 응답해야 하므로 먼저 응답하고 나머지는 백그라운드에서 처리한다.
    ctx.waitUntil(handleRelease(env, event, source.packageName, source.consumers));
    return new Response("accepted", { status: 202 });
  },
} satisfies ExportedHandler<Env>;

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
