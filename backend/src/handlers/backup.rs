use axum::{
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use cron::Schedule;
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, PersistentVolumeClaim, Pod, Secret, Service, ServiceAccount};
use k8s_openapi::api::networking::v1::{Ingress, IngressClass, NetworkPolicy};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
use k8s_openapi::api::scheduling::v1::PriorityClass;
use k8s_openapi::api::storage::v1::StorageClass;
use kube::{
    api::{DeleteParams, ListParams, Patch, PatchParams},
    core::{ApiResource, DynamicObject, GroupVersionKind},
    Api,
};
use s3::{bucket::Bucket, creds::Credentials, region::Region};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::str::FromStr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tokio::time::sleep;
use tracing::{debug, error, info, warn};

use crate::AppState;

const SETTINGS_NAMESPACE: &str = "pertisk-backups";
const SETTINGS_CONFIGMAP_NAME: &str = "pertisk-backup-settings";
const SETTINGS_SECRET_NAME: &str = "pertisk-backup-settings-secret";
const SETTINGS_KEY: &str = "settings.json";
const SCHEDULES_KEY: &str = "schedules.json";
const BACKUP_RUNS_KEY: &str = "backup-runs.json";
const BACKUP_S3_TEST_OBJECT_PREFIX: &str = "_pertisk-test-";
const AWS_ACCESS_KEY_ID_KEY: &str = "aws_access_key_id";
const AWS_SECRET_ACCESS_KEY_KEY: &str = "aws_secret_access_key";
const BACKUP_API_RETRY_COOLDOWN_SECONDS: i64 = 300;

static BACKUP_API_RETRY_AT_EPOCH_SECONDS: AtomicI64 = AtomicI64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSettings {
    pub schedule_name: String,
    pub storage_location_name: String,
    pub credentials_secret_name: String,

    pub s3_bucket: String,
    pub s3_region: String,
    pub s3_prefix: String,
    pub s3_url: String,
    pub s3_force_path_style: bool,
    pub s3_insecure_skip_tls_verify: bool,

    pub aws_access_key_id: String,
    pub aws_secret_access_key: String,

    pub schedule_enabled: bool,
    pub schedule_cron: String,
    pub ttl: String,

    pub include_namespaces: Vec<String>,
    pub exclude_namespaces: Vec<String>,
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            schedule_name: "pertisk-backup-schedule".to_string(),
            storage_location_name: "default".to_string(),
            credentials_secret_name: "cloud-credentials".to_string(),
            s3_bucket: String::new(),
            s3_region: "us-east-1".to_string(),
            s3_prefix: "pertisk-backups".to_string(),
            s3_url: String::new(),
            s3_force_path_style: true,
            s3_insecure_skip_tls_verify: false,
            aws_access_key_id: String::new(),
            aws_secret_access_key: String::new(),
            schedule_enabled: false,
            schedule_cron: "0 2 * * *".to_string(),
            ttl: "720h0m0s".to_string(),
            include_namespaces: vec![],
            exclude_namespaces: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupOverview {
    pub backups: Vec<BackupRecord>,
    pub schedules: Vec<ScheduleRecord>,
    pub restores: Vec<RestoreRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupRecord {
    pub name: String,
    pub phase: String,
    pub storage_location: String,
    pub created_at: String,
    pub size_bytes: Option<u64>,
    pub include_namespaces: Vec<String>,
    pub exclude_namespaces: Vec<String>,
    pub resource_summary: String,
    pub kind_summary: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduleRecord {
    pub name: String,
    pub cron: String,
    pub timezone: String,
    pub last_backup: String,
    pub paused: bool,
    pub include_namespaces: Vec<String>,
    pub exclude_namespaces: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSchedule {
    name: String,
    cron: String,
    #[serde(default = "default_timezone")]
    timezone: String,
    paused: bool,
    #[serde(default)]
    include_namespaces: Vec<String>,
    #[serde(default)]
    exclude_namespaces: Vec<String>,
    updated_at: String,
    #[serde(default)]
    last_run_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredBackupRun {
    name: String,
    #[serde(default)]
    schedule_name: String,
    phase: String,
    storage_location: String,
    created_at: String,
    #[serde(default)]
    manual: bool,
    #[serde(default)]
    object_key: String,
    #[serde(default)]
    size_bytes: Option<u64>,
    #[serde(default)]
    include_namespaces: Vec<String>,
    #[serde(default)]
    exclude_namespaces: Vec<String>,
    #[serde(default)]
    resource_summary: String,
    #[serde(default)]
    kind_summary: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreRecord {
    pub name: String,
    pub backup_name: String,
    pub phase: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct ManualBackupRequest {
    pub name: Option<String>,
    pub include_namespaces: Option<Vec<String>>,
    pub exclude_namespaces: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct RestoreRequest {
    pub backup_name: String,
    pub restore_name: Option<String>,
    pub include_namespaces: Option<Vec<String>>,
    pub exclude_namespaces: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateScheduleRequest {
    pub name: String,
    pub cron: String,
    pub timezone: Option<String>,
    pub ttl: Option<String>,
    pub include_namespaces: Option<Vec<String>>,
    pub exclude_namespaces: Option<Vec<String>>,
    pub paused: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct S3TestRequest {
    pub s3_bucket: String,
    pub s3_region: String,
    pub s3_prefix: String,
    pub s3_url: String,
    pub s3_force_path_style: bool,
    pub s3_insecure_skip_tls_verify: bool,
    pub aws_access_key_id: String,
    pub aws_secret_access_key: String,
}

#[derive(Debug, Deserialize)]
pub struct S3ConfigRequest {
    pub storage_location_name: String,
    pub credentials_secret_name: String,
    pub s3_bucket: String,
    pub s3_region: String,
    pub s3_prefix: String,
    pub s3_url: String,
    pub s3_force_path_style: bool,
    pub s3_insecure_skip_tls_verify: bool,
    pub aws_access_key_id: String,
    pub aws_secret_access_key: String,
}

#[derive(Debug, Deserialize)]
pub struct BulkDeleteBackupsRequest {
    pub names: Vec<String>,
}

fn backup_crd_resource(kind: &str) -> ApiResource {
    ApiResource::from_gvk(&GroupVersionKind::gvk("velero.io", "v1", kind))
}

fn is_missing_backup_api_error(error_text: &str) -> bool {
    error_text.contains("404 page not found")
        || error_text.contains("the server could not find the requested resource")
        || error_text.contains("404 Not Found")
}

fn external_backup_crd_enabled() -> bool {
    match std::env::var("BACKUP_EXTERNAL_CRD_ENABLED") {
        Ok(raw) => {
            let normalized = raw.trim().to_ascii_lowercase();
            !(normalized == "0" || normalized == "false" || normalized == "no" || normalized == "off")
        }
        Err(_) => true,
    }
}

fn default_timezone() -> String {
    "Asia/Bangkok".to_string()
}

fn normalize_cron_expression(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Schedule cron is required".to_string());
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    match parts.len() {
        5 => Ok(format!("0 {}", trimmed)),
        6 | 7 => Ok(trimmed.to_string()),
        _ => Err("Cron must have 5, 6, or 7 fields".to_string()),
    }
}

pub async fn test_backup_s3(Json(req): Json<S3TestRequest>) -> impl IntoResponse {
    if req.s3_bucket.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": "S3 bucket is required"})),
        )
            .into_response();
    }
    if req.aws_access_key_id.trim().is_empty() || req.aws_secret_access_key.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": "AWS access key and secret key are required"})),
        )
            .into_response();
    }

    let mut settings = BackupSettings::default();
    settings.s3_bucket = req.s3_bucket.trim().to_string();
    settings.s3_region = req.s3_region.trim().to_string();
    settings.s3_prefix = req.s3_prefix.trim().to_string();
    settings.s3_url = req.s3_url.trim().to_string();
    settings.s3_force_path_style = req.s3_force_path_style;
    settings.s3_insecure_skip_tls_verify = req.s3_insecure_skip_tls_verify;
    settings.aws_access_key_id = req.aws_access_key_id.trim().to_string();
    settings.aws_secret_access_key = req.aws_secret_access_key.trim().to_string();

    let test_key = {
        let prefix = settings.s3_prefix.trim().trim_matches('/');
        let name = format!("_pertisk-test-{}.json", Utc::now().format("%Y%m%d%H%M%S"));
        if prefix.is_empty() {
            name
        } else {
            format!("{}/{}", prefix, name)
        }
    };

    let test_payload = json!({
        "type": "s3-upload-test",
        "bucket": settings.s3_bucket,
        "timestamp": Utc::now().to_rfc3339(),
    });
    let body = match serde_json::to_vec(&test_payload) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"success": false, "message": format!("Failed to build test payload: {}", e)})),
            )
                .into_response();
        }
    };

    match put_object_with_retries(&settings, &test_key, &body).await {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "message": format!(
                    "S3 upload test succeeded. Bucket '{}', key '{}'.",
                    settings.s3_bucket,
                    test_key
                )
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": e})),
        )
            .into_response(),
    }
}

async fn ensure_namespace(client: kube::Client, namespace: &str) -> Result<(), String> {
    if namespace.trim().is_empty() {
        return Err("Namespace is required".to_string());
    }

    let namespace_api: Api<Namespace> = Api::all(client);
    let namespace_body = json!({
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": {
            "name": namespace,
        }
    });

    namespace_api
        .patch(
            namespace,
            &PatchParams::apply("pertisk-kube-web").force(),
            &Patch::Apply(namespace_body),
        )
        .await
        .map_err(|e| format!("Failed to ensure namespace {}: {}", namespace, e))?;

    Ok(())
}

async fn load_settings(client: kube::Client) -> BackupSettings {
    let api: Api<ConfigMap> = Api::namespaced(client.clone(), SETTINGS_NAMESPACE);
    let mut settings = BackupSettings::default();

    match api.get_opt(SETTINGS_CONFIGMAP_NAME).await {
        Ok(Some(cm)) => {
            let parsed = cm
                .data
                .as_ref()
                .and_then(|d| d.get(SETTINGS_KEY))
                .and_then(|txt| serde_json::from_str::<Value>(txt).ok());

            if let Some(value) = parsed {
                if let Some(obj) = value.as_object() {
                    if let Some(v) = obj.get("storage_location_name").and_then(|v| v.as_str()) {
                        settings.storage_location_name = v.to_string();
                    }
                    if let Some(v) = obj.get("credentials_secret_name").and_then(|v| v.as_str()) {
                        settings.credentials_secret_name = v.to_string();
                    }
                    if let Some(v) = obj.get("s3_bucket").and_then(|v| v.as_str()) {
                        settings.s3_bucket = v.to_string();
                    }
                    if let Some(v) = obj.get("s3_region").and_then(|v| v.as_str()) {
                        settings.s3_region = v.to_string();
                    }
                    if let Some(v) = obj.get("s3_prefix").and_then(|v| v.as_str()) {
                        settings.s3_prefix = v.to_string();
                    }
                    if let Some(v) = obj.get("s3_url").and_then(|v| v.as_str()) {
                        settings.s3_url = v.to_string();
                    }
                    if let Some(v) = obj.get("s3_force_path_style").and_then(|v| v.as_bool()) {
                        settings.s3_force_path_style = v;
                    }
                    if let Some(v) = obj.get("s3_insecure_skip_tls_verify").and_then(|v| v.as_bool()) {
                        settings.s3_insecure_skip_tls_verify = v;
                    }
                }
            }
        }
        _ => {}
    }

    let secret_api: Api<Secret> = Api::namespaced(client, SETTINGS_NAMESPACE);
    if let Ok(Some(secret)) = secret_api.get_opt(SETTINGS_SECRET_NAME).await {
        if let Some(data) = secret.data {
            if let Some(access_key) = data.get(AWS_ACCESS_KEY_ID_KEY) {
                settings.aws_access_key_id = String::from_utf8(access_key.0.clone()).unwrap_or_default();
            }
            if let Some(secret_key) = data.get(AWS_SECRET_ACCESS_KEY_KEY) {
                settings.aws_secret_access_key = String::from_utf8(secret_key.0.clone()).unwrap_or_default();
            }
        }
    }

    settings
}

