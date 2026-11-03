"""Docker uses strict Go-template map access; Health is optional on TLS proxies."""
HEALTH_STATUS = '{{with (index .State "Health")}}{{.Status}}{{else}}none{{end}}'
RUNTIME_FIELDS = '{{.Image}}|{{.State.Running}}|' + HEALTH_STATUS + '|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}'
RECOVERY_FIELDS = '{{.State.Running}}|' + HEALTH_STATUS
WATCHDOG_FIELDS = '{{json .Config.Labels}}|' + HEALTH_STATUS
