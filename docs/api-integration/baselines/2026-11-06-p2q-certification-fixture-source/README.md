# Certification host-test source fixture correction

Exact ea4 CI [42295968068](https://github.com/princessdardan/lash-her-frontend/actions/runs/42295968068) ended with eight successful jobs and failed gateway/platform plus final aggregate checks. All three browser matrix jobs, database and frontend-operator jobs passed. This is not an all-ten-job qualification. Original failed logs and controlled reproduction remain retained.

The host test previously treated installed npm metadata as operator source: 511 tracked files plus two untracked dependency JSON files exceeded the unchanged production 512-file limit before the broker was reached. The one-file correction uses the actual Git-tracked public ops selection, copied into a private installed-source fixture. Git failure has no filesystem fallback. The real production guard still rejects any extra installed selected file. It is not changed or weakened.

[Validation](validation.json) binds original source5533e9cc, integrated source790cac37, independent review and original failure evidence. Owner checks pass16parent+7closure tests; independent and integrated-root checks pass23 with zero skips. Actual root npm metadata is present. Committed source remains511files,40,857,723decoded/54,551,607public bytes under unchanged caps. PR91runtime and historical profile diffs are zero; exact published contracts verify. Fresh corrected-source Linux CI remains pending; latest all-ten pass remainsff4.

[Connected Vercel metadata](connected-vercel-scope.json) records one visible team/eight projects/no P2Q-named project. It does not enumerate other identities/providers or establish administrative/recovery isolation. Those scopes remain UNKNOWN. No provider, credential, resource, SQL, scheduler, deployment or admission action occurred.