async fn persist_settings(client: kube::Client, settings: &BackupSettings) -> Result<(), String> {
    ensure_namespace(client.clone(), SETTINGS_NAMESPACE).await?;

    let api: Api<ConfigMap> = Api::namespaced(client.clone(), SETTINGS_NAMESPACE);
    let settings_value = json!({
        "storage_location_name": settings.storage_location_name,
        "credentials_secret_name": settings.credentials_secret_name,
        "s3_bucket": settings.s3_bucket,
        "s3_region": settings.s3_region,
        "s3_prefix": settings.s3_prefix,
        "s3_url": settings.s3_url,
        "s3_force_path_style": settings.s3_force_path_style,
        "s3_insecure_skip_tls_verify": settings.s3_insecure_skip_tls_verify,
    });
    let payload = serde_json::to_string_pretty(&settings_value).map_err(|e| e.to_string())?;

    let mut data_map = match api.get_opt(SETTINGS_CONFIGMAP_NAME).await {
        Ok(Some(cm)) => cm.data.unwrap_or_default(),
        _ => Default::default(),
    };
    data_map.insert(SETTINGS_KEY.to_string(), payload);

    let cm = json!({
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": SETTINGS_CONFIGMAP_NAME,
            "namespace": SETTINGS_NAMESPACE,
        },
        "data": data_map,
    });

    api.patch(
        SETTINGS_CONFIGMAP_NAME,
        &PatchParams::apply("pertisk-kube-web").force(),
        &Patch::Apply(cm),
    )
    .await
    .map_err(|e| e.to_string())?;

    let secret_api: Api<Secret> = Api::namespaced(client, SETTINGS_NAMESPACE);
    let secret = json!({
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {
            "name": SETTINGS_SECRET_NAME,
            "namespace": SETTINGS_NAMESPACE,
        },
        "type": "Opaque",
        "stringData": {
            AWS_ACCESS_KEY_ID_KEY: settings.aws_access_key_id,
            AWS_SECRET_ACCESS_KEY_KEY: settings.aws_secret_access_key,
        }
    });

    secret_api
        .patch(
            SETTINGS_SECRET_NAME,
            &PatchParams::apply("pertisk-kube-web").force(),
            &Patch::Apply(secret),
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

async fn load_stored_schedules(client: kube::Client) -> Vec<StoredSchedule> {
    let api: Api<ConfigMap> = Api::namespaced(client, SETTINGS_NAMESPACE);
    match api.get_opt(SETTINGS_CONFIGMAP_NAME).await {
        Ok(Some(cm)) => cm
            .data
            .as_ref()
            .and_then(|d| d.get(SCHEDULES_KEY))
            .and_then(|txt| serde_json::from_str::<Vec<StoredSchedule>>(txt).ok())
            .unwrap_or_default(),
        _ => vec![],
    }
}

async fn persist_stored_schedules(client: kube::Client, schedules: &[StoredSchedule]) -> Result<(), String> {
    ensure_namespace(client.clone(), SETTINGS_NAMESPACE).await?;

    let api: Api<ConfigMap> = Api::namespaced(client.clone(), SETTINGS_NAMESPACE);
    let schedules_payload = serde_json::to_string_pretty(schedules).map_err(|e| e.to_string())?;

    let mut data_map = match api.get_opt(SETTINGS_CONFIGMAP_NAME).await {
        Ok(Some(cm)) => cm.data.unwrap_or_default(),
        _ => Default::default(),
    };
    data_map.insert(SCHEDULES_KEY.to_string(), schedules_payload);

    let cm = json!({
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": SETTINGS_CONFIGMAP_NAME,
            "namespace": SETTINGS_NAMESPACE,
        },
        "data": data_map,
    });

    api.patch(
        SETTINGS_CONFIGMAP_NAME,
        &PatchParams::apply("pertisk-kube-web").force(),
        &Patch::Apply(cm),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

async fn load_stored_backup_runs(client: kube::Client) -> Vec<StoredBackupRun> {
    let api: Api<ConfigMap> = Api::namespaced(client, SETTINGS_NAMESPACE);
    match api.get_opt(SETTINGS_CONFIGMAP_NAME).await {
        Ok(Some(cm)) => cm
            .data
            .as_ref()
            .and_then(|d| d.get(BACKUP_RUNS_KEY))
            .and_then(|txt| serde_json::from_str::<Vec<StoredBackupRun>>(txt).ok())
            .unwrap_or_default(),
        _ => vec![],
    }
}

async fn persist_stored_backup_runs(client: kube::Client, runs: &[StoredBackupRun]) -> Result<(), String> {
    ensure_namespace(client.clone(), SETTINGS_NAMESPACE).await?;

    let api: Api<ConfigMap> = Api::namespaced(client.clone(), SETTINGS_NAMESPACE);
    let runs_payload = serde_json::to_string_pretty(runs).map_err(|e| e.to_string())?;

    let mut data_map = match api.get_opt(SETTINGS_CONFIGMAP_NAME).await {
        Ok(Some(cm)) => cm.data.unwrap_or_default(),
        _ => Default::default(),
    };
    data_map.insert(BACKUP_RUNS_KEY.to_string(), runs_payload);

    let cm = json!({
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": SETTINGS_CONFIGMAP_NAME,
            "namespace": SETTINGS_NAMESPACE,
        },
        "data": data_map,
    });

    api.patch(
        SETTINGS_CONFIGMAP_NAME,
        &PatchParams::apply("pertisk-kube-web").force(),
        &Patch::Apply(cm),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

async fn load_backup_runs_from_s3(settings: &BackupSettings) -> Vec<BackupRecord> {
    if settings.s3_bucket.trim().is_empty()
        || settings.aws_access_key_id.trim().is_empty()
        || settings.aws_secret_access_key.trim().is_empty()
    {
        return vec![];
    }

    let region = match resolve_s3_region(settings) {
        Ok(region) => region,
        Err(e) => {
            info!("Skipping S3 backup fallback due to region config error: {}", e);
            return vec![];
        }
    };

    let bucket = match create_s3_bucket_client(settings, region) {
        Ok(bucket) => bucket,
        Err(e) => {
            info!("Skipping S3 backup fallback due to bucket client error: {}", e);
            return vec![];
        }
    };

    let prefix = settings.s3_prefix.trim().trim_matches('/');
    let list_prefix = if prefix.is_empty() {
        String::new()
    } else {
        format!("{}/", prefix)
    };

    let list_results = match bucket.list(list_prefix.clone(), None).await {
        Ok(results) => results,
        Err(e) => {
            info!("S3 backup fallback list failed: {}", e);
            return vec![];
        }
    };

    let mut out: Vec<BackupRecord> = vec![];
    for page in list_results {
        for object in page.contents {
            let mut key = object.key.trim().trim_start_matches('/').to_string();
            if key.is_empty() || !key.ends_with(".json") {
                continue;
            }

            if !list_prefix.is_empty() {
                if !key.starts_with(&list_prefix) {
                    continue;
                }
                key = key[list_prefix.len()..].to_string();
            }

            if key.is_empty() || key.contains('/') {
                continue;
            }

            let backup_name = key.trim_end_matches(".json").to_string();
            if backup_name.is_empty() {
                continue;
            }
            // Ignore S3 probe files generated by /backup/config/test-s3.
            if backup_name.starts_with(BACKUP_S3_TEST_OBJECT_PREFIX) {
                continue;
            }

            let resource_summary = build_resource_summary(&[], &[]);

            out.push(BackupRecord {
                name: backup_name,
                phase: "Completed".to_string(),
                storage_location: settings.storage_location_name.clone(),
                created_at: object.last_modified,
                size_bytes: if object.size > 0 { Some(object.size as u64) } else { None },
                include_namespaces: vec![],
                exclude_namespaces: vec![],
                kind_summary: fallback_kind_summary_from_resource_summary(&resource_summary),
                resource_summary,
            });
        }
    }

    out
}

fn resolve_s3_region(settings: &BackupSettings) -> Result<Region, String> {
    let region_name = settings.s3_region.trim();
    if !settings.s3_url.trim().is_empty() {
        return Ok(Region::Custom {
            region: if region_name.is_empty() {
                "custom".to_string()
            } else {
                region_name.to_string()
            },
            endpoint: settings.s3_url.trim().trim_end_matches('/').to_string(),
        });
    }

    let fallback_region = if region_name.is_empty() { "us-east-1" } else { region_name };
    Region::from_str(fallback_region).map_err(|e| format!("Invalid S3 region '{}': {}", fallback_region, e))
}

fn region_label(region: &Region) -> String {
    match region {
        Region::Custom { region, endpoint } => format!("custom(region={}, endpoint={})", region, endpoint),
        _ => region.to_string(),
    }
}

fn create_s3_bucket_client(settings: &BackupSettings, region: Region) -> Result<Bucket, String> {
    let credentials = Credentials::new(
        Some(settings.aws_access_key_id.trim()),
        Some(settings.aws_secret_access_key.trim()),
        None,
        None,
        None,
    )
    .map_err(|e| format!("Failed to build S3 credentials: {}", e))?;

    let mut bucket = Bucket::new(settings.s3_bucket.trim(), region, credentials)
        .map_err(|e| format!("Failed to create S3 bucket client: {}", e))?;

    if settings.s3_force_path_style || !settings.s3_url.trim().is_empty() {
        bucket = bucket.with_path_style();
    }

    Ok(bucket)
}

fn prune_resource_object(mut value: Value) -> Value {
    if let Some(obj) = value.as_object_mut() {
        obj.remove("status");
        if let Some(metadata) = obj.get_mut("metadata").and_then(|m| m.as_object_mut()) {
            metadata.remove("managedFields");
            metadata.remove("resourceVersion");
            metadata.remove("uid");
            metadata.remove("selfLink");
            metadata.remove("generation");
        }
    }
    value
}

fn serialize_resource_list<T: Serialize>(items: Vec<T>) -> Vec<Value> {
    items
        .into_iter()
        .filter_map(|item| serde_json::to_value(item).ok())
        .map(prune_resource_object)
        .collect()
}

async fn list_namespaces_for_backup(
    client: kube::Client,
    include_namespaces: &[String],
    exclude_namespaces: &[String],
) -> Vec<String> {
    let mut namespaces = if include_namespaces.is_empty() {
        let ns_api: Api<Namespace> = Api::all(client);
        match ns_api.list(&Default::default()).await {
            Ok(list) => list
                .items
                .into_iter()
                .filter_map(|n| n.metadata.name)
                .collect::<Vec<String>>(),
            Err(_) => vec![],
        }
    } else {
        include_namespaces.to_vec()
    };

    namespaces.retain(|ns| !exclude_namespaces.iter().any(|excluded| excluded == ns));
    namespaces.sort();
    namespaces.dedup();
    namespaces
}

async fn build_k8s_snapshot_payload(
    client: kube::Client,
    backup_name: &str,
    schedule: &StoredSchedule,
    created_at: &str,
    storage_location: &str,
) -> (Value, String, BTreeMap<String, usize>) {
    let namespaces = list_namespaces_for_backup(
        client.clone(),
        &schedule.include_namespaces,
        &schedule.exclude_namespaces,
    )
    .await;

    let mut warnings: Vec<String> = vec![];
    let mut snapshot_namespaces: Vec<Value> = vec![];
    let mut total_resources: usize = 0;
    let mut kind_summary: BTreeMap<String, usize> = BTreeMap::new();

    let ingressclasses_api: Api<IngressClass> = Api::all(client.clone());
    let ingressclasses = match ingressclasses_api.list(&Default::default()).await {
        Ok(list) => serialize_resource_list(list.items),
        Err(e) => {
            warnings.push(format!("cluster: ingressclasses list failed: {}", e));
            vec![]
        }
    };

    let clusterroles_api: Api<ClusterRole> = Api::all(client.clone());
    let clusterroles = match clusterroles_api.list(&Default::default()).await {
        Ok(list) => serialize_resource_list(list.items),
        Err(e) => {
            warnings.push(format!("cluster: clusterroles list failed: {}", e));
            vec![]
        }
    };

    let clusterrolebindings_api: Api<ClusterRoleBinding> = Api::all(client.clone());
    let clusterrolebindings = match clusterrolebindings_api.list(&Default::default()).await {
        Ok(list) => serialize_resource_list(list.items),
        Err(e) => {
            warnings.push(format!("cluster: clusterrolebindings list failed: {}", e));
            vec![]
        }
    };

    let storageclasses_api: Api<StorageClass> = Api::all(client.clone());
    let storageclasses = match storageclasses_api.list(&Default::default()).await {
        Ok(list) => serialize_resource_list(list.items),
        Err(e) => {
            warnings.push(format!("cluster: storageclasses list failed: {}", e));
            vec![]
        }
    };

    let priorityclasses_api: Api<PriorityClass> = Api::all(client.clone());
    let priorityclasses = match priorityclasses_api.list(&Default::default()).await {
        Ok(list) => serialize_resource_list(list.items),
        Err(e) => {
            warnings.push(format!("cluster: priorityclasses list failed: {}", e));
            vec![]
        }
    };

    total_resources += ingressclasses.len()
        + clusterroles.len()
        + clusterrolebindings.len()
        + storageclasses.len()
        + priorityclasses.len();
    *kind_summary.entry("ingressclasses".to_string()).or_insert(0) += ingressclasses.len();
    *kind_summary.entry("clusterroles".to_string()).or_insert(0) += clusterroles.len();
    *kind_summary.entry("clusterrolebindings".to_string()).or_insert(0) += clusterrolebindings.len();
    *kind_summary.entry("storageclasses".to_string()).or_insert(0) += storageclasses.len();
    *kind_summary.entry("priorityclasses".to_string()).or_insert(0) += priorityclasses.len();

    for namespace in namespaces {
        let pods_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
        let services_api: Api<Service> = Api::namespaced(client.clone(), &namespace);
        let serviceaccounts_api: Api<ServiceAccount> = Api::namespaced(client.clone(), &namespace);
        let roles_api: Api<Role> = Api::namespaced(client.clone(), &namespace);
        let rolebindings_api: Api<RoleBinding> = Api::namespaced(client.clone(), &namespace);
        let configmaps_api: Api<ConfigMap> = Api::namespaced(client.clone(), &namespace);
        let secrets_api: Api<Secret> = Api::namespaced(client.clone(), &namespace);
        let pvc_api: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), &namespace);
        let deployments_api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
        let statefulsets_api: Api<StatefulSet> = Api::namespaced(client.clone(), &namespace);
        let daemonsets_api: Api<DaemonSet> = Api::namespaced(client.clone(), &namespace);
        let jobs_api: Api<Job> = Api::namespaced(client.clone(), &namespace);
        let cronjobs_api: Api<CronJob> = Api::namespaced(client.clone(), &namespace);
        let ingresses_api: Api<Ingress> = Api::namespaced(client.clone(), &namespace);
        let networkpolicies_api: Api<NetworkPolicy> = Api::namespaced(client.clone(), &namespace);
        let hpas_api: Api<HorizontalPodAutoscaler> = Api::namespaced(client.clone(), &namespace);
        let pdbs_api: Api<PodDisruptionBudget> = Api::namespaced(client.clone(), &namespace);

        let pods = match pods_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: pods list failed: {}", namespace, e));
                vec![]
            }
        };

        let services = match services_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: services list failed: {}", namespace, e));
                vec![]
            }
        };

        let serviceaccounts = match serviceaccounts_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: serviceaccounts list failed: {}", namespace, e));
                vec![]
            }
        };

        let roles = match roles_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: roles list failed: {}", namespace, e));
                vec![]
            }
        };

        let rolebindings = match rolebindings_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: rolebindings list failed: {}", namespace, e));
                vec![]
            }
        };

        let configmaps = match configmaps_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: configmaps list failed: {}", namespace, e));
                vec![]
            }
        };

        let secrets = match secrets_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: secrets list failed: {}", namespace, e));
                vec![]
            }
        };

        let persistent_volume_claims = match pvc_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: pvc list failed: {}", namespace, e));
                vec![]
            }
        };

        let deployments = match deployments_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: deployments list failed: {}", namespace, e));
                vec![]
            }
        };

        let statefulsets = match statefulsets_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: statefulsets list failed: {}", namespace, e));
                vec![]
            }
        };

        let daemonsets = match daemonsets_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: daemonsets list failed: {}", namespace, e));
                vec![]
            }
        };

        let jobs = match jobs_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: jobs list failed: {}", namespace, e));
                vec![]
            }
        };

        let cronjobs = match cronjobs_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: cronjobs list failed: {}", namespace, e));
                vec![]
            }
        };

        let ingresses = match ingresses_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: ingresses list failed: {}", namespace, e));
                vec![]
            }
        };

        let networkpolicies = match networkpolicies_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: networkpolicies list failed: {}", namespace, e));
                vec![]
            }
        };

        let horizontalpodautoscalers = match hpas_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: hpas list failed: {}", namespace, e));
                vec![]
            }
        };

        let poddisruptionbudgets = match pdbs_api.list(&Default::default()).await {
            Ok(list) => serialize_resource_list(list.items),
            Err(e) => {
                warnings.push(format!("namespace {}: pdbs list failed: {}", namespace, e));
                vec![]
            }
        };

        let namespace_resource_count = pods.len()
            + services.len()
            + serviceaccounts.len()
            + roles.len()
            + rolebindings.len()
            + configmaps.len()
            + secrets.len()
            + persistent_volume_claims.len()
            + deployments.len()
            + statefulsets.len()
            + daemonsets.len()
            + jobs.len()
            + cronjobs.len()
            + ingresses.len()
            + networkpolicies.len()
            + horizontalpodautoscalers.len()
            + poddisruptionbudgets.len();
        total_resources += namespace_resource_count;

        *kind_summary.entry("pods".to_string()).or_insert(0) += pods.len();
        *kind_summary.entry("services".to_string()).or_insert(0) += services.len();
        *kind_summary.entry("serviceaccounts".to_string()).or_insert(0) += serviceaccounts.len();
        *kind_summary.entry("roles".to_string()).or_insert(0) += roles.len();
        *kind_summary.entry("rolebindings".to_string()).or_insert(0) += rolebindings.len();
        *kind_summary.entry("configmaps".to_string()).or_insert(0) += configmaps.len();
        *kind_summary.entry("secrets".to_string()).or_insert(0) += secrets.len();
        *kind_summary
            .entry("persistent_volume_claims".to_string())
            .or_insert(0) += persistent_volume_claims.len();
        *kind_summary.entry("deployments".to_string()).or_insert(0) += deployments.len();
        *kind_summary.entry("statefulsets".to_string()).or_insert(0) += statefulsets.len();
        *kind_summary.entry("daemonsets".to_string()).or_insert(0) += daemonsets.len();
        *kind_summary.entry("jobs".to_string()).or_insert(0) += jobs.len();
        *kind_summary.entry("cronjobs".to_string()).or_insert(0) += cronjobs.len();
        *kind_summary.entry("ingresses".to_string()).or_insert(0) += ingresses.len();
        *kind_summary.entry("networkpolicies".to_string()).or_insert(0) += networkpolicies.len();
        *kind_summary.entry("horizontalpodautoscalers".to_string()).or_insert(0) += horizontalpodautoscalers.len();
        *kind_summary.entry("poddisruptionbudgets".to_string()).or_insert(0) += poddisruptionbudgets.len();

        snapshot_namespaces.push(json!({
            "name": namespace,
            "summary": {
                "pods": pods.len(),
                "services": services.len(),
                "serviceaccounts": serviceaccounts.len(),
                "roles": roles.len(),
                "rolebindings": rolebindings.len(),
                "configmaps": configmaps.len(),
                "secrets": secrets.len(),
                "persistent_volume_claims": persistent_volume_claims.len(),
                "deployments": deployments.len(),
                "statefulsets": statefulsets.len(),
                "daemonsets": daemonsets.len(),
                "jobs": jobs.len(),
                "cronjobs": cronjobs.len(),
                "ingresses": ingresses.len(),
                "networkpolicies": networkpolicies.len(),
                "horizontalpodautoscalers": horizontalpodautoscalers.len(),
                "poddisruptionbudgets": poddisruptionbudgets.len()
            },
            "resources": {
                "pods": pods,
                "services": services,
                "serviceaccounts": serviceaccounts,
                "roles": roles,
                "rolebindings": rolebindings,
                "configmaps": configmaps,
                "secrets": secrets,
                "persistent_volume_claims": persistent_volume_claims,
                "deployments": deployments,
                "statefulsets": statefulsets,
                "daemonsets": daemonsets,
                "jobs": jobs,
                "cronjobs": cronjobs,
                "ingresses": ingresses,
                "networkpolicies": networkpolicies,
                "horizontalpodautoscalers": horizontalpodautoscalers,
                "poddisruptionbudgets": poddisruptionbudgets
            }
        }));
    }

    let resource_summary = format!(
        "Namespaces: {} | Total resources: {}",
        snapshot_namespaces.len(),
        total_resources
    );

    (
        json!({
            "kind": "PertiskClusterBackup",
            "apiVersion": "pertisk.tech/v1alpha1",
            "metadata": {
                "name": backup_name,
                "created_at": created_at,
                "schedule_name": schedule.name,
                "cron": schedule.cron,
                "storage_location": storage_location,
            },
            "filters": {
                "include_namespaces": schedule.include_namespaces,
                "exclude_namespaces": schedule.exclude_namespaces,
            },
            "summary": {
                "namespace_count": snapshot_namespaces.len(),
                "total_resources": total_resources,
                "ingressclasses": ingressclasses.len(),
                "clusterroles": clusterroles.len(),
                "clusterrolebindings": clusterrolebindings.len(),
                "storageclasses": storageclasses.len(),
                "priorityclasses": priorityclasses.len(),
                "warnings_count": warnings.len(),
                "kind_summary": kind_summary,
            },
            "cluster_resources": {
                "ingressclasses": ingressclasses,
                "clusterroles": clusterroles,
                "clusterrolebindings": clusterrolebindings,
                "storageclasses": storageclasses,
                "priorityclasses": priorityclasses,
            },
            "namespaces": snapshot_namespaces,
            "warnings": warnings,
        }),
        resource_summary,
        kind_summary,
    )
}

