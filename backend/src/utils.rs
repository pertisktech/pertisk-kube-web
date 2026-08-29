use axum::http::{Request, Uri};
use futures_util::future::join_all;
use kube::{
    api::ListParams,
    config::{KubeConfigOptions, Kubeconfig},
    core::{ApiResource, DynamicObject, GroupVersionKind},
    Api, Client, Config,
};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI8, Ordering};
use tokio::time::{timeout, Duration};
use tracing::warn;

// 0 = unknown, 1 = available, -1 = unavailable
static METRICS_API_STATE: AtomicI8 = AtomicI8::new(0);

fn metrics_api_unavailable_error(err: &kube::Error) -> bool {
    match err {
        kube::Error::Api(resp) => resp.code == 404,
        _ => {
            let text = err.to_string().to_ascii_lowercase();
            text.contains("404") || text.contains("page not found")
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct NodeDiskMetrics {
    pub used_bytes: f64,
    pub capacity_bytes: f64,
}

pub fn format_compact_duration(seconds: i64) -> String {
    if seconds < 60 {
        return format!("{}s", seconds);
    }

    if seconds < 3600 {
        return format!("{}m", seconds / 60);
    }

    if seconds < 86_400 {
        return format!("{}h", seconds / 3600);
    }

    format!("{}d", seconds / 86_400)
}

pub fn parse_cpu_millicores(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Handle millicore format: "5m" -> 5
    if let Some(number) = trimmed.strip_suffix('m') {
        return number.parse::<f64>().ok();
    }

    // Handle nanosecond format: "1063320n" -> 1.06332 millicores
    if let Some(number) = trimmed.strip_suffix('n') {
        return number.parse::<f64>().ok().map(|nanos| nanos / 1_000_000.0);
    }

    // Handle microsecond format: "1234u" -> 1.234 millicores
    if let Some(number) = trimmed.strip_suffix('u') {
        return number.parse::<f64>().ok().map(|micros| micros / 1000.0);
    }

    // Handle raw cores: "0.5" -> 500 millicores
    trimmed.parse::<f64>().ok().map(|cores| cores * 1000.0)
}

pub fn parse_memory_bytes(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let unit_start = trimmed
        .find(|char: char| !char.is_ascii_digit() && char != '.')
        .unwrap_or(trimmed.len());

    let (number_part, unit_part) = trimmed.split_at(unit_start);
    let number = number_part.parse::<f64>().ok()?;

    let factor = match unit_part {
        "" => 1.0,
        "Ki" => 1024.0,
        "Mi" => 1024.0_f64.powi(2),
        "Gi" => 1024.0_f64.powi(3),
        "Ti" => 1024.0_f64.powi(4),
        "K" | "k" => 1000.0,
        "M" => 1000.0_f64.powi(2),
        "G" => 1000.0_f64.powi(3),
        "T" => 1000.0_f64.powi(4),
        "n" => 1.0 / 1_000_000_000.0,
        "u" => 1.0 / 1_000_000.0,
        "m" => 1.0 / 1000.0,
        _ => return None,
    };

    Some(number * factor)
}

pub fn format_millicores(value: f64) -> String {
    if value < 1000.0 {
        return format!("{}m", value.round() as i64);
    }

    let cores = value / 1000.0;
    if (cores.fract()).abs() < f64::EPSILON {
        format!("{}", cores as i64)
    } else {
        format!("{cores:.2}").trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

pub fn format_binary_bytes(bytes: f64) -> String {
    let units = ["B", "Ki", "Mi", "Gi", "Ti"];
    let mut value = bytes;
    let mut index = 0;

    while value >= 1024.0 && index < units.len() - 1 {
        value /= 1024.0;
        index += 1;
    }

    if value >= 10.0 {
        format!("{value:.0}{}", units[index])
    } else {
        format!("{value:.1}{}", units[index]).replace(".0", "")
    }
}

pub async fn fetch_pod_metrics(client: Client) -> HashMap<(String, String), (String, String)> {
    let mut metrics_map: HashMap<(String, String), (String, String)> = HashMap::new();

    if METRICS_API_STATE.load(Ordering::Relaxed) == -1 {
        return metrics_map;
    }

    let pod_metrics_resource =
        ApiResource::from_gvk(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "PodMetrics"));
    let metrics_api: Api<DynamicObject> = Api::all_with(client, &pod_metrics_resource);

    let metrics_list = match metrics_api.list(&ListParams::default()).await {
        Ok(list) => {
            METRICS_API_STATE.store(1, Ordering::Relaxed);
            list
        }
        Err(err) => {
            if metrics_api_unavailable_error(&err) {
                let prev = METRICS_API_STATE.swap(-1, Ordering::Relaxed);
                if prev != -1 {
                    warn!("metrics.k8s.io API unavailable ({}); disabling metrics probes", err);
                }
            }
            return metrics_map;
        }
    };

    for metric in metrics_list.items {
        let namespace = metric.metadata.namespace.clone().unwrap_or_default();
        let name = metric.metadata.name.clone().unwrap_or_default();
        if namespace.is_empty() || name.is_empty() {
            continue;
        }

        let metric_value = match serde_json::to_value(&metric) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let containers = match metric_value.get("containers").and_then(|value| value.as_array()) {
            Some(containers) => containers,
            None => continue,
        };

        let mut cpu_millicores_total = 0.0;
        let mut memory_bytes_total = 0.0;
        let mut has_cpu = false;
        let mut has_memory = false;

        for container in containers {
            if let Some(cpu_value) = container
                .get("usage")
                .and_then(|value| value.get("cpu"))
                .and_then(|value| value.as_str())
                .and_then(parse_cpu_millicores)
            {
                has_cpu = true;
                cpu_millicores_total += cpu_value;
            }

            if let Some(memory_value) = container
                .get("usage")
                .and_then(|value| value.get("memory"))
                .and_then(|value| value.as_str())
                .and_then(parse_memory_bytes)
            {
                has_memory = true;
                memory_bytes_total += memory_value;
            }
        }

        let cpu = if has_cpu {
            format_millicores(cpu_millicores_total)
        } else {
            "-".to_string()
        };

        let memory = if has_memory {
            format_binary_bytes(memory_bytes_total)
        } else {
            "-".to_string()
        };

        metrics_map.insert((namespace, name), (cpu, memory));
    }

    metrics_map
}

pub async fn fetch_node_metrics(client: Client) -> HashMap<String, (String, String)> {
    let mut metrics_map: HashMap<String, (String, String)> = HashMap::new();

    if METRICS_API_STATE.load(Ordering::Relaxed) == -1 {
        return metrics_map;
    }

    let node_metrics_resource =
        ApiResource::from_gvk(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "NodeMetrics"));
    let metrics_api: Api<DynamicObject> = Api::all_with(client, &node_metrics_resource);

    let metrics_list = match metrics_api.list(&ListParams::default()).await {
        Ok(list) => {
            METRICS_API_STATE.store(1, Ordering::Relaxed);
            list
        }
        Err(err) => {
            if metrics_api_unavailable_error(&err) {
                let prev = METRICS_API_STATE.swap(-1, Ordering::Relaxed);
                if prev != -1 {
                    warn!("metrics.k8s.io API unavailable ({}); disabling metrics probes", err);
                }
            }
            return metrics_map;
        }
    };

    for metric in metrics_list.items {
        let name = metric.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }

        let metric_value = match serde_json::to_value(&metric) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let cpu = metric_value
            .get("usage")
            .and_then(|value| value.get("cpu"))
            .and_then(|value| value.as_str())
            .and_then(parse_cpu_millicores)
            .map(format_millicores)
            .unwrap_or_else(|| "-".to_string());

        let memory = metric_value
            .get("usage")
            .and_then(|value| value.get("memory"))
            .and_then(|value| value.as_str())
            .and_then(parse_memory_bytes)
            .map(format_binary_bytes)
            .unwrap_or_else(|| "-".to_string());

        metrics_map.insert(name, (cpu, memory));
    }

    metrics_map
}

pub async fn fetch_node_disk_metrics(
    client: Client,
    node_names: &[String],
) -> HashMap<String, NodeDiskMetrics> {
    let responses = join_all(node_names.iter().cloned().map(|name| {
        let client = client.clone();
        async move {
            let request = match Request::get(format!("/api/v1/nodes/{name}/proxy/stats/summary"))
                .body(Vec::new())
            {
                Ok(request) => request,
                Err(_) => return None,
            };

            let summary = match client.request::<serde_json::Value>(request).await {
                Ok(summary) => summary,
                Err(_) => return None,
            };

            let fs = summary.get("node").and_then(|node| node.get("fs"))?;
            let used_bytes = fs
                .get("usedBytes")
                .and_then(|value| value.as_f64().or_else(|| value.as_u64().map(|value| value as f64)))?;
            let capacity_bytes = fs
                .get("capacityBytes")
                .and_then(|value| value.as_f64().or_else(|| value.as_u64().map(|value| value as f64)))
                .unwrap_or(0.0);

            Some((
                name,
                NodeDiskMetrics {
                    used_bytes,
                    capacity_bytes,
                },
            ))
        }
    }))
    .await;

    responses.into_iter().flatten().collect()
}

// ─── Placeholder / dynamic kube client loading ───────────────────────────────

const EXEC_PROVIDER_LOAD_TIMEOUT: Duration = Duration::from_secs(25);
const EXEC_PROVIDER_RESOLVE_TIMEOUT: Duration = Duration::from_secs(8);
const EXEC_PROVIDER_BACKGROUND_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Default)]
pub struct KubeClientStatus {
    pub is_placeholder: bool,
    pub user_message: Option<String>,
}

