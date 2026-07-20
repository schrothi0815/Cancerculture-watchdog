import type { DiscordWatchdogState } from "../src/discord-watchdog-state";

declare global {
  namespace Cloudflare {
    interface Env {
      WATCHDOG_STATE: DurableObjectNamespace<DiscordWatchdogState>;
      HEALTH_ENDPOINT_URL: string;
      DISCORD_SYNC_HEALTH_SECRET: string;
      RESEND_API_KEY: string;
      ALERT_FROM: string;
      ALERT_TO: string;
      WATCHDOG_ENVIRONMENT: "dev";
    }
  }
}

export {};
