import {
  DEV_WATCHDOG_OBJECT_NAME,
  DiscordWatchdogState,
} from "./discord-watchdog-state";
import {
  DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
  probeDiscordSyncHealth,
} from "./health-probe";
import { createResendNotificationSink } from "./resend-notification-sink";
import { runWatchdogCycle } from "./watchdog-cycle";

export { DEV_WATCHDOG_OBJECT_NAME, DiscordWatchdogState };

const WATCHDOG_CRON = "*/5 * * * *";

export interface Env {
  WATCHDOG_STATE: DurableObjectNamespace<DiscordWatchdogState>;
  HEALTH_ENDPOINT_URL: string;
  DISCORD_SYNC_HEALTH_SECRET: string;
  RESEND_API_KEY: string;
  ALERT_FROM: string;
  ALERT_TO: string;
  WATCHDOG_ENVIRONMENT: "dev";
}

export default {
  scheduled(controller?: ScheduledController, env?: Env): void | Promise<void> {
    if (controller === undefined || env === undefined || controller.cron !== WATCHDOG_CRON) {
      return;
    }

    return runScheduledWatchdog(env);
  },

  fetch(): Response {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function runScheduledWatchdog(env: Env): Promise<void> {
    let notificationSink;
    try {
      notificationSink = createResendNotificationSink({
        apiKey: env.RESEND_API_KEY,
        from: env.ALERT_FROM,
        to: env.ALERT_TO,
        environment: env.WATCHDOG_ENVIRONMENT,
      });
    } catch {
      throw new Error("WATCHDOG_CRON_CONFIGURATION_ERROR");
    }

    let result;
    try {
      result = await runWatchdogCycle(
        {
          healthProbeConfig: {
            endpointUrl: env.HEALTH_ENDPOINT_URL,
            bearerSecret: env.DISCORD_SYNC_HEALTH_SECRET,
            timeoutMs: DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
          },
        },
        {
          probeHealth: probeDiscordSyncHealth,
          getWatchdogStateStub: (name) => env.WATCHDOG_STATE.getByName(name),
          nowMs: () => Date.now(),
          createIncidentId: () => crypto.randomUUID(),
          createClaimToken: () => crypto.randomUUID(),
          notificationSink,
        },
      );
    } catch {
      throw new Error("WATCHDOG_CRON_EXECUTION_ERROR");
    }

    switch (result.status) {
      case "observed_no_notification":
      case "notification_leased":
      case "delivered":
        return;
      case "probe_error":
        throw new Error("WATCHDOG_CRON_PROBE_ERROR");
      case "delivery_failed":
        throw new Error("WATCHDOG_CRON_DELIVERY_ERROR");
      case "acknowledgement_failed":
        throw new Error("WATCHDOG_CRON_ACKNOWLEDGEMENT_ERROR");
      case "failure_recording_failed":
        throw new Error("WATCHDOG_CRON_FAILURE_RECORDING_ERROR");
    }
}
