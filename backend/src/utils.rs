use axum::http::Request;
use futures_util::future::join_all;
use kube::{
    api::ListParams,
    core::{ApiResource, DynamicObject, GroupVersionKind},
    Api, Client,
};
use std::collections::HashMap;

/// Returns true when the `metrics.k8s.io` API group is available on the cluster.
/// When metrics-server is not installed the aggregation layer returns a plain-text
/// "404 page not found" body which the kube client cannot parse as a Status JSON,
/// producing spurious WARN logs.  Checking discovery first avoids that request.
pub async fn metrics_api_available(client: &Client) -> bool {
    match client.list_api_groups().await {
        Ok(groups) => groups.groups.iter().any(|g| g.name == "metrics.k8s.io"),
        Err(_) => false,
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

    if !metrics_api_available(&client).await {
        return metrics_map;
    }

    let pod_metrics_resource =
        ApiResource::from_gvk(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "PodMetrics"));
    let metrics_api: Api<DynamicObject> = Api::all_with(client, &pod_metrics_resource);

    let metrics_list = match metrics_api.list(&ListParams::default()).await {
        Ok(list) => list,
        Err(_) => return metrics_map,
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

    if !metrics_api_available(&client).await {
        return metrics_map;
    }

    let node_metrics_resource =
        ApiResource::from_gvk(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "NodeMetrics"));
    let metrics_api: Api<DynamicObject> = Api::all_with(client, &node_metrics_resource);

    let metrics_list = match metrics_api.list(&ListParams::default()).await {
        Ok(list) => list,
        Err(_) => return metrics_map,
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
