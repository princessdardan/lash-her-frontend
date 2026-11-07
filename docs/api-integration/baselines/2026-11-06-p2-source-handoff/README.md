# Bounded operator source handoff

The real committed source failed the former 16 MB cap because the 33 preserved historical profiles total 31,838,624 bytes. Their bytes and hashes remain unchanged. Source 88fd8abf admits at most 400 public files, 2 MB per file and 40 MB decoded; only public source-install SSH stdin admits 56 MB for base64/JSON. Private action stdin remains limited to 24 MB.

The actual 376-file handoff is 35,533,833 decoded bytes and 47,433,265 packet bytes. Ten source/SSH tests, four host closure tests, lint, the real clean committed source producer and installed-content verifier pass. Independent review found no actionable issue. The source inventory must be regenerated from the final integrated commit; this record authenticates only its recorded source.

The fixed root receiver now has required CI cases for an 18 MB successful install/readback and a 42 MB refusal before writes. Those container cases have not run locally because Docker is unavailable. No SSH, provider or staging action occurred. The original measured refusal remains retained.
