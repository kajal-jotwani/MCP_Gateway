{{/* Selector labels for one component. Call with (dict "root" $ "name" "<component>"). */}}
{{- define "store.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}

{{- define "store.labels" -}}
{{ include "store.selectorLabels" . }}
app.kubernetes.io/part-of: store
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ .root.Chart.Name }}-{{ .root.Chart.Version }}
{{- end }}

{{/* A container env entry read from the credentials Secret. Call with (list $ "ENV_NAME" "SECRET_KEY"). */}}
{{- define "store.secretEnv" -}}
- name: {{ index . 1 }}
  valueFrom:
    secretKeyRef:
      name: {{ (index . 0).Values.credentialsSecret }}
      key: {{ index . 2 }}
{{- end }}

{{/*
Environment for the official WordPress image's wp-config-docker.php, shared by the WordPress
Deployment and the setup Job so both load the same configuration. The salts come from the Secret
so sessions and cart cookies survive pod restarts.
*/}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: mariadb
- name: WORDPRESS_DB_NAME
  value: wordpress
- name: WORDPRESS_DB_USER
  value: wordpress
{{ include "store.secretEnv" (list . "WORDPRESS_DB_PASSWORD" "MARIADB_PASSWORD") }}
{{- range list "AUTH_KEY" "SECURE_AUTH_KEY" "LOGGED_IN_KEY" "NONCE_KEY" "AUTH_SALT" "SECURE_AUTH_SALT" "LOGGED_IN_SALT" "NONCE_SALT" }}
{{ include "store.secretEnv" (list $ (printf "WORDPRESS_%s" .) (printf "WORDPRESS_%s" .)) }}
{{- end }}
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ .Values.store.url }}');
    define('WP_SITEURL', '{{ .Values.store.url }}');
    // Versions are pinned in the chart; WordPress must not update itself or its plugins.
    define('AUTOMATIC_UPDATER_DISABLED', true);
    define('DISALLOW_FILE_EDIT', true);
    // The setup Job installs WordPress with WP-CLI. Until it has, every page redirects to the web
    // installer, which would let whoever finds the site first create the admin account.
    if (!defined('WP_CLI') && str_ends_with($_SERVER['SCRIPT_NAME'] ?? '', '/wp-admin/install.php')) {
      http_response_code(403);
      exit('The store is set up by its Helm chart.');
    }
{{- end }}

{{- define "store.restrictedContainer" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: ["ALL"]
{{- end }}

{{/*
Volume roots are created root-owned (local-path directories, emptyDir), and fsGroup does not
apply to local-path volumes, while WordPress and WP-CLI run as www-data (uid 33) and must own the
roots they copy into. This init container is the only step in the chart that runs as root, and it
can do nothing but change ownership. Call with (list $ (dict "name" <volume> "path" <mountPath>) ...).
*/}}
{{- define "store.volumeOwnerInit" -}}
- name: volume-owner
  image: {{ (index . 0).Values.images.wordpress }}
  command:
    - chown
    - "33:33"
    {{- range $mount := rest . }}
    - {{ $mount.path }}
    {{- end }}
  securityContext:
    runAsNonRoot: false
    runAsUser: 0
    allowPrivilegeEscalation: false
    capabilities:
      drop: ["ALL"]
      add: ["CHOWN"]
  resources:
    requests: { cpu: 10m, memory: 16Mi }
    limits: { cpu: 100m, memory: 64Mi }
  volumeMounts:
    {{- range $mount := rest . }}
    - name: {{ $mount.name }}
      mountPath: {{ $mount.path }}
    {{- end }}
{{- end }}
