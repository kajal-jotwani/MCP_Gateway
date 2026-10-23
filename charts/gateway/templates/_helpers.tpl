{{/* Selector labels for one component. Call with (dict "root" $ "name" "<component>"). */}}
{{- define "gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}

{{- define "gateway.labels" -}}
{{ include "gateway.selectorLabels" . }}
app.kubernetes.io/part-of: gateway
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ .root.Chart.Name }}-{{ .root.Chart.Version }}
{{- end }}

{{/* A container env entry read from a Secret. Call with (list "<secret>" "ENV_NAME" "SECRET_KEY"). */}}
{{- define "gateway.secretEnv" -}}
- name: {{ index . 1 }}
  valueFrom:
    secretKeyRef:
      name: {{ index . 0 }}
      key: {{ index . 2 }}
{{- end }}

{{- define "gateway.restrictedContainer" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{/* Pod security context for the Node images, whose `node` user is uid 1000. */}}
{{- define "gateway.nodePodSecurity" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end }}