async fn put_object_with_retries(settings: &BackupSettings, key: &str, body: &[u8]) -> Result<(), String> {
    let primary_region = resolve_s3_region(settings)?;

    let mut attempts: Vec<(Region, String)> = Vec::new();
    attempts.push((primary_region.clone(), format!("/{}", key)));
    attempts.push((primary_region.clone(), key.to_string()));

    if let Region::Custom { endpoint, .. } = &primary_region {
        let region_fallback = Region::Custom {
            region: "us-east-1".to_string(),
            endpoint: endpoint.clone(),
        };
        attempts.push((region_fallback.clone(), format!("/{}", key)));
        attempts.push((region_fallback, key.to_string()));
    }

    let mut diagnostics: Vec<String> = Vec::new();
    for (region, path) in attempts {
        let region_name = region_label(&region);
        let bucket = create_s3_bucket_client(settings, region)?;
        match bucket.put_object(&path, body).await {
            Ok(response) => {
                if (200..300).contains(&response.status_code()) {
                    return Ok(());
                }
                let response_text = response
                    .to_string()
                    .unwrap_or_else(|_| "<non-utf8-response>".to_string());
                let header_map = response.headers();
                let header_hint = header_map
                    .get("x-amz-bucket-region")
                    .map(|v| format!(" x-amz-bucket-region={}", v))
                    .unwrap_or_default();
                diagnostics.push(format!(
                    "[region={}, path={}] HTTP {}{} body={}",
                    region_name,
                    path,
                    response.status_code(),
                    header_hint,
                    response_text
                ));
            }
            Err(e) => {
                diagnostics.push(format!(
                    "[region={}, path={}] request error: {}",
                    region_name,
                    path,
                    e
                ));
            }
        }
    }

    Err(format!(
        "S3 upload failed for key {}. Attempts: {}",
        key,
        diagnostics.join(" | ")
    ))
}

