# FinBud Technologies - Dry Cleaning Backend

Set `SUBSCRIPTIONS_REQUIRED=false` in the backend environment to allow all businesses to keep creating records after their trial or subscription expires. The workspace displays free access and hides renewal prompts; new subscription checkouts are rejected while this setting is false. Customer payments remain controlled separately by `ALLOW_LIVE_PAYMENTS` and `ORDER_PAYMENTS_ENABLED`.

The default is `true` when omitted (only the exact value `false` disables enforcement). Existing expiry dates and payment records are preserved. Switching back to `true` immediately restricts new records for businesses whose subscriptions have expired; it does not start a new trial.

Restart the backend after changing this setting. For the live service, set it in Render's Environment settings and redeploy; your local `.env` does not configure Render. The frontend receives this setting from the backend and needs no environment variable of its own.
