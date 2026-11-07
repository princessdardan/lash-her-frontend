"""Read-only observation of the exact reviewed existing host gateway.

No Compose up/restart, state-file write, timer/scheduler or provider mutation.
"""
import json
from pathlib import Path
import re

import docker_inspect
import migrate
import release as runtime

demand = migrate.demand


def observe(configuration, reviewed, verify, command=None, assert_host=None):
    command = command or runtime.command
    assert_host = assert_host or runtime.assert_host
    configuration = Path(configuration)
    migrate.private_directory(configuration)
    verify(); assert_host({"hostMachineId": reviewed["hostMachineId"]}); verify()
    runtime_raw = migrate.read_input(configuration, "runtime.json", 65_536)
    gateway_raw = migrate.read_input(configuration, "gateway.json", 65_536)
    demand(migrate.file_hash(runtime_raw) == reviewed["runtimeConfigurationSha256"] and
        migrate.file_hash(gateway_raw) == reviewed["gatewayConfigurationSha256"], "RESTORATION_GATEWAY_CONFIGURATION_CHANGED")
    target, gateway = json.loads(runtime_raw), json.loads(gateway_raw)
    demand(target.get("environment") == "staging" and target.get("releaseId") == reviewed["releaseId"] and
        target.get("hostMachineId") == reviewed["hostMachineId"] and gateway.get("appEnv") == "staging" and
        gateway.get("admission") == {"file": "/admission/state.json", "releaseId": reviewed["releaseId"], "candidateSha256": reviewed["candidateSha256"]},
        "RESTORATION_GATEWAY_SOURCE_BINDING_REFUSED")
    image = reviewed["gatewayImage"]
    demand(isinstance(image, str) and re.fullmatch(r"ghcr.io/princessdardan/lash-her-platform-gateway@sha256:[a-f0-9]{64}", image), "RESTORATION_GATEWAY_IMAGE_REFUSED")
    def run(args):
        verify(); result = command(args, runtime.SAFE_ENV, 5); verify(); return result
    ids = run(["docker", "container", "ls", "--all", "--filter", "label=com.docker.compose.project=lash-her-staging", "--filter",
        "label=com.docker.compose.service=gateway", "--format", "{{.ID}}", "--no-trunc"]).split()
    demand(len(ids) == 1 and re.fullmatch(r"[a-f0-9]{64}", ids[0]), "RESTORATION_EXACT_GATEWAY_REPLICA_REQUIRED")
    container = ids[0]
    local = run(["docker", "image", "inspect", "--platform", "linux/amd64", "--format", "{{.Id}}", image])
    actual = run(["docker", "inspect", "--format", docker_inspect.RUNTIME_FIELDS, container]).split("|")
    demand(actual == [local, "true", "healthy", "lash-her-staging", "gateway"] and re.fullmatch(r"sha256:[a-f0-9]{64}", local),
        "RESTORATION_GATEWAY_HEALTH_OR_IMAGE_CHANGED")
    mounts = json.loads(run(["docker", "inspect", "--format", "{{json .Mounts}}", container]))
    demand(isinstance(mounts, list), "RESTORATION_GATEWAY_MOUNTS_REFUSED")
    for destination, source in (("/config/gateway.json", configuration / "gateway.json"), ("/admission", configuration / "admission")):
        selected = [item for item in mounts if item.get("Destination") == destination]
        demand(len(selected) == 1 and selected[0].get("Type") == "bind" and selected[0].get("Source") == str(source) and selected[0].get("RW") is False,
            "RESTORATION_GATEWAY_MOUNT_CHANGED")
    before = migrate.read_input(configuration, "admission/state.json", 4096)
    value = json.loads(run(["docker", "exec", container, "node", "--input-type=module", "--eval",
        'const r=await fetch("http://127.0.0.1:9100/admission");if(!r.ok)process.exit(1);process.stdout.write(await r.text())']))
    after = migrate.read_input(configuration, "admission/state.json", 4096)
    state = json.loads(after)
    demand(before == after and isinstance(state, dict) and set(state) == {"version", "environment", "releaseId", "candidateSha256", "actionId", "newWork", "recovery"} and
        state.get("version") == 1 and state.get("environment") == "staging" and state.get("releaseId") == reviewed["releaseId"] and
        state.get("candidateSha256") == reviewed["candidateSha256"] and type(state.get("newWork")) is bool and type(state.get("recovery")) is bool and
        isinstance(state.get("actionId"), str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", state["actionId"]) and
        isinstance(value, dict) and value.get("valid") is True and value.get("sha256") == migrate.file_hash(after) and
        all(value.get(key) == selected for key, selected in state.items()), "RESTORATION_GATEWAY_ADMISSION_ACK_REFUSED")
    for field in ("active", "uncertain"):
        demand(isinstance(value.get(field), dict) and set(value[field]) == {"newWork", "recovery"} and
            all(type(count) is int and count >= 0 for count in value[field].values()), "RESTORATION_GATEWAY_COUNTS_REQUIRED")
    verify()
    return {"status": "FRONTEND_RESTORATION_GATEWAY_OBSERVED", "binding": reviewed, "containerId": container,
        "admission": {**state, "sha256": value["sha256"], "active": value["active"], "uncertain": value["uncertain"]}, "gatewayMutated": False}
