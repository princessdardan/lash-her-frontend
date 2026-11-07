# Correction to the source-only Google project producer

Qualifies `fbb41ae95e3d6904a36084afaa43a63e74f115c7` over original `799b624d96e7ccf5efd85d6fcfb874542ca0efbd`. Original source and evidence at `../p2q-google-project-allocation-799b624d/` remain unchanged; all authority/registration/SDK/holder-recovery limitations there still apply.

Root approved a fixed pinned-Python child wrapper: isolated -I-B-S executes source-fixed os/sys code that sets umask0077, then execve of the exact pinned official gcloud launcher and its fixed arguments. The wrapper does not import or bypass SDK bootstrap, run caller code, change Node's process-wide umask, forward HOME, or select a public command. An actual owned Python subprocess executes these exact wrapper bytes against a fixed owned writer and produces a0600 file and0700 directory while Node's umask is unchanged. This is a child-mechanics test, not a real gcloud/auth/provider execution.

PrivateCase continuously rechecks CASE_ROOT0700 and original directory identities. Private raw/intent reads and writes check no-follow root-private parent directories, in addition to leaf no-follow/regular/mode/size/readback guards. A response-directory symlink is refused before writing any alternate file.

Actual Node24.18.0:20 test groups pass, zero skips; focused lint/diff check pass. Four original first-install groups remain. Exact source hashes/caps are in validation.json. No actual SDK/auth/project/IAM/provider or resource operation was executed by this producer owner. Root's separate offline SDK/Python audit remains a distinct evidence class. Cases are empty, common authority flags false, post-crash holder recovery absent.