async fn delete_object_with_retries(settings: &BackupSettings, key: &str) -> Result<(), String> {
    let primary_region = resolve_s3_region(settings)?;

    let mut attempts: Vec<(Region, String)> = Vec::new();
    attempts.push((primary_region.clone(), key.to_string()));
    attempts.push((primary_region.clone(), format!("/{}", key)));

    if let Region::Custom { endpoint, .. } = &primary_region {
        let region_fallback = Region::Custom {
            region: "us-east-1".to_string(),
            endpoint: endpoint.clone(),
        };
        attempts.push((region_fallback.clone(), key.to_string()));
        attempts.push((region_fallback, format!("/{}", key)));
    }

    let mut diagnostics: Vec<String> = Vec::new();
    for (region, path) in attempts {
        let region_name = region_label(&region);
        let bucket = create_s3_bucket_client(settings, region)?;
        match bucket.delete_object(&path).await {
            Ok(response) => {
                if (200..300).contains(&response.status_code()) || response.status_code() == 404 {
                    return Ok(());
                }
                let response_text = response
                    .to_string()
                    .unwrap_or_else(|_| "<non-utf8-response>".to_string());
                diagnostics.push(format!(
                    "[region={}, path={}] HTTP {} body={}",
                    region_name,
                    path,
                    response.status_code(),
                    response_text
                ));
            }
            Err(e) => {
                diagnostics.push(format!(
                    "[region={}, path={}] request error: {}",
                    region_name,
                    path,
                    e
                ));
            }
        }
    }

    Err(format!(
        "S3 delete failed for key {}. Attempts: {}",
        key,
        diagnostics.join(" | ")
    ))
}

async fn get_object_with_retries(settings: &BackupSettings, key: &str) -> Result<Vec<u8>, String> {
    let primary_region = resolve_s3_region(settings)?;

    let mut attempts: Vec<(Region, String)> = Vec::new();
    attempts.push((primary_region.clone(), key.to_string()));
    attempts.push((primary_region.clone(), format!("/{}", key)));

    if let Region::Custom { endpoint, .. } = &primary_region {
        let region_fallback = Region::Custom {
            region: "us-east-1".to_string(),
            endpoint: endpoint.clone(),
        };
        attempts.push((region_fallback.clone(), key.to_string()));
        attempts.push((region_fallback, format!("/{}", key)));
    }

    let mut diagnostics: Vec<String> = Vec::new();
    for (region, path) in attempts {
        let region_name = region_label(&region);
        let bucket = create_s3_bucket_client(settings, region)?;
        match bucket.get_object(&path).await {
            Ok(response) => {
                if (200..300).contains(&response.status_code()) {
                    return Ok(response.as_slice().to_vec());
                }

                let response_text = response
                    .to_string()
                    .unwrap_or_else(|_| "<non-utf8-response>".to_string());
                diagnostics.push(format!(
                    "[region={}, path={}] HTTP {} body={}",
                    region_name,
                    path,
                    response.status_code(),
                    response_text
                ));
            }
            Err(e) => {
                diagnostics.push(format!(
                    "[region={}, path={}] request error: {}",
                    region_name,
                    path,
                    e
                ));
            }
        }
    }

    Err(format!(
        "S3 get failed for key {}. Attempts: {}",
        key,
        diagnostics.join(" | ")
    ))
}

fn backup_snapshot_key(settings: &BackupSettings, backup_name: &str) -> String {
    let prefix = settings.s3_prefix.trim().trim_matches('/');
    if prefix.is_empty() {
        format!("{}.json", backup_name)
    } else {
        format!("{}/{}.json", prefix, backup_name)
    }
}

fn api_resource_for_known_kind(kind: &str, api_version: &str) -> Option<ApiResource> {
    let (group, version) = if let Some((g, v)) = api_version.split_once('/') {
        (g, v)
    } else {
        ("", api_version)
    };

    let plural = match kind {
        "Pod" => "pods",
        "Service" => "services",
        "ServiceAccount" => "serviceaccounts",
        "Role" => "roles",
        "RoleBinding" => "rolebindings",
        "ConfigMap" => "configmaps",
        "Secret" => "secrets",
        "PersistentVolumeClaim" => "persistentvolumeclaims",
        "Deployment" => "deployments",
        "StatefulSet" => "statefulsets",
        "DaemonSet" => "daemonsets",
        "Job" => "jobs",
        "CronJob" => "cronjobs",
        "Ingress" => "ingresses",
        "IngressClass" => "ingressclasses",
        "ClusterRole" => "clusterroles",
        "ClusterRoleBinding" => "clusterrolebindings",
        "StorageClass" => "storageclasses",
        "PriorityClass" => "priorityclasses",
        "NetworkPolicy" => "networkpolicies",
        "HorizontalPodAutoscaler" => "horizontalpodautoscalers",
        "PodDisruptionBudget" => "poddisruptionbudgets",
        _ => return None,
    };

    let gvk = GroupVersionKind::gvk(group, version, kind);
    let mut ar = ApiResource::from_gvk(&gvk);
    ar.plural = plural.to_string();
    Some(ar)
}

fn sanitize_snapshot_resource(mut resource: Value) -> Value {
    if let Some(meta) = resource
        .get_mut("metadata")
        .and_then(|v| v.as_object_mut())
    {
        meta.remove("managedFields");
        meta.remove("resourceVersion");
        meta.remove("uid");
        meta.remove("selfLink");
        meta.remove("generation");
        meta.remove("creationTimestamp");
    }

    if resource.get("kind").and_then(|v| v.as_str()) == Some("Service") {
        if let Some(spec) = resource.get_mut("spec").and_then(|v| v.as_object_mut()) {
            spec.remove("clusterIP");
            spec.remove("clusterIPs");
            spec.remove("ipFamilies");
            spec.remove("ipFamilyPolicy");
            spec.remove("healthCheckNodePort");
        }
    }

    resource
}

fn extract_service_account_name(kind: &str, item: &Value) -> Option<String> {
    let raw = match kind {
        "Deployment" | "StatefulSet" | "DaemonSet" | "Job" => item
            .get("spec")
            .and_then(|v| v.get("template"))
            .and_then(|v| v.get("spec"))
            .and_then(|v| v.get("serviceAccountName"))
            .and_then(|v| v.as_str()),
        "CronJob" => item
            .get("spec")
            .and_then(|v| v.get("jobTemplate"))
            .and_then(|v| v.get("spec"))
            .and_then(|v| v.get("template"))
            .and_then(|v| v.get("spec"))
            .and_then(|v| v.get("serviceAccountName"))
            .and_then(|v| v.as_str()),
        _ => None,
    };

    raw.map(str::trim)
        .filter(|v| !v.is_empty() && *v != "default")
        .map(ToString::to_string)
}

fn is_cluster_scoped_kind(kind: &str) -> bool {
    matches!(
        kind,
        "IngressClass" | "ClusterRole" | "ClusterRoleBinding" | "StorageClass" | "PriorityClass"
    )
}

