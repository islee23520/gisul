import direct from "./direct.ts";
import oauth, { type OAuthEnv } from "./oauth.ts";
export type { DirectEnv as Env } from "./direct.ts";

// Existing deployments stay token-only until OAuth is explicitly configured.
export default {
  fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext) {
    return env.GISUL_PUBLIC_URL ? oauth.fetch!(request, env, ctx) : direct.fetch(request, env);
  },
} satisfies ExportedHandler<OAuthEnv>;
