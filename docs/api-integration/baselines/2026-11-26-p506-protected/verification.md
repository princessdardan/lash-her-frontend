# P5-06 protected staging verification

On November 26, 2026 in Toronto, Chromium exercised the ported customer and owner-moderator Community routes on the isolated candidate on `lash-her-api-staging-host`. The Vercel deployment `dpl_Hq5J7gCLWxQ9A9HXQ3Qj8taHvYv9` was protected and used an isolated gateway, PostgreSQL cluster and private media storage binding. The browser used five fresh candidate-issued synthetic sessions for an enrolled learner, enrolled peer, unenrolled customer, employee and owner moderator.

| Component | Qualified source and release evidence |
| --- | --- |
| Frontend | `4d217a2c59615915d1df71c89c84b4402e05fc56`. [Exact staging CI](https://github.com/princessdardan/lash-her-frontend/actions/runs/45926577876) · [Signed platform publication, attempt 1](https://github.com/princessdardan/lash-her-frontend/actions/runs/45928225700) |
| Course | `31e773262caae41ff3931222c8aabbc75547ca88`. [PR #15](https://github.com/princessdardan/lash-her-course-api/pull/15) · [Exact main CI](https://github.com/princessdardan/lash-her-course-api/actions/runs/45714086210) |
| Community | `fc112ae6516c282ca73bf69efb82c74a9d007ade`. [PR #12](https://github.com/princessdardan/lash-her-community-api/pull/12) · [Exact main CI](https://github.com/princessdardan/lash-her-community-api/actions/runs/45714901701) |

Activation `p5-06-4d217a2c-45928225700` used signed release `p1-45928225700-1`. The verified release manifest SHA-256 is `a94b4c7618f13a1df2352e66c195d33bcdf6be1d535df1d2c33e83628c930711`. [Integrated API contract, PR #122](https://github.com/princessdardan/lash-her-frontend/pull/122)

## Writer admission and connection retirement

The first hosted attempt reproduced PostgreSQL `55P03` at the writer-admission `FOR UPDATE NOWAIT` before the write effect started. PR #132 added a bounded retry for that explicit P5-06 admission refusal using the same operation ID and epoch. The next hosted attempt reached the relay's eight-connection cap during requests to the moderation page. An exact local relay rehearsal confirmed HTTP 503 before a backend dial when the relay was at capacity. PR #133 limited the P5-06 frontend pool to two connections, retired each connection after checkout, and bounded retries to HTTP 503 before the WebSocket opened. The last hosted run passed the employee moderation-page denial and peaked at three established PostgreSQL backend connections in 80 relay samples. [Writer admission fix, PR #132](https://github.com/princessdardan/lash-her-frontend/pull/132) · [Connection retirement fix, PR #133](https://github.com/princessdardan/lash-her-frontend/pull/133)

The two requested operations from the first cluster and two later operations from the second cluster remain recorded as uncertain. The observed database and gateway state could not establish whether each write committed. Both earlier candidate volumes and their ledger records were preserved behind closed admissions.

## Hosted Chromium checks

| Check | Observed result |
| --- | --- |
| Discussions and owner moderation | The enrolled learner and peer could open the synthetic discussion. The owner moderator could resolve its report and hide and restore the discussion. Customer and employee moderation requests were denied. Missing CSRF and foreign origin writes were denied. |
| Private images | The enrolled peer uploaded a PNG, viewed the processed image using a signed URL, and removed it. A fresh view request returned HTTP 404. |
| Notifications | Preference changes persisted and the run restored the original values. Replaying the identical reply created one reply and one recipient notification. The notice stayed read and the sender received no copy. |
| Directory and member profiles | The enrolled learner could search and open the peer's profile. The unenrolled customer received HTTP 403 for the directory, profile and discussion. |
| Mobile keyboard | The learner reached the directory and member profile by keyboard without horizontal overflow. The owner moderator used keyboard controls to reach the report and moderation actions. |

A Course-only outage returned private HTTP 503 and hid discussion content in Chromium. The discussion returned after Course recovered. With the publisher paused and the Community projection still active, a committed Course revocation returned private HTTP 403 and hid the discussion from the revoked learner. The enrolled peer kept access. Restoring the grant and resuming the publisher brought the projection current and restored the learner's access.

| Sanitized receipt | SHA-256 |
| --- | --- |
| Five session role checks | `22d134489f1b1afb44701726a1fd02b60e9a64f95c06bdaa661a8275fd4521a5` |
| Main Chromium run | `24cef5e612cea9dde9218e69c3c20901832110613d6fb38dccdfa4abacc45d94` |
| Exact reply replay | `59bae9f568c484611d887d97239900110f90f9fd64ba3f774b59a7b1ae96d766` |
| Course unavailable | `483181a6728d47c8daea10ff6a4af303062ba7b995fb290ae5e44a79ca375db9` |
| Stale-projection control | `113c9b31b6ce0d320d3b26ba2ae17b83f5185876e457f4c83158af918d628bbb` |
| Course revoked | `2fac823c044de13b0bb025f752b04eb0e0c495e354cd05eb56932daa083e8ff7` |
| Course recovered after outage and after revocation | `41dee523c351806bab74fe62dd9124c9d0bb3e57012daf8db89c83bb6f016eb6` for each pass |

## Candidate postflight

Both gateway admission flags closed and the gateway drained. The writer reached closed epoch 3 with new work and recovery disabled, zero active operations and zero uncertain operations.

| Sanitized receipt | SHA-256 |
| --- | --- |
| Gateway close and drain | `9f2a57eba1ff6f0ae689c3fc89a9325e569cef68b10cd41ce0266f1b3fb2e5cf` |
| Writer close and drain | `71da469772584fa6de8ff7b5d55629ebd5da948b90b48212afc79a3758ce2831` |
| Independent closed writer observation | `b390b6812be2eaeb31d57e358988ca508651181b99157b808b0427bbed24909b` |
| Five-session retirement and migration-role hold | `290cbaf2e9a693e947451beb8466b939fd31b7af652fbe18016498f99b8783ec` |
| Post-retirement deployment protection and alias readback | `c6dad4f5c6c0baa1791a16c7ea753b2d7f328f4027f8866a0d68b17a67a13e2a` |
| Candidate service stop and loopback withdrawal | `eec3df3fccfcfdd6e53092210fe0e8b066b921537a94526a8b79e72411eab455` |
| Single idle Course client disconnect | `4c1888e7c96e03b118df255ef6df92ca37068870bfef8e061444181f424c129b` |
| Database roles held and PostgreSQL stopped | `01591def80123f6902064b1139990debcf1aec3f37605f5aa046c6954d203a24` |

All five synthetic sessions were retired. All nine candidate services exited cleanly and the candidate loopback listener was withdrawn. After verifying that one idle Course client had no transaction or running owner, the operator disconnected it before holding all eight scoped database roles and stopping the candidate PostgreSQL instance. The candidate volumes and ledger evidence were preserved. The canonical staging alias still pointed to the shared deployment, and the candidate still required Vercel SSO.