async fn ensure_service_account_exists(
    client: kube::Client,
    namespace: &str,
    service_account_name: &str,
) -> Result<(), String> {
    let sa_api: Api<ServiceAccount> = Api::namespaced(client, namespace);
    match sa_api.get_opt(service_account_name).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            let payload = json!({
                "apiVersion": "v1",
                "kind": "ServiceAccount",
                "metadata": {
                    "name": service_account_name,
                    "namespace": namespace,
                }
            });

            sa_api
                .patch(
                    service_account_name,
                    &PatchParams::apply("pertisk-kube-web").force(),
                    &Patch::Apply(payload),
                )
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

async fn apply_snapshot_resources(
    client: kube::Client,
    snapshot: &Value,
    include_namespaces: &[String],
    exclude_namespaces: &[String],
) -> Result<(usize, usize, Vec<String>), String> {
    let namespaces = snapshot
        .get("namespaces")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Backup snapshot missing namespaces data".to_string())?;

    let mut applied = 0usize;
    let mut skipped = 0usize;
    let mut warnings: Vec<String> = vec![];

    // Apply cluster-scoped resources first so namespaced resources can reference them.
    if let Some(cluster_resources) = snapshot.get("cluster_resources").and_then(|v| v.as_object()) {
        let cluster_apply_order = [
            "ingressclasses",
            "storageclasses",
            "priorityclasses",
            "clusterroles",
            "clusterrolebindings",
        ];

        let mut ordered_cluster_lists: Vec<&Value> = vec![];
        for key in cluster_apply_order {
            if let Some(resource_list) = cluster_resources.get(key) {
                ordered_cluster_lists.push(resource_list);
            }
        }
        for (key, resource_list) in cluster_resources {
            if cluster_apply_order.iter().any(|k| *k == key.as_str()) {
                continue;
            }
            ordered_cluster_lists.push(resource_list);
        }

        for resource_list in ordered_cluster_lists {
            let Some(items) = resource_list.as_array() else {
                continue;
            };

            for raw_item in items {
                let mut item = sanitize_snapshot_resource(raw_item.clone());
                let kind = item
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let api_version = item
                    .get("apiVersion")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let name = item
                    .get("metadata")
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                if kind.is_empty() || api_version.is_empty() || name.is_empty() {
                    skipped += 1;
                    continue;
                }

                if !is_cluster_scoped_kind(&kind) {
                    skipped += 1;
                    continue;
                }

                let Some(api_resource) = api_resource_for_known_kind(&kind, &api_version) else {
                    skipped += 1;
                    continue;
                };

                if let Some(meta) = item.get_mut("metadata").and_then(|v| v.as_object_mut()) {
                    meta.remove("namespace");
                }

                let obj: DynamicObject = match serde_json::from_value(item) {
                    Ok(v) => v,
                    Err(e) => {
                        warnings.push(format!("{} {} parse failed: {}", kind, name, e));
                        continue;
                    }
                };

                let api: Api<DynamicObject> = Api::all_with(client.clone(), &api_resource);
                match api
                    .patch(
                        &name,
                        &PatchParams::apply("pertisk-kube-web").force(),
                        &Patch::Apply(obj),
                    )
                    .await
                {
                    Ok(_) => applied += 1,
                    Err(e) => warnings.push(format!("{} {} apply failed: {}", kind, name, e)),
                }
            }
        }
    }

    for ns_entry in namespaces {
        let namespace = ns_entry
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        if namespace.is_empty() {
            continue;
        }

        if !include_namespaces.is_empty() && !include_namespaces.iter().any(|n| n == &namespace) {
            continue;
        }
        if exclude_namespaces.iter().any(|n| n == &namespace) {
            continue;
        }

        if let Err(e) = ensure_namespace(client.clone(), &namespace).await {
            warnings.push(format!("namespace {} ensure failed: {}", namespace, e));
            continue;
        }

        let resources_obj = match ns_entry.get("resources").and_then(|v| v.as_object()) {
            Some(v) => v,
            None => continue,
        };

        let apply_order = [
            "serviceaccounts",
            "roles",
            "rolebindings",
            "configmaps",
            "secrets",
            "persistent_volume_claims",
            "services",
            "networkpolicies",
            "ingresses",
            "deployments",
            "statefulsets",
            "daemonsets",
            "jobs",
            "cronjobs",
            "horizontalpodautoscalers",
            "poddisruptionbudgets",
            "pods",
        ];

        let mut ordered_resource_lists: Vec<&Value> = vec![];
        for key in apply_order {
            if let Some(resource_list) = resources_obj.get(key) {
                ordered_resource_lists.push(resource_list);
            }
        }
        for (key, resource_list) in resources_obj {
            if apply_order.iter().any(|k| *k == key.as_str()) {
                continue;
            }
            ordered_resource_lists.push(resource_list);
        }

        for resource_list in ordered_resource_lists {
            let Some(items) = resource_list.as_array() else {
                continue;
            };

            for raw_item in items {
                let mut item = sanitize_snapshot_resource(raw_item.clone());
                let kind = item
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let api_version = item
                    .get("apiVersion")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let name = item
                    .get("metadata")
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                if kind.is_empty() || api_version.is_empty() || name.is_empty() {
                    skipped += 1;
                    continue;
                }

                // Do not restore raw Pods directly; controllers/workloads should recreate them.
                if kind == "Pod" {
                    skipped += 1;
                    continue;
                }

                if let Some(sa_name) = extract_service_account_name(&kind, &item) {
                    if let Err(e) = ensure_service_account_exists(client.clone(), &namespace, &sa_name).await {
                        warnings.push(format!(
                            "{} {}/{} serviceaccount {} ensure failed: {}",
                            kind,
                            namespace,
                            name,
                            sa_name,
                            e
                        ));
                    }
                }

                let Some(api_resource) = api_resource_for_known_kind(&kind, &api_version) else {
                    skipped += 1;
                    continue;
                };

                if let Some(meta) = item.get_mut("metadata").and_then(|v| v.as_object_mut()) {
                    meta.insert("namespace".to_string(), Value::String(namespace.clone()));
                }

                let obj: DynamicObject = match serde_json::from_value(item) {
                    Ok(v) => v,
                    Err(e) => {
                        warnings.push(format!(
                            "{} {}/{} parse failed: {}",
                            kind,
                            namespace,
                            name,
                            e
                        ));
                        continue;
                    }
                };

                let api: Api<DynamicObject> =
                    Api::namespaced_with(client.clone(), &namespace, &api_resource);
                match api
                    .patch(
                        &name,
                        &PatchParams::apply("pertisk-kube-web").force(),
                        &Patch::Apply(obj),
                    )
                    .await
                {
                    Ok(_) => applied += 1,
                    Err(e) => warnings.push(format!(
                        "{} {}/{} apply failed: {}",
                        kind,
                        namespace,
                        name,
                        e
                    )),
                }
            }
        }
    }

    Ok((applied, skipped, warnings))
}

async fn restore_from_s3_snapshot(
    client: kube::Client,
    settings: &BackupSettings,
    backup_name: &str,
    include_namespaces: &[String],
    exclude_namespaces: &[String],
) -> Result<(usize, usize, Vec<String>), String> {
    let key = backup_snapshot_key(settings, backup_name);
    let content = get_object_with_retries(settings, &key).await?;
    let snapshot: Value = serde_json::from_slice(&content)
        .map_err(|e| format!("Invalid backup snapshot JSON for {}: {}", key, e))?;
    apply_snapshot_resources(client, &snapshot, include_namespaces, exclude_namespaces).await
}

async fn delete_backup_runs_by_names(
    client: kube::Client,
    names: &[String],
) -> Result<(usize, Vec<String>), String> {
    let requested: HashSet<String> = names
        .iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();

    if requested.is_empty() {
        return Ok((0, vec![]));
    }

    let mut runs = load_stored_backup_runs(client.clone()).await;
    let settings = load_settings(client.clone()).await;
    let mut warnings: Vec<String> = vec![];
    let runtime_namespace = SETTINGS_NAMESPACE;
    let backups_api: Option<Api<DynamicObject>> = if external_backup_crd_enabled() {
        Some(Api::namespaced_with(
            client.clone(),
            runtime_namespace,
            &backup_crd_resource("Backup"),
        ))
    } else {
        None
    };

    for backup_name in &requested {
        // Try to delete live Velero Backup CR as well so overview doesn't re-hydrate the row.
        if let Some(api) = &backups_api {
            match api.delete(backup_name, &DeleteParams::default()).await {
                Ok(_) => {}
                Err(e) => {
                    let err_text = e.to_string();
                    // Ignore expected "not found" and clusters without Backup CRD/API.
                    let expected_missing = err_text.contains("404")
                        || err_text.to_lowercase().contains("not found");
                    if !expected_missing {
                        warnings.push(format!("{}: backup CR delete failed: {}", backup_name, err_text));
                    }
                }
            }
        }

        let run = runs
            .iter()
            .find(|r| r.name.trim() == backup_name)
            .cloned();

        let key = if let Some(run) = &run {
            if run.object_key.trim().is_empty() {
                let prefix = settings.s3_prefix.trim().trim_matches('/');
                if prefix.is_empty() {
                    format!("{}.json", run.name)
                } else {
                    format!("{}/{}.json", prefix, run.name)
                }
            } else {
                run.object_key.clone()
            }
        } else {
            let prefix = settings.s3_prefix.trim().trim_matches('/');
            if prefix.is_empty() {
                format!("{}.json", backup_name)
            } else {
                format!("{}/{}.json", prefix, backup_name)
            }
        };

        if !settings.s3_bucket.trim().is_empty()
            && !settings.aws_access_key_id.trim().is_empty()
            && !settings.aws_secret_access_key.trim().is_empty()
        {
            if let Err(e) = delete_object_with_retries(&settings, &key).await {
                warnings.push(format!("{}: {}", backup_name, e));
            }
        }
    }

    let before = runs.len();
    runs.retain(|run| !requested.contains(run.name.trim()));
    let deleted = before.saturating_sub(runs.len());

    persist_stored_backup_runs(client, &runs).await?;
    Ok((deleted, warnings))
}

async fn upload_backup_run_to_s3(
    client: kube::Client,
    settings: &BackupSettings,
    schedule: &StoredSchedule,
    backup_name: &str,
    created_at: &str,
) -> Result<(String, String, BTreeMap<String, usize>, u64), String> {
    if settings.s3_bucket.trim().is_empty() {
        return Err("S3 bucket is required".to_string());
    }
    if settings.aws_access_key_id.trim().is_empty() || settings.aws_secret_access_key.trim().is_empty() {
        return Err("AWS access key and secret key are required".to_string());
    }

    let prefix = settings.s3_prefix.trim().trim_matches('/');
    let key = if prefix.is_empty() {
        format!("{}.json", backup_name)
    } else {
        format!("{}/{}.json", prefix, backup_name)
    };
    let (payload, resource_summary, kind_summary) = build_k8s_snapshot_payload(
        client,
        backup_name,
        schedule,
        created_at,
        &settings.storage_location_name,
    )
    .await;
    let body = serde_json::to_vec_pretty(&payload).map_err(|e| format!("Failed to encode backup payload: {}", e))?;
    put_object_with_retries(settings, &key, &body).await?;
    Ok((key, resource_summary, kind_summary, body.len() as u64))
}

fn parse_size_bytes(value: &Value) -> Option<u64> {
    if let Some(v) = value.as_u64() {
        return Some(v);
    }
    if let Some(v) = value.as_i64() {
        if v > 0 {
            return Some(v as u64);
        }
    }
    if let Some(v) = value.as_str() {
        let trimmed = v.trim();
        if let Ok(parsed) = trimmed.parse::<u64>() {
            return Some(parsed);
        }
    }
    None
}

fn extract_backup_size_bytes(backup: &DynamicObject) -> Option<u64> {
    let status = backup.data.get("status")?;

    let candidates = [
        status.pointer("/progress/totalBytes"),
        status.pointer("/progress/totalBytesDone"),
        status.pointer("/progress/bytesDone"),
        status.pointer("/totalBytes"),
        status.pointer("/totalBytesDone"),
    ];

    for candidate in candidates.into_iter().flatten() {
        if let Some(parsed) = parse_size_bytes(candidate) {
            return Some(parsed);
        }
    }

    None
}

fn build_resource_summary(include_namespaces: &[String], exclude_namespaces: &[String]) -> String {
    let include = if include_namespaces.is_empty() {
        "All namespaces".to_string()
    } else {
        format!("Include: {}", include_namespaces.join(", "))
    };

    let exclude = if exclude_namespaces.is_empty() {
        "Exclude: none".to_string()
    } else {
        format!("Exclude: {}", exclude_namespaces.join(", "))
    };

    format!("{} | {}", include, exclude)
}

fn fallback_kind_summary_from_resource_summary(resource_summary: &str) -> BTreeMap<String, usize> {
    let mut out: BTreeMap<String, usize> = BTreeMap::new();
    let normalized = resource_summary.trim().to_lowercase();
    if normalized.is_empty() {
        return out;
    }

    // Legacy records only have summary text. Provide a lightweight fallback so UI can show something useful.
    if normalized.contains("total resources:") {
        if let Some(idx) = normalized.find("total resources:") {
            let value = normalized[idx + "total resources:".len()..]
                .trim()
                .split_whitespace()
                .next()
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(0);
            if value > 0 {
                out.insert("resources_total".to_string(), value);
            }
        }
    }

    if normalized.contains("all namespaces") {
        out.insert("namespaces_scope_all".to_string(), 1);
    } else if normalized.contains("include:") {
        out.insert("namespaces_scope_filtered".to_string(), 1);
    }

    out
}

async fn trigger_schedule_run(client: kube::Client, schedule_name: &str, manual: bool) -> Result<String, String> {
    let mut schedules = load_stored_schedules(client.clone()).await;
    let schedule_index = schedules
        .iter()
        .position(|s| s.name == schedule_name)
        .ok_or_else(|| "Backup schedule not found".to_string())?;

    if schedules[schedule_index].paused {
        return Err("Backup schedule is paused".to_string());
    }

    let schedule_name_owned = schedules[schedule_index].name.clone();
    let schedule_snapshot = schedules[schedule_index].clone();

    let settings = load_settings(client.clone()).await;
    let now = Utc::now().to_rfc3339();
    let backup_name = format!("{}-{}", schedule_name_owned, Utc::now().format("%Y%m%d%H%M%S"));

    schedules[schedule_index].last_run_at = Some(now.clone());
    schedules[schedule_index].updated_at = now.clone();

    persist_stored_schedules(client.clone(), &schedules).await?;

    let upload_result = upload_backup_run_to_s3(
        client.clone(),
        &settings,
        &schedule_snapshot,
        &backup_name,
        &now,
    )
    .await;
    let phase = if upload_result.is_ok() { "Completed" } else { "Failed" };
    let upload_meta = upload_result.as_ref().ok();
    let object_key = upload_meta
        .map(|(key, _, _, _)| key.clone())
        .unwrap_or_default();
    let resource_summary = upload_meta
        .map(|(_, summary, _, _)| summary.clone())
        .unwrap_or_else(|| {
        build_resource_summary(
            &schedule_snapshot.include_namespaces,
            &schedule_snapshot.exclude_namespaces,
        )
    });
    let kind_summary = upload_meta
        .map(|(_, _, summary, _)| summary.clone())
        .unwrap_or_default();
    let size_bytes = upload_meta
        .map(|(_, _, _, size)| *size);

    let mut runs = load_stored_backup_runs(client.clone()).await;
    runs.push(StoredBackupRun {
        name: backup_name.clone(),
        schedule_name: schedule_name_owned,
        phase: phase.to_string(),
        storage_location: settings.storage_location_name,
        created_at: now,
        manual,
        object_key,
        size_bytes,
        include_namespaces: schedule_snapshot.include_namespaces.clone(),
        exclude_namespaces: schedule_snapshot.exclude_namespaces.clone(),
        resource_summary,
        kind_summary,
    });

    if runs.len() > 500 {
        let keep_from = runs.len() - 500;
        runs = runs.split_off(keep_from);
    }

    persist_stored_backup_runs(client, &runs).await?;

    if let Err(e) = upload_result {
        return Err(e);
    }

    Ok(backup_name)
}

async fn run_due_schedules(client: kube::Client) {
    let schedules = load_stored_schedules(client.clone()).await;
    for schedule in schedules {
        if schedule.paused {
            continue;
        }

        let normalized_cron = match normalize_cron_expression(schedule.cron.trim()) {
            Ok(v) => v,
            Err(e) => {
                error!("Invalid cron expression for schedule {}: {}", schedule.name, e);
                continue;
            }
        };

        let parsed = match Schedule::from_str(&normalized_cron) {
            Ok(v) => v,
            Err(e) => {
                error!("Invalid cron expression for schedule {}: {}", schedule.name, e);
                continue;
            }
        };

        let updated_dt = chrono::DateTime::parse_from_rfc3339(&schedule.updated_at)
            .ok()
            .map(|v| v.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);

        let baseline_dt = schedule
            .last_run_at
            .as_ref()
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.with_timezone(&Utc))
            .unwrap_or(updated_dt);

        let now = Utc::now();
        if let Some(next_after_baseline) = parsed.after(&baseline_dt).next() {
            if next_after_baseline <= now {
                match trigger_schedule_run(client.clone(), &schedule.name, false).await {
                    Ok(run_name) => info!("Scheduled backup run created: {}", run_name),
                    Err(e) => error!("Failed to execute schedule {}: {}", schedule.name, e),
                }
            }
        }
    }
}

