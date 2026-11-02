# Sole operator and deferred monitoring

Dardan is the sole operator for this integration. On October 29, 2026, Dardan confirmed: “I am the sole operator, Dardan” and said the required credentials would be provided later. Operator credentials, gateway DNS, regional SSH key name, operator public CIDR and current spending/headroom inputs remain pending for that later handoff. Their absence does not authorize a substitute identity or broader cloud grants.

Dardan also instructed: “Remove this as a requirement for the time being, we will implement monitoring after this plan is complete.” Operational monitoring and alerting rollout is therefore deferred to a separate follow-up after the current integration plan. No off-host service, recipient or notification test is required to complete the current plan.

- P1-08 is DEFERRED, not DONE. Preserve its prepared configuration and original acceptance work for the later follow-up.
- Remove P1-08 from G1 dependencies and operational monitoring/alert delivery from current release acceptance. The three synchronized plans and tracker reflect this change.
- Keep Prometheus and the host exporter outside the default application Compose topology. Their image pins, off-host configuration and deliveries do not block the current candidate manifest.
- Keep application readiness/health checks, safe diagnostics, audit records, controlled capacity measurements, provider/scheduler evidence, bounded recovery and database restore requirements in their existing tasks. Deferring a monitoring rollout does not remove these implementation and test requirements.
- Keep existing migration, budget, target/lineage, provenance, native scheduler/cancellation and protected release controls. P1-01/P1-02 remain DONE in their accepted scopes. No live acceptance result is created by this decision.

Use a single-operator release procedure. Dardan may initiate and explicitly approve the protected workflow; do not require an unavailable second operator or configure self-approval prevention that makes the authorized procedure impossible. No credential value, protection setting, grant, cloud resource, deployment, scheduler or notification is changed by this record.
