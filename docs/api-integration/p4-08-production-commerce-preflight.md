# Ontario Course commerce qualification

## Payment scope

On November 23 the owner approved card-only Course checkout in Ontario, priced in CAD with 13% HST for the approved classification. Afterpay and GST/HST registration verification were deferred. Production sales require separate approval.

## Acceptance evidence

| Source | Recorded result |
| --- | --- |
| `192636de` | Protected card checkout and exact-order support passed. Recovery delivered pending Course access. |
| `bf892bba` | The protected purchase recorded the agreement version and issued the tax receipt. |
| `85f97820` | An isolated full refund produced the HST adjustment and revoked the purchase grant. |
| `1c459407` | The itemized Square Sandbox order and its payment agreed on the total and HST. The buyer confirmation linked to the Square receipt. |

The protected source used migrations through `0086`. The qualification applies to the isolated fixtures and the tested offer. The shared database still requires the reviewed writer fence and migration procedure before release.