pub fn start_backup_scheduler_worker(state: AppState) {
    tokio::spawn(async move {
        loop {
            // Placeholder client points at localhost and cannot reach a cluster.
            // Skip until kubeconfig is uploaded/selected via the UI.
            if !state.is_auth_placeholder() {
                run_due_schedules(state.kube_client().await).await;
            }
            sleep(Duration::from_secs(30)).await;
        }
    });
}

async fn apply_s3_and_schedule(client: kube::Client, settings: &BackupSettings) -> Result<String, String> {
    if settings.s3_bucket.trim().is_empty() {
        return Err("S3 bucket is required".to_string());
    }
    if settings.aws_access_key_id.trim().is_empty() || settings.aws_secret_access_key.trim().is_empty() {
        return Err("AWS access key and secret key are required".to_string());
    }

    let runtime_namespace = SETTINGS_NAMESPACE;
    let secret_name = settings.credentials_secret_name.trim();

    ensure_namespace(client.clone(), SETTINGS_NAMESPACE).await?;

    let secret_api: Api<Secret> = Api::namespaced(client.clone(), runtime_namespace);
    let cloud_credentials = format!(
        "[default]\naws_access_key_id={}\naws_secret_access_key={}\n",
        settings.aws_access_key_id, settings.aws_secret_access_key
    );

    let secret = json!({
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {
            "name": secret_name,
            "namespace": runtime_namespace,
        },
        "type": "Opaque",
        "stringData": {
            "cloud": cloud_credentials,
        }
    });

    secret_api
        .patch(
            secret_name,
            &PatchParams::apply("pertisk-kube-web").force(),
            &Patch::Apply(secret),
        )
        .await
        .map_err(|e| format!("Failed to apply secret: {}", e))?;

    if !external_backup_crd_enabled() {
        return Ok(
            "Backup config applied in internal mode. Settings and credentials were stored in pertisk-backups; external backup CRDs are disabled."
                .to_string(),
        );
    }

    let mut bsl_config = serde_json::Map::new();
    bsl_config.insert("region".to_string(), Value::String(settings.s3_region.clone()));
    bsl_config.insert(
        "s3ForcePathStyle".to_string(),
        Value::String(settings.s3_force_path_style.to_string()),
    );
    bsl_config.insert(
        "insecureSkipTLSVerify".to_string(),
        Value::String(settings.s3_insecure_skip_tls_verify.to_string()),
    );
    if !settings.s3_url.trim().is_empty() {
        bsl_config.insert("s3Url".to_string(), Value::String(settings.s3_url.clone()));
    }

    let bsl_api: Api<DynamicObject> = Api::namespaced_with(client.clone(), runtime_namespace, &backup_crd_resource("BackupStorageLocation"));
    let bsl = json!({
        "apiVersion": "velero.io/v1",
        "kind": "BackupStorageLocation",
        "metadata": {
            "name": settings.storage_location_name,
            "namespace": runtime_namespace,
        },
        "spec": {
            "provider": "aws",
            "objectStorage": {
                "bucket": settings.s3_bucket,
                "prefix": settings.s3_prefix,
            },
            "credential": {
                "name": secret_name,
                "key": "cloud",
            },
            "config": Value::Object(bsl_config),
            "default": true
        }
    });

    match bsl_api
        .patch(
            &settings.storage_location_name,
            &PatchParams::apply("pertisk-kube-web").force(),
            &Patch::Apply(bsl),
        )
        .await
    {
        Ok(_) => {}
        Err(e) => {
            let error_text = e.to_string();
            if is_missing_backup_api_error(&error_text) {
                info!(
                    "Backup CRDs/API not available; saved config only in {}",
                    SETTINGS_NAMESPACE
                );
                return Ok(format!(
                    "Backup config saved in pertisk-backups, but backup CRDs/API are not installed, so BackupStorageLocation/Schedule resources were skipped."
                ));
            }
            return Err(format!("Failed to apply backup storage location: {}", error_text));
        }
    }

    if !settings.schedule_enabled {
        return Ok("Backup config applied. Settings and credentials were stored in pertisk-backups. Backup CRDs/API were not required because schedule is disabled.".to_string());
    }

    if settings.schedule_enabled {
        let schedule_api: Api<DynamicObject> = Api::namespaced_with(client.clone(), runtime_namespace, &backup_crd_resource("Schedule"));

        let schedule = json!({
            "apiVersion": "velero.io/v1",
            "kind": "Schedule",
            "metadata": {
                "name": settings.schedule_name,
                "namespace": runtime_namespace,
            },
            "spec": {
                "schedule": settings.schedule_cron,
                "template": {
                    "includedNamespaces": [],
                    "excludedNamespaces": [],
                    "storageLocation": settings.storage_location_name,
                    "ttl": settings.ttl,
                    "snapshotVolumes": true
                }
            }
        });

        match schedule_api
            .patch(
                &settings.schedule_name,
                &PatchParams::apply("pertisk-kube-web").force(),
                &Patch::Apply(schedule),
            )
            .await
        {
            Ok(_) => Ok("Backup config applied. Settings, credentials, and backup schedule were updated in pertisk-backups.".to_string()),
            Err(e) => {
                let error_text = e.to_string();
                if is_missing_backup_api_error(&error_text) {
                    Ok("Backup config saved in pertisk-backups, but backup CRDs/API are not installed, so BackupStorageLocation/Schedule resources were skipped.".to_string())
                } else {
                    Err(format!("Failed to apply schedule: {}", error_text))
                }
            }
        }
    } else {
        let schedule_api: Api<DynamicObject> = Api::namespaced_with(client.clone(), runtime_namespace, &backup_crd_resource("Schedule"));

        match schedule_api
            .delete(&settings.schedule_name, &DeleteParams::default())
            .await
        {
            Ok(_) => Ok("Backup config applied. Settings and credentials were stored in pertisk-backups.".to_string()),
            Err(e) => {
                let error_text = e.to_string();
                if is_missing_backup_api_error(&error_text) {
                    Ok("Backup config saved in pertisk-backups, but backup CRDs/API are not installed, so runtime backup resources were skipped.".to_string())
                } else {
                    Err(format!("Failed to remove schedule: {}", error_text))
                }
            }
        }
    }
}

