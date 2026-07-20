# CancerCulture Watchdog

Lokaler Cloudflare Module Worker für den Discord-Sync-Watchdog. Der Worker ist code-only für DEV verdrahtet und verbindet den Health-Adapter, das SQLite-backed Durable Object, die deterministische Alarmzustandsmaschine und einen kleinen Resend-Adapter.

## DEV-Architektur

`Cron → Health Adapter → Durable Object → Alarm State → Resend-Adapter`

Der Alarmzustand und die Delivery-Metadaten liegen in genau einer versionierten SQLite-Singleton-Zeile. Für DEV wird der feste Durable-Object-Schlüssel `discord-sync-watchdog:dev` verwendet. Eine vorgemerkte Notification wird vor dem Versand exklusiv geclaimt; die stabile Notification-ID bildet die Grundlage des Provider-Idempotency-Keys, während der Claim-Token ausschließlich intern bleibt.

Resend ist nur für kompakte Betreiberwarnungen an `support@cancerculture.fun` vorgesehen. Der Worker versendet keine Nutzer-Mails. Der öffentliche HTTP-Handler antwortet ausschließlich mit `404` und bietet keinen Status-, Trigger-, Reset- oder Debug-Endpunkt.

Der Cron läuft alle fünf Minuten mit `*/5 * * * *`. Deklarative DEV-Variablen sind:

- `WATCHDOG_ENVIRONMENT=dev`
- `ALERT_TO=support@cancerculture.fun`

Vor einer manuellen DEV-Einrichtung müssen folgende Secrets gesetzt werden:

- `HEALTH_ENDPOINT_URL`
- `DISCORD_SYNC_HEALTH_SECRET`
- `RESEND_API_KEY`
- `ALERT_FROM`

Im lokalen Projekt sind keine Secret-Werte, keine reale Health-URL und keine Env-Datei hinterlegt.

## Lokale Prüfung

```sh
npm test
npm run typecheck
```

Es wurde noch kein Deployment ausgeführt. Die nächsten Schritte sind ausschließlich die manuelle DEV-Einrichtung der vier Secrets, die Resend-Absenderverifizierung und anschließend ein bewusst ausgelöstes DEV-Deployment.
