#!/usr/bin/env python3
"""Validate the actual host template and rejection fixtures with an existing Guard binary."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--guard", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Fresh output required")
    root = Path(__file__).resolve().parent
    version = subprocess.run([str(args.guard), "--version"], check=True, capture_output=True, text=True, timeout=20).stdout.strip()
    if version != "cfn-guard 3.2.1":
        raise ValueError("Reviewed Guard 3.2.1 required")
    template, rules = root / "lightsail-access-recovery.cfn.json", root / "lightsail-access-recovery.guard"
    original = json.loads(template.read_text())

    def validate(path):
        result = subprocess.run([str(args.guard), "validate", "--rules", str(rules), "--data", str(path),
                                 "--output-format", "json", "--show-summary", "none"], capture_output=True, text=True, timeout=30)
        value = json.loads(result.stdout)
        if result.stderr or result.returncode not in (0, 19):
            raise ValueError("Guard invocation failed")
        return result.returncode, value

    code, actual = validate(template)
    if code != 0 or actual.get("status") != "PASS" or set(actual.get("compliant", [])) != {
        "dedicated_stateless_host", "only_gateway_https_and_restricted_ssh", "address_belongs_to_this_host", "staging_only_managed_browser_access"
    }:
        raise ValueError("Actual host policy failed")
    cases = []

    def change(name, mutate):
        value = copy.deepcopy(original)
        mutate(value)
        cases.append((name, value))

    change("broad-ssh", lambda v: v["Resources"]["ApiHost"]["Properties"]["Networking"]["Ports"][0].update(Cidrs=["0.0.0.0/0"]))
    change("ipv6-ingress", lambda v: v["Resources"]["ApiHost"]["Properties"]["Networking"]["Ports"][1].update(Ipv6Cidrs=["::/0"]))
    change("backend-port-publication", lambda v: v["Resources"]["ApiHost"]["Properties"]["Networking"]["Ports"].append(
        {"Protocol": "tcp", "FromPort": 4000, "ToPort": 4000, "Cidrs": ["0.0.0.0/0"], "Ipv6Cidrs": []}))
    change("allocation-conditioned-away", lambda v: v["Resources"]["GatewayAddress"].update(Condition="HostPresent"))
    change("unconditional-compute", lambda v: v["Resources"]["ApiHost"].pop("Condition"))
    change("wrong-attachment", lambda v: v["Resources"]["GatewayAddress"]["Properties"].update(AttachedTo={"Ref": "OtherHost"}))
    change("default-retirement", lambda v: v["Parameters"]["HostState"].update(Default="absent"))
    change("unconditional-host-output", lambda v: v["Outputs"]["InstanceArn"].pop("Condition"))
    change("conditional-address-output", lambda v: v["Outputs"]["GatewayIpv4"].update(Condition="HostPresent"))
    change("literal-key-default", lambda v: v["Parameters"]["KeyPairName"].update(Default="fixture"))
    change("production-recovery", lambda v: v["Parameters"]["Environment"].update(AllowedValues=["staging", "production"]))
    change("browser-alias-left-on-by-default", lambda v: v["Parameters"]["BrowserSshAccess"].update(Default="true"))
    change("uncontrolled-browser-alias", lambda v: v["Resources"]["ApiHost"]["Properties"]["Networking"]["Ports"][0].update(CidrListAliases=["lightsail-connect"]))
    change("https-browser-alias", lambda v: v["Resources"]["ApiHost"]["Properties"]["Networking"]["Ports"][1].update(CidrListAliases=["lightsail-connect"]))
    negatives = []
    with tempfile.TemporaryDirectory(prefix="lash-her-host-policy-") as directory:
        for name, value in cases:
            path = Path(directory) / (name + ".json")
            path.write_text(json.dumps(value))
            code, result = validate(path)
            if code != 19 or result.get("status") != "FAIL" or not result.get("not_compliant"):
                raise ValueError("Negative policy fixture did not fail: " + name)
            negatives.append({"case": name, "rejected": True})
    receipt = {"status": "ACCESS_RECOVERY_TEMPLATE_GUARD_PASS", "version": version,
               "templateSha256": hashlib.sha256(template.read_bytes()).hexdigest(),
               "rulesSha256": hashlib.sha256(rules.read_bytes()).hexdigest(),
               "binarySha256": hashlib.sha256(args.guard.read_bytes()).hexdigest(),
               "rulesPassed": actual["compliant"], "negativeCases": negatives,
               "infrastructureChanged": False}
    with args.output.open("x") as stream:
        stream.write(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"status": receipt["status"], "rulesPassed": len(receipt["rulesPassed"]), "negativeCasesRejected": len(negatives)}))


if __name__ == "__main__":
    main()