pub async fn get_backup_settings(State(state): State<AppState>) -> impl IntoResponse {
    let settings = load_settings(state.kube_client().await).await;
    (StatusCode::OK, Json(settings)).into_response()
}

pub async fn save_backup_settings(
    State(state): State<AppState>,
    Json(settings): Json<BackupSettings>,
) -> impl IntoResponse {
    match persist_settings(state.kube_client().await, &settings).await {
        Ok(()) => (StatusCode::OK, Json(json!({"success": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "message": e})),
        )
            .into_response(),
    }
}

pub async fn save_backup_s3_config(
    State(state): State<AppState>,
    Json(req): Json<S3ConfigRequest>,
) -> impl IntoResponse {
    let mut settings = load_settings(state.kube_client().await).await;
    settings.storage_location_name = req.storage_location_name;
    settings.credentials_secret_name = req.credentials_secret_name;
    settings.s3_bucket = req.s3_bucket;
    settings.s3_region = req.s3_region;
    settings.s3_prefix = req.s3_prefix;
    settings.s3_url = req.s3_url;
    settings.s3_force_path_style = req.s3_force_path_style;
    settings.s3_insecure_skip_tls_verify = req.s3_insecure_skip_tls_verify;
    settings.aws_access_key_id = req.aws_access_key_id;
    settings.aws_secret_access_key = req.aws_secret_access_key;

    match persist_settings(state.kube_client().await, &settings).await {
        Ok(()) => (StatusCode::OK, Json(json!({"success": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "message": e})),
        )
            .into_response(),
    }
}

pub async fn apply_backup_settings(State(state): State<AppState>) -> impl IntoResponse {
    let settings = load_settings(state.kube_client().await).await;
    match apply_s3_and_schedule(state.kube_client().await, &settings).await {
        Ok(message) => (
            StatusCode::OK,
            Json(json!({"success": true, "message": message})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": e})),
        )
            .into_response(),
    }
}

pub async fn run_manual_backup(
    State(state): State<AppState>,
    Json(req): Json<ManualBackupRequest>,
) -> impl IntoResponse {
    let settings = load_settings(state.kube_client().await).await;

    let backup_name = req.name.unwrap_or_else(|| {
        format!(
            "manual-{}",
            Utc::now().format("%Y%m%d%H%M%S")
        )
    });

    let included_namespaces = req.include_namespaces.unwrap_or_default();
    let excluded_namespaces = req.exclude_namespaces.unwrap_or_default();

    if !external_backup_crd_enabled() {
        let now = Utc::now().to_rfc3339();
        let schedule = StoredSchedule {
            name: "manual".to_string(),
            cron: String::new(),
            timezone: default_timezone(),
            paused: false,
            include_namespaces: included_namespaces.clone(),
            exclude_namespaces: excluded_namespaces.clone(),
            updated_at: now.clone(),
            last_run_at: Some(now.clone()),
        };

        let upload_result = upload_backup_run_to_s3(
            state.kube_client().await,
            &settings,
            &schedule,
            &backup_name,
            &now,
        )
        .await;
        let phase = if upload_result.is_ok() { "Completed" } else { "Failed" };
        let upload_meta = upload_result.as_ref().ok();
        let object_key = upload_meta
            .map(|(key, _, _, _)| key.clone())
            .unwrap_or_default();
        let resource_summary = upload_meta
            .map(|(_, summary, _, _)| summary.clone())
            .unwrap_or_else(|| build_resource_summary(&included_namespaces, &excluded_namespaces));
        let kind_summary = upload_meta
            .map(|(_, _, summary, _)| summary.clone())
            .unwrap_or_default();
        let size_bytes = upload_meta.map(|(_, _, _, size)| *size);

        let mut runs = load_stored_backup_runs(state.kube_client().await).await;
        runs.push(StoredBackupRun {
            name: backup_name.clone(),
            schedule_name: "manual".to_string(),
            phase: phase.to_string(),
            storage_location: settings.storage_location_name.clone(),
            created_at: now,
            manual: true,
            object_key,
            size_bytes,
            include_namespaces: included_namespaces,
            exclude_namespaces: excluded_namespaces,
            resource_summary,
            kind_summary,
        });

        if runs.len() > 500 {
            let keep_from = runs.len() - 500;
            runs = runs.split_off(keep_from);
        }

        if let Err(e) = persist_stored_backup_runs(state.kube_client().await, &runs).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"success": false, "message": format!("Failed to persist manual backup record: {}", e)})),
            )
                .into_response();
        }

        return match upload_result {
            Ok(_) => (
                StatusCode::OK,
                Json(json!({"success": true, "name": backup_name, "message": "Manual backup completed in internal mode"})),
            )
                .into_response(),
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(json!({"success": false, "name": backup_name, "message": format!("Manual backup failed in internal mode: {}", e)})),
            )
                .into_response(),
        };
    }

    let runtime_namespace = SETTINGS_NAMESPACE;
    let backups_api: Api<DynamicObject> =
        Api::namespaced_with(state.kube_client().await, runtime_namespace, &backup_crd_resource("Backup"));

    let backup = json!({
        "apiVersion": "velero.io/v1",
        "kind": "Backup",
        "metadata": {
            "name": backup_name,
            "namespace": runtime_namespace,
        },
        "spec": {
            "includedNamespaces": included_namespaces,
            "excludedNamespaces": excluded_namespaces,
            "storageLocation": settings.storage_location_name,
            "ttl": settings.ttl,
            "snapshotVolumes": true
        }
    });

    match backups_api
        .patch(
            &backup_name,
            &PatchParams::apply("pertisk-kube-web").force(),
            &Patch::Apply(backup),
        )
        .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({"success": true, "name": backup_name})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": format!("Failed to create backup: {}", e)})),
        )
            .into_response(),
    }
}

pub async fn run_restore(
    State(state): State<AppState>,
    Json(req): Json<RestoreRequest>,
) -> impl IntoResponse {
    if req.backup_name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": "backup_name is required"})),
        )
            .into_response();
    }

    let runtime_namespace = SETTINGS_NAMESPACE;
    let restores_api: Api<DynamicObject> =
        Api::namespaced_with(state.kube_client().await, runtime_namespace, &backup_crd_resource("Restore"));

    let restore_name = req.restore_name.unwrap_or_else(|| {
        format!(
            "restore-{}",
            Utc::now().format("%Y%m%d%H%M%S")
        )
    });

    let include_namespaces = req.include_namespaces.unwrap_or_default();
    let exclude_namespaces = req.exclude_namespaces.unwrap_or_default();

    if !external_backup_crd_enabled() {
        let settings = load_settings(state.kube_client().await).await;
        return match restore_from_s3_snapshot(
            state.kube_client().await,
            &settings,
            &req.backup_name,
            &include_namespaces,
            &exclude_namespaces,
        )
        .await
        {
            Ok((applied, skipped, warnings)) => {
                let message = if warnings.is_empty() {
                    format!(
                        "Restore completed from snapshot in internal mode. Applied {} resource(s), skipped {}.",
                        applied, skipped
                    )
                } else {
                    format!(
                        "Restore completed with warnings in internal mode. Applied {} resource(s), skipped {}.",
                        applied, skipped
                    )
                };

                (
                    StatusCode::OK,
                    Json(json!({
                        "success": true,
                        "name": restore_name,
                        "message": message,
                        "warnings": warnings,
                        "mode": "internal-snapshot"
                    })),
                )
                    .into_response()
            }
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "success": false,
                    "message": format!("Restore failed in internal mode: {}", e)
                })),
            )
                .into_response(),
        };
    }

    let restore = json!({
        "apiVersion": "velero.io/v1",
        "kind": "Restore",
        "metadata": {
            "name": restore_name,
            "namespace": runtime_namespace,
        },
        "spec": {
            "backupName": req.backup_name,
            "includedNamespaces": include_namespaces,
            "excludedNamespaces": exclude_namespaces
        }
    });

    match restores_api
        .patch(
            &restore_name,
            &PatchParams::apply("pertisk-kube-web").force(),
            &Patch::Apply(restore),
        )
        .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({"success": true, "name": restore_name})),
        )
            .into_response(),
        Err(e) => {
            let err_text = e.to_string();
            if err_text.contains("404") {
                warn!(
                    "Restore CR API unavailable, using S3 snapshot fallback for backup {}",
                    req.backup_name
                );

                let settings = load_settings(state.kube_client().await).await;
                match restore_from_s3_snapshot(
                    state.kube_client().await,
                    &settings,
                    &req.backup_name,
                    &include_namespaces,
                    &exclude_namespaces,
                )
                .await
                {
                    Ok((applied, skipped, warnings)) => {
                        let message = if warnings.is_empty() {
                            format!(
                                "Restore completed from snapshot. Applied {} resource(s), skipped {}.",
                                applied, skipped
                            )
                        } else {
                            format!(
                                "Restore completed with warnings. Applied {} resource(s), skipped {}.",
                                applied, skipped
                            )
                        };

                        (
                            StatusCode::OK,
                            Json(json!({
                                "success": true,
                                "name": restore_name,
                                "message": message,
                                "warnings": warnings,
                                "mode": "snapshot-fallback"
                            })),
                        )
                            .into_response()
                    }
                    Err(fallback_err) => (
                        StatusCode::BAD_REQUEST,
                        Json(json!({
                            "success": false,
                            "message": format!(
                                "Failed to create restore CR and snapshot fallback also failed: {}",
                                fallback_err
                            )
                        })),
                    )
                        .into_response(),
                }
            } else {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"success": false, "message": format!("Failed to create restore: {}", e)})),
                )
                    .into_response()
            }
        }
    }
}

