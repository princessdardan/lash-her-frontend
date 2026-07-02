# Platform Remediation Superpowers Index

**Source:** docs/platform-comprehensive-after-action-review.md  
**Master Spec:** docs/superpowers/specs/2026-06-05-platform-remediation-master-design.md  
**Date:** 2026-06-05

---

## Quick Navigation

| Category       | Implementation Plan                                                                                                    | AAR Issues | Priority |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| Security       | [`plans/2026-06-05-platform-security-remediation.md`](./plans/2026-06-05-platform-security-remediation.md)             | 1.1–1.7    | CRITICAL |
| Architecture   | [`plans/2026-06-05-platform-architecture-remediation.md`](./plans/2026-06-05-platform-architecture-remediation.md)     | 2.1–2.4    | HIGH     |
| Performance    | [`plans/2026-06-05-platform-performance-remediation.md`](./plans/2026-06-05-platform-performance-remediation.md)       | 3.1–3.4    | HIGH     |
| Accessibility  | [`plans/2026-06-05-platform-accessibility-remediation.md`](./plans/2026-06-05-platform-accessibility-remediation.md)   | 4.1–4.4    | CRITICAL |
| DevOps         | [`plans/2026-06-05-platform-devops-remediation.md`](./plans/2026-06-05-platform-devops-remediation.md)                 | 5.1–5.4    | CRITICAL |
| Testing        | [`plans/2026-06-05-platform-testing-remediation.md`](./plans/2026-06-05-platform-testing-remediation.md)               | 6.1–6.4    | HIGH     |
| Best Practices | [`plans/2026-06-05-platform-best-practices-remediation.md`](./plans/2026-06-05-platform-best-practices-remediation.md) | 7.1–7.3    | MEDIUM   |

---

## Master Design

The master design consolidates all seven categories into a single coherent specification with cross-cutting dependencies, rollout sequencing, and repo-specific constraints.

- [`specs/2026-06-05-platform-remediation-master-design.md`](./specs/2026-06-05-platform-remediation-master-design.md)

---

## Cross-Cutting Dependencies

Several components are shared across multiple plans. Implement them once in the earliest plan and reuse thereafter:

| Shared Component                    | Created In                                | Consumed By                                                |
| ----------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `src/middleware.ts` + CSP nonce     | Security                                  | Architecture (islands inline scripts)                      |
| `src/lib/security/request-guard.ts` | Security                                  | Performance, Architecture, Best Practices (`/api/metrics`) |
| `src/lib/logging/logger.ts`         | DevOps                                    | Security, Architecture, Performance API routes             |
| Outbox/events tables                | Architecture                              | Performance (calendar saga), DevOps (alerting)             |
| `useReducedMotion` hook             | Performance / Accessibility               | Performance, Accessibility                                 |
| CI workflow                         | DevOps                                    | Security (audit), Testing (coverage), Accessibility (axe)  |
| Sanity schema deploy pipeline       | Security / Accessibility / Best Practices | All schema-affecting plans                                 |

---

## Rollout Phases at a Glance

| Phase               | Focus                              | Key Deliverables                                                                                                      |
| ------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase 0 (Week 1)    | Hygiene + Baseline                 | Artifact cleanup, pre-commit hooks, baseline CI, lint fixes, coverage instrumentation, pool limits, migration archive |
| Phase 1 (Week 2)    | Shared Infrastructure              | Middleware, CSP report-only, request guard, outbox checkout, static hero, `AsyncState`, reduced motion, preview E2E   |
| Phase 2 (Weeks 3–4) | Runtime Hardening                  | KV rate limiting, signed nonces, link resolver + audit, token vault, event consumers, booking saga, connection proxy  |
| Phase 3 (Weeks 5–6) | UX + Bundle                        | Responsive images, LQIP, animation refactor, islands, dynamic blocks, block manifest, alt plugin, self-hosted metrics |
| Phase 4 (Weeks 7–9) | Observability + Quality Automation | OTel, alerting, backup/chaos, BFG, Codecov, Stryker, SonarQube, axe CI, editorial plugin, manual audit schedule       |

---

## Baseline Validation Commands

Every plan must pass these commands before claiming completion:

```bash
npm run lint
npm run test:unit
npm run build
npm test
```

---

## Constraints Reminder

- Sanity holds public/editorial content only. Private data belongs in PostgreSQL via `src/lib/private-db`/Drizzle.
- Sanity schema changes are source-driven under `src/sanity/schemas/**` and deployed via `npx sanity schema deploy`.
- Production schema deploy requires `SANITY_SCHEMA_DEPLOY_TARGET=production`.
- Do not store PII, transaction history, payment tokens, or live form submissions in Sanity.
- Helcim webhook URL is `/api/webhooks/card-transactions` and must not contain the string `helcim`.