pub fn default_kubeconfig_path() -> PathBuf {
    if let Ok(raw) = env::var("KUBECONFIG") {
        if let Some(first) = raw
            .split(':')
            .map(str::trim)
            .find(|segment| !segment.is_empty())
        {
            return PathBuf::from(first);
        }
    }

    if let Ok(home) = env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join(".kube/config");
        }
    }

    PathBuf::from("/var/lib/pertisk-kube/kubeconfig")
}

fn has_accessible_kubeconfig() -> bool {
    let configured_paths = env::var("KUBECONFIG")
        .ok()
        .map(|raw| {
            raw.split(':')
                .map(str::trim)
                .filter(|segment| !segment.is_empty())
                .map(PathBuf::from)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if !configured_paths.is_empty() {
        return configured_paths.iter().any(|path| path.exists());
    }

    default_kubeconfig_path().exists()
}

fn default_placeholder_user_message() -> String {
    let has_incluster_env = env::var("KUBERNETES_SERVICE_HOST").is_ok()
        && env::var("KUBERNETES_SERVICE_PORT").is_ok();

    if !has_incluster_env && !has_accessible_kubeconfig() {
        return "No Kubernetes cluster configuration found. Upload a kubeconfig to connect.".to_string();
    }

    "Kubernetes credentials are not available. Check your kubeconfig/context and re-authenticate.".to_string()
}

fn read_kubeconfig_from_path(path: &Path) -> anyhow::Result<Kubeconfig> {
    Kubeconfig::read_from(path).map_err(|e| anyhow::anyhow!("failed to read kubeconfig {}: {e}", path.display()))
}

fn read_effective_kubeconfig() -> anyhow::Result<Kubeconfig> {
    let configured_paths = env::var_os("KUBECONFIG")
        .map(|raw| {
            env::split_paths(&raw)
                .filter(|p| p.exists())
                .collect::<Vec<PathBuf>>()
        })
        .unwrap_or_default();

    if let Some(path) = configured_paths.first() {
        return read_kubeconfig_from_path(path);
    }

    let default_path = default_kubeconfig_path();
    if default_path.exists() {
        return read_kubeconfig_from_path(&default_path);
    }

    Kubeconfig::read().map_err(|e| anyhow::anyhow!("failed to read default kubeconfig: {e}"))
}

pub fn list_kubeconfig_contexts_from_path(path: &Path) -> anyhow::Result<(Vec<String>, Option<String>)> {
    let kc = read_kubeconfig_from_path(path)?;
    let contexts = kc.contexts.iter().map(|c| c.name.clone()).collect::<Vec<_>>();
    Ok((contexts, kc.current_context.clone()))
}

fn resolve_effective_kube_context() -> Option<String> {
    if let Some(ctx) = env::var("KUBE_CONTEXT").ok().filter(|s| !s.trim().is_empty()) {
        return Some(ctx);
    }

    read_effective_kubeconfig()
        .ok()
        .and_then(|kc| kc.current_context.clone())
        .filter(|s| !s.trim().is_empty())
}

/// True when a kubeconfig/context is already present (background upgrade may succeed later).
pub fn has_resolvable_kube_context() -> bool {
    resolve_effective_kube_context().is_some()
}

fn placeholder_status_for_context(_context_name: Option<&str>) -> KubeClientStatus {
    KubeClientStatus {
        is_placeholder: true,
        user_message: Some(default_placeholder_user_message()),
    }
}

fn is_missing_exec_error(message: &str) -> bool {
    let err_text = message.to_lowercase();
    err_text.contains("unable to run auth exec")
        || err_text.contains("no such file or directory")
        || (err_text.contains("auth exec") && err_text.contains("os error 2"))
}

async fn try_build_client_from_config(cfg: Config) -> Result<Client, String> {
    tokio::task::spawn_blocking(move || Client::try_from(cfg).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("client build task failed: {e}"))?
}

async fn try_build_client_from_options(options: &KubeConfigOptions) -> Result<Client, String> {
    let cfg = Config::from_kubeconfig(options)
        .await
        .map_err(|e| e.to_string())?;
    try_build_client_from_config(cfg).await
}

async fn try_load_inferred_client_with_timeout(load_timeout: Duration) -> Option<Client> {
    let load_client = async {
        let cfg = Config::infer().await.map_err(|e| e.to_string())?;
        try_build_client_from_config(cfg).await
    };

    match timeout(load_timeout, load_client).await {
        Ok(Ok(client)) => Some(client),
        Ok(Err(e)) => {
            if !is_missing_exec_error(&e) {
                warn!("Kubernetes client init from inferred config failed: {}", e);
            }
            None
        }
        Err(_) => {
            warn!(
                "Kubernetes client init from inferred config timed out (>{} s).",
                load_timeout.as_secs()
            );
            None
        }
    }
}

async fn try_load_client_for_context_with_timeout(
    ctx: &str,
    load_timeout: Duration,
    _resolve_timeout: Duration,
) -> Option<Client> {
    let options = KubeConfigOptions {
        context: Some(ctx.to_string()),
        ..Default::default()
    };

    match timeout(load_timeout, try_build_client_from_options(&options)).await {
        Ok(Ok(client)) => Some(client),
        Ok(Err(e)) => {
            if !is_missing_exec_error(&e) {
                warn!(
                    "Kubernetes client init failed for context '{}': {}. Exec credential may be unavailable.",
                    ctx, e
                );
            }
            None
        }
        Err(_) => {
            warn!(
                "Kubernetes client init timed out (>{} s) for context '{}'.",
                EXEC_PROVIDER_LOAD_TIMEOUT.as_secs(),
                ctx
            );
            None
        }
    }
}

async fn try_load_client_for_context(ctx: &str) -> Option<Client> {
    try_load_client_for_context_with_timeout(
        ctx,
        EXEC_PROVIDER_LOAD_TIMEOUT,
        EXEC_PROVIDER_RESOLVE_TIMEOUT,
    )
    .await
}

pub async fn upgrade_kube_client_in_background(
    client: std::sync::Arc<tokio::sync::RwLock<Client>>,
    auth_placeholder: std::sync::Arc<std::sync::atomic::AtomicBool>,
    auth_message: std::sync::Arc<tokio::sync::RwLock<Option<String>>>,
) {
    use std::sync::atomic::Ordering;
    use tracing::info;

    const MAX_ATTEMPTS: u32 = 18;
    const RETRY_INTERVAL: Duration = Duration::from_secs(10);

    for attempt in 1..=MAX_ATTEMPTS {
        if !auth_placeholder.load(Ordering::Relaxed) {
            return;
        }

        tokio::time::sleep(RETRY_INTERVAL).await;

        let Some(ctx) = resolve_effective_kube_context() else {
            continue;
        };

        if let Some(upgraded) = try_load_client_for_context_with_timeout(
            &ctx,
            EXEC_PROVIDER_BACKGROUND_TIMEOUT,
            EXEC_PROVIDER_RESOLVE_TIMEOUT,
        )
        .await
        {
            *client.write().await = upgraded;
            auth_placeholder.store(false, Ordering::Relaxed);
            *auth_message.write().await = None;
            info!(
                "Kubernetes client upgraded from placeholder for context '{}'",
                ctx
            );
            return;
        }

        warn!(
            "Background Kubernetes credential upgrade attempt {}/{} failed for context '{}'",
            attempt, MAX_ATTEMPTS, ctx
        );
    }
}

/// Returns `(client, status)`. Starts with a placeholder when kubeconfig/creds are missing.
pub async fn load_kube_client_with_status() -> anyhow::Result<(Client, KubeClientStatus)> {
    let context = resolve_effective_kube_context();

    if let Some(ref ctx) = context {
        if let Some(client) = try_load_client_for_context(ctx).await {
            return Ok((client, KubeClientStatus::default()));
        }

        return build_placeholder_client(Some(ctx))
            .await
            .map(|client| (client, placeholder_status_for_context(Some(ctx))));
    }

    if let Some(client) = try_load_inferred_client_with_timeout(EXEC_PROVIDER_LOAD_TIMEOUT).await {
        return Ok((client, KubeClientStatus::default()));
    }

    warn!("No Kubernetes context configured; starting with placeholder client.");
    build_placeholder_client(None)
        .await
        .map(|client| (client, placeholder_status_for_context(None)))
}

pub async fn build_client_from_kubeconfig_path(
    path: &Path,
    context: Option<&str>,
) -> anyhow::Result<(Client, String)> {
    let kc = read_kubeconfig_from_path(path)?;
    let selected_context = context
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| kc.current_context.clone())
        .ok_or_else(|| anyhow::anyhow!("kubeconfig has no current-context; select a context"))?;

    if !kc.contexts.iter().any(|c| c.name == selected_context) {
        return Err(anyhow::anyhow!(
            "context '{}' was not found in {}",
            selected_context,
            path.display()
        ));
    }

    let options = KubeConfigOptions {
        context: Some(selected_context.clone()),
        ..Default::default()
    };
    let cfg = Config::from_custom_kubeconfig(kc, &options)
        .await
        .map_err(|e| anyhow::anyhow!("failed to load kubeconfig: {e}"))?;
    let client = try_build_client_from_config(cfg)
        .await
        .map_err(|e| anyhow::anyhow!("failed to build Kubernetes client: {e}"))?;
    Ok((client, selected_context))
}

async fn build_placeholder_client(context_name: Option<&str>) -> anyhow::Result<Client> {
    let mut kubeconfig = read_effective_kubeconfig();

    if let Ok(ref mut kc) = kubeconfig {
        let user_name: Option<String> = {
            let ctx_name = context_name.or_else(|| kc.current_context.as_deref());
            ctx_name.and_then(|n| {
                kc.contexts
                    .iter()
                    .find(|c| c.name == n)
                    .and_then(|c| c.context.as_ref())
                    .map(|c| c.user.clone())
            })
        };

        if let Some(ref uname) = user_name {
            for named_auth in &mut kc.auth_infos {
                if named_auth.name == *uname {
                    if let Some(ref mut ai) = named_auth.auth_info {
                        ai.exec = None;
                    }
                }
            }
        }

        let options = KubeConfigOptions {
            context: context_name.map(String::from),
            ..Default::default()
        };

        if let Ok(mut cfg) = Config::from_custom_kubeconfig(kc.clone(), &options).await {
            cfg.accept_invalid_certs = true;
            if let Ok(client) = Client::try_from(cfg) {
                warn!(
                    "Started with UNAUTHENTICATED placeholder client for context '{}'",
                    context_name.unwrap_or("<default>")
                );
                return Ok(client);
            }
        }
    }

    let uri = "http://127.0.0.1:6443"
        .parse::<Uri>()
        .expect("hardcoded valid URI");
    let cfg = Config::new(uri);
    let client = Client::try_from(cfg)
        .map_err(|e| anyhow::anyhow!("Fallback placeholder client creation failed: {}", e))?;
    warn!(
        "Started with minimal localhost placeholder client for context '{}'",
        context_name.unwrap_or("<default>")
    );
    Ok(client)
}