pub async fn create_backup_schedule(
    State(state): State<AppState>,
    Json(req): Json<CreateScheduleRequest>,
) -> impl IntoResponse {
    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": "Schedule name is required"})),
        )
            .into_response();
    }
    if req.cron.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": "Schedule cron is required"})),
        )
            .into_response();
    }

    let normalized_cron = match normalize_cron_expression(req.cron.trim()) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"success": false, "message": e})),
            )
                .into_response();
        }
    };

    if let Err(e) = Schedule::from_str(&normalized_cron) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "message": format!("Invalid cron expression: {}", e)
            })),
        )
            .into_response();
    }

    if let Err(e) = ensure_namespace(state.kube_client().await, SETTINGS_NAMESPACE).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "message": e})),
        )
            .into_response();
    }

    let mut schedules = load_stored_schedules(state.kube_client().await).await;
    let schedule_name = req.name.trim().to_string();
    let now = Utc::now().to_rfc3339();
    let include_namespaces = req.include_namespaces.unwrap_or_default();
    let exclude_namespaces = req.exclude_namespaces.unwrap_or_default();
    let paused = req.paused.unwrap_or(false);
    let timezone = req.timezone.unwrap_or_else(default_timezone);

    if let Some(existing) = schedules.iter_mut().find(|s| s.name == schedule_name) {
        existing.cron = normalized_cron.clone();
        existing.timezone = timezone;
        existing.paused = paused;
        existing.include_namespaces = include_namespaces;
        existing.exclude_namespaces = exclude_namespaces;
        existing.updated_at = now;
    } else {
        schedules.push(StoredSchedule {
            name: schedule_name.clone(),
            cron: normalized_cron,
            timezone,
            paused,
            include_namespaces,
            exclude_namespaces,
            updated_at: now,
            last_run_at: None,
        });
    }

    match persist_stored_schedules(state.kube_client().await, &schedules).await {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({"success": true, "name": schedule_name, "message": "Backup schedule saved"})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": format!("Failed to save schedule: {}", e)})),
        )
            .into_response(),
    }
}

pub async fn delete_backup_schedule(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    if name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": "Schedule name is required"})),
        )
            .into_response();
    }

    let mut schedules = load_stored_schedules(state.kube_client().await).await;
    let before = schedules.len();
    schedules.retain(|s| s.name != name.trim());

    match persist_stored_schedules(state.kube_client().await, &schedules).await {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "message": if schedules.len() == before { "Backup schedule not found" } else { "Backup schedule deleted" }
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": format!("Failed to delete schedule: {}", e)})),
        )
            .into_response(),
    }
}

pub async fn run_backup_schedule_manual(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    if name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": "Schedule name is required"})),
        )
            .into_response();
    }

    match trigger_schedule_run(state.kube_client().await, name.trim(), true).await {
        Ok(run_name) => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "name": run_name,
                "message": "Manual run triggered"
            })),
        )
            .into_response(),
        Err(e) => {
            let status = if e.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            (
                status,
                Json(json!({"success": false, "message": e})),
            )
                .into_response()
        }
    }
}

pub async fn delete_backup_run(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    let backup_name = name.trim();
    if backup_name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": "Backup name is required"})),
        )
            .into_response();
    }

    match delete_backup_runs_by_names(state.kube_client().await, &[backup_name.to_string()]).await {
        Ok((deleted_count, warnings)) => {
            let message = if warnings.is_empty() {
                format!(
                    "Backup {} removed from list ({} record); backup CR and S3 cleanup attempted",
                    backup_name,
                    deleted_count
                )
            } else {
                format!(
                    "Backup {} removed from list ({} record). S3 object deletion warning: {}",
                    backup_name,
                    deleted_count,
                    warnings.join(" | ")
                )
            };
            (StatusCode::OK, Json(json!({
                "success": true,
                "message": message,
                "deleted": deleted_count,
                "warnings": warnings,
            }))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "message": e})),
        ).into_response(),
    }
}

pub async fn download_backup_run(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    let backup_name = name.trim();
    if backup_name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": "Backup name is required"})),
        )
            .into_response();
    }

    let settings = load_settings(state.kube_client().await).await;
    let object_key = load_stored_backup_runs(state.kube_client().await)
        .await
        .into_iter()
        .find(|run| run.name.trim() == backup_name)
        .and_then(|run| {
            let key = run.object_key.trim().to_string();
            if key.is_empty() { None } else { Some(key) }
        })
        .unwrap_or_else(|| backup_snapshot_key(&settings, backup_name));

    match get_object_with_retries(&settings, &object_key).await {
        Ok(content) => {
            let filename = format!("{}.json", backup_name.replace('"', "_"));
            let content_disposition = format!("attachment; filename=\"{}\"", filename);
            let headers = [
                (header::CONTENT_TYPE, HeaderValue::from_static("application/json")),
                (
                    header::CONTENT_DISPOSITION,
                    HeaderValue::from_str(&content_disposition)
                        .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
                ),
            ];
            (StatusCode::OK, headers, content).into_response()
        }
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(json!({
                "success": false,
                "message": format!("Failed to download backup '{}': {}", backup_name, e)
            })),
        )
            .into_response(),
    }
}

pub async fn delete_backup_runs_bulk(
    State(state): State<AppState>,
    Json(req): Json<BulkDeleteBackupsRequest>,
) -> impl IntoResponse {
    if req.names.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "message": "Backup names are required"})),
        )
            .into_response();
    }

    match delete_backup_runs_by_names(state.kube_client().await, &req.names).await {
        Ok((deleted_count, warnings)) => {
            let message = if warnings.is_empty() {
                format!(
                    "Deleted {} backup record(s) from list; backup CR and S3 cleanup attempted",
                    deleted_count
                )
            } else {
                format!(
                    "Deleted {} backup record(s) from list. Some S3 delete warnings occurred",
                    deleted_count
                )
            };
            (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "message": message,
                    "deleted": deleted_count,
                    "warnings": warnings,
                })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "message": e})),
        )
            .into_response(),
    }
}

pub async fn get_backup_overview(State(state): State<AppState>) -> impl IntoResponse {
    let mut merged_backups: HashMap<String, BackupRecord> = load_stored_backup_runs(state.kube_client().await)
        .await
        .into_iter()
        .map(|r| {
            let resource_summary = if r.resource_summary.is_empty() {
                build_resource_summary(&r.include_namespaces, &r.exclude_namespaces)
            } else {
                r.resource_summary
            };

            BackupRecord {
                name: r.name,
                phase: r.phase,
                storage_location: r.storage_location,
                created_at: r.created_at,
                size_bytes: r.size_bytes,
                include_namespaces: r.include_namespaces,
                exclude_namespaces: r.exclude_namespaces,
                kind_summary: if r.kind_summary.is_empty() {
                    fallback_kind_summary_from_resource_summary(&resource_summary)
                } else {
                    r.kind_summary
                },
                resource_summary,
            }
        })
        .map(|record| (record.name.clone(), record))
        .collect();

    if external_backup_crd_enabled() {
        // Also pull live Velero Backup CRs so list is available when switching clusters.
        // If the API returns 404, back off for a short cooldown to avoid repeated noisy kube-client warnings.
        let now_epoch = Utc::now().timestamp();
        let retry_at = BACKUP_API_RETRY_AT_EPOCH_SECONDS.load(Ordering::Relaxed);
        if now_epoch >= retry_at {
            let runtime_namespace = SETTINGS_NAMESPACE;
            let backups_api: Api<DynamicObject> =
                Api::namespaced_with(state.kube_client().await, runtime_namespace, &backup_crd_resource("Backup"));

            match backups_api.list(&ListParams::default()).await {
                Ok(list) => {
                    BACKUP_API_RETRY_AT_EPOCH_SECONDS.store(0, Ordering::Relaxed);
                    for backup in list.items {
                        let name = backup.metadata.name.clone().unwrap_or_default();
                        if name.is_empty() {
                            continue;
                        }

                        let include_namespaces: Vec<String> = backup
                            .data
                            .get("spec")
                            .and_then(|v| v.get("includedNamespaces"))
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|item| item.as_str().map(ToString::to_string))
                                    .collect()
                            })
                            .unwrap_or_default();

                        let exclude_namespaces: Vec<String> = backup
                            .data
                            .get("spec")
                            .and_then(|v| v.get("excludedNamespaces"))
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|item| item.as_str().map(ToString::to_string))
                                    .collect()
                            })
                            .unwrap_or_default();

                        let resource_summary = build_resource_summary(&include_namespaces, &exclude_namespaces);

                        let live_record = BackupRecord {
                            name: name.clone(),
                            phase: backup
                                .data
                                .get("status")
                                .and_then(|v| v.get("phase"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("Unknown")
                                .to_string(),
                            storage_location: backup
                                .data
                                .get("spec")
                                .and_then(|v| v.get("storageLocation"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            created_at: backup
                                .metadata
                                .creation_timestamp
                                .as_ref()
                                .map(|ts| ts.0.to_rfc3339())
                                .unwrap_or_default(),
                            size_bytes: extract_backup_size_bytes(&backup)
                                .or_else(|| merged_backups.get(&name).and_then(|record| record.size_bytes)),
                            include_namespaces,
                            exclude_namespaces,
                            kind_summary: fallback_kind_summary_from_resource_summary(&resource_summary),
                            resource_summary,
                        };

                        // Prefer live CR data when both stored and live entries exist.
                        merged_backups.insert(name, live_record);
                    }
                }
                Err(e) => {
                    let err_text = e.to_string();
                    if err_text.contains("404") {
                        let next_retry = now_epoch + BACKUP_API_RETRY_COOLDOWN_SECONDS;
                        BACKUP_API_RETRY_AT_EPOCH_SECONDS.store(next_retry, Ordering::Relaxed);
                        debug!(
                            "Backup CR list endpoint unavailable (404). Skipping re-probe for {}s.",
                            BACKUP_API_RETRY_COOLDOWN_SECONDS
                        );
                    } else {
                        info!("Backup CR list not available for overview: {}", err_text);
                    }
                }
            }
        }
    }

    let should_load_s3_metadata = merged_backups.is_empty()
        || merged_backups
            .values()
            .any(|record| record.size_bytes.is_none());

    if should_load_s3_metadata {
        let settings = load_settings(state.kube_client().await).await;
        for record in load_backup_runs_from_s3(&settings).await {
            if let Some(existing) = merged_backups.get_mut(&record.name) {
                if existing.size_bytes.is_none() {
                    existing.size_bytes = record.size_bytes;
                }
            } else {
                merged_backups.insert(record.name.clone(), record);
            }
        }
    }

    let mut backups: Vec<BackupRecord> = merged_backups.into_values().collect();

    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    let schedules: Vec<ScheduleRecord> = load_stored_schedules(state.kube_client().await)
        .await
        .into_iter()
        .map(|s| ScheduleRecord {
            name: s.name,
            cron: s.cron,
            timezone: if s.timezone.is_empty() { default_timezone() } else { s.timezone },
            last_backup: s.last_run_at.unwrap_or_default(),
            paused: s.paused,
            include_namespaces: s.include_namespaces,
            exclude_namespaces: s.exclude_namespaces,
        })
        .collect();
    let restores: Vec<RestoreRecord> = vec![];

    info!("Backup overview loaded: {} backups, {} schedules, {} restores", backups.len(), schedules.len(), restores.len());
    (
        StatusCode::OK,
        Json(BackupOverview {
            backups,
            schedules,
            restores,
        }),
    )
        .into_response()
}
