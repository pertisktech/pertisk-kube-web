use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::Response,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use kube::Client;
use std::{
    env,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::RwLock;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};
use tonic::transport::Server;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

mod grpc_service;
mod proto;
mod ws_handler;

pub mod auth;
pub mod handlers;
pub mod models;
pub mod utils;

use auth::{login, refresh_token, require_basic_auth};
use handlers::{
    backup::*,
    cluster::*,
    config::*,
    crd::*,
    helm::*,
    namespaces::*,
    network::*,
    portforward::*,
    rbac::*,
    resource_map::*,
    storage::*,
    workloads::*,
};
use models::*;

#[derive(Clone)]
pub struct AppState {
    pub client: Arc<RwLock<Client>>,
    pub username: String,
    pub password: String,
    pub jwt_secret: String,
    pub port_forward_state: Option<Arc<handlers::portforward::PortForwardState>>,
    pub workload_metric_history: Arc<RwLock<Vec<WorkloadMetricSnapshot>>>,
    pub auth_placeholder: Arc<AtomicBool>,
    pub auth_message: Arc<RwLock<Option<String>>>,
    pub current_context: Arc<RwLock<Option<String>>>,
    pub kubeconfig_path: Arc<RwLock<String>>,
}

impl AppState {
    pub async fn kube_client(&self) -> Client {
        self.client.read().await.clone()
    }

    pub fn is_auth_placeholder(&self) -> bool {
        self.auth_placeholder.load(Ordering::Relaxed)
    }

    pub async fn auth_user_message(&self) -> Option<String> {
        self.auth_message.read().await.clone()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,kube_client::client=error"));
    tracing_subscriber::fmt()
        .json()
        .with_current_span(true)
        .with_span_list(true)
        .with_env_filter(env_filter)
        .init();

    // Always start — use a placeholder client when kubeconfig/credentials are missing.
    // Cluster can be configured later via /api/cluster/kubeconfig.
    let (client, kube_status) = utils::load_kube_client_with_status().await?;

    let username = env::var("USERNAME").unwrap_or_else(|_| "admin".to_string());
    let password = env::var("PASSWORD").unwrap_or_else(|_| "admin".to_string());
    let jwt_secret = env::var("JWT_SECRET").unwrap_or_else(|_| "your-secret-key-change-in-production".to_string());

    let port_forward_state = Some(Arc::new(handlers::portforward::PortForwardState::new()));
    let shared_client = Arc::new(RwLock::new(client));
    let auth_placeholder = Arc::new(AtomicBool::new(kube_status.is_placeholder));
    let auth_message = Arc::new(RwLock::new(kube_status.user_message.clone()));
    let initial_context = env::var("KUBE_CONTEXT").ok().filter(|s| !s.trim().is_empty());
    let initial_kubeconfig_path = utils::default_kubeconfig_path().display().to_string();

    if kube_status.is_placeholder {
        info!(
            message = kube_status.user_message.as_deref().unwrap_or("placeholder"),
            "Starting with placeholder Kubernetes client; configure cluster via UI"
        );
        // Only retry in-process upgrade when a kubeconfig/context already exists
        // (e.g. exec credential not ready yet). With no kubeconfig, wait for UI upload.
        if utils::has_resolvable_kube_context() {
            let client_ref = Arc::clone(&shared_client);
            let placeholder_ref = Arc::clone(&auth_placeholder);
            let message_ref = Arc::clone(&auth_message);
            tokio::spawn(async move {
                utils::upgrade_kube_client_in_background(client_ref, placeholder_ref, message_ref)
                    .await;
            });
        }
    }

    let state = AppState {
        client: shared_client,
        username,
        password,
        jwt_secret,
        port_forward_state,
        workload_metric_history: Arc::new(RwLock::new(Vec::new())),
        auth_placeholder,
        auth_message,
        current_context: Arc::new(RwLock::new(initial_context)),
        kubeconfig_path: Arc::new(RwLock::new(initial_kubeconfig_path)),
    };

    start_backup_scheduler_worker(state.clone());

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    let static_dir: PathBuf = env::var("STATIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("frontend/dist"));

    let public_api = Router::new()
        .route("/health", get(health))
        .route("/readiness", get(readiness))
        .route("/auth-status", get(auth_status))
        .route("/cluster/status", get(cluster_status))
        .route("/login", post(login));

    let refresh_api = Router::new()
        .route("/refresh", post(refresh_token))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_basic_auth,
        ));

    let protected_api = Router::new()
        .route("/cluster/kubeconfig", post(upload_kubeconfig))
        .route("/cluster/select", post(select_cluster_context))
        .route("/dashboard", get(get_dashboard_summary))
        .route("/resource-map", get(get_resource_map))
        .route("/nodes", get(list_nodes))
        .route(
            "/nodes/:name/yaml",
            get(get_node_yaml).put(update_node_yaml),
        )
        .route("/nodes/:name", delete(delete_node))
        .route("/nodes/:name/cordon", post(cordon_node))
        .route("/nodes/:name/uncordon", post(uncordon_node))
        .route("/nodes/:name/drain", post(drain_node))
        .route("/namespaces", get(list_namespaces))
        .route("/pods", get(list_pods))
        .route("/metrics/workloads/series", get(get_workload_metric_series))
        .route(
            "/pods/:namespace/:name/yaml",
            get(get_pod_yaml).put(update_pod_yaml),
        )
        .route("/pods/:namespace/:name", delete(delete_pod))
        .route("/pods/:namespace/:name/logs", get(get_pod_logs))
        .route("/events", get(list_events))
        .route("/deployments", get(list_deployments))
        .route(
            "/deployments/:namespace/:name/scale",
            post(scale_deployment),
        )
        .route(
            "/deployments/:namespace/:name/restart",
            post(restart_deployment),
        )
        .route(
            "/deployments/:namespace/:name/image-tag",
            post(update_deployment_image_tag),
        )
        .route(
            "/deployments/:namespace/:name/yaml",
            get(get_deployment_yaml).put(update_deployment_yaml),
        )
        .route("/deployments/:namespace/:name", delete(delete_deployment))
        .route("/statefulsets", get(list_statefulsets))
        .route(
            "/statefulsets/:namespace/:name/yaml",
            get(get_statefulset_yaml).put(update_statefulset_yaml),
        )
        .route("/statefulsets/:namespace/:name", delete(delete_statefulset))
        .route("/daemonsets", get(list_daemonsets))
        .route(
            "/daemonsets/:namespace/:name/yaml",
            get(get_daemonset_yaml).put(update_daemonset_yaml),
        )
        .route("/daemonsets/:namespace/:name", delete(delete_daemonset))
        .route("/replicasets", get(list_replicasets))
        .route(
            "/replicasets/:namespace/:name/yaml",
            get(get_replicaset_yaml).put(update_replicaset_yaml),
        )
        .route("/replicasets/:namespace/:name", delete(delete_replicaset))
        .route("/jobs", get(list_jobs))
        .route(
            "/jobs/:namespace/:name/yaml",
            get(get_job_yaml).put(update_job_yaml),
        )
        .route("/jobs/:namespace/:name", delete(delete_job))
        .route("/cronjobs", get(list_cronjobs))
        .route(
            "/cronjobs/:namespace/:name/yaml",
            get(get_cronjob_yaml).put(update_cronjob_yaml),
        )
        .route(
            "/cronjobs/:namespace/:name/run",
            post(run_cronjob_now),
        )
        .route("/cronjobs/:namespace/:name", delete(delete_cronjob))
        .route("/namespaces/:name", delete(delete_namespace))
        .route("/configmaps", get(list_configmaps))
        .route(
            "/configmaps/:namespace/:name/yaml",
            get(get_configmap_yaml).put(update_configmap_yaml),
        )
        .route("/configmaps/:namespace/:name/data", get(get_configmap_data))
        .route("/configmaps/:namespace/:name", delete(delete_configmap))
        .route("/secrets", get(list_secrets))
        .route(
            "/secrets/:namespace/:name/yaml",
            get(get_secret_yaml).put(update_secret_yaml),
        )
        .route("/secrets/:namespace/:name/data", get(get_secret_data))
        .route("/secrets/:namespace/:name", delete(delete_secret))
        .route("/resourcequotas", get(list_resourcequotas))
        .route(
            "/resourcequotas/:namespace/:name/yaml",
            get(get_resourcequota_yaml).put(update_resourcequota_yaml),
        )
        .route("/resourcequotas/:namespace/:name", delete(delete_resourcequota))
        .route("/limitranges", get(list_limitranges))
        .route(
            "/limitranges/:namespace/:name/yaml",
            get(get_limitrange_yaml).put(update_limitrange_yaml),
        )
        .route("/limitranges/:namespace/:name", delete(delete_limitrange))
        .route("/hpa", get(list_hpa))
        .route(
            "/hpa/:namespace/:name/yaml",
            get(get_hpa_yaml).put(update_hpa_yaml),
        )
        .route("/hpa/:namespace/:name", delete(delete_hpa))
        .route("/pdb", get(list_pdb))
        .route(
            "/pdb/:namespace/:name/yaml",
            get(get_pdb_yaml).put(update_pdb_yaml),
        )
        .route("/pdb/:namespace/:name", delete(delete_pdb))
        .route("/priorityclasses", get(list_priorityclasses))
        .route(
            "/priorityclasses/:name/yaml",
            get(get_priorityclass_yaml).put(update_priorityclass_yaml),
        )
        .route("/priorityclasses/:name", delete(delete_priorityclass))
        .route("/runtimeclasses", get(list_runtimeclasses))
        .route(
            "/runtimeclasses/:name/yaml",
            get(get_runtimeclass_yaml).put(update_runtimeclass_yaml),
        )
        .route("/runtimeclasses/:name", delete(delete_runtimeclass))
        .route("/leases", get(list_leases))
        .route(
            "/leases/:namespace/:name/yaml",
            get(get_lease_yaml).put(update_lease_yaml),
        )
        .route("/leases/:namespace/:name", delete(delete_lease))
        .route("/mwcs", get(list_mwcs))
        .route("/mwcs/:name/yaml", get(get_mwc_yaml).put(update_mwc_yaml))
        .route("/mwcs/:name", delete(delete_mwc))
        .route("/vwcs", get(list_vwcs))
        .route("/vwcs/:name/yaml", get(get_vwc_yaml).put(update_vwc_yaml))
        .route("/vwcs/:name", delete(delete_vwc))
        .route("/services", get(list_services))
        .route(
            "/services/:namespace/:name/yaml",
            get(get_service_yaml).put(update_service_yaml),
        )
        .route("/services/:namespace/:name", delete(delete_service))
        .route("/endpoints", get(list_endpoints))
        .route(
            "/endpoints/:namespace/:name/yaml",
            get(get_endpoint_yaml).put(update_endpoint_yaml),
        )
        .route("/endpoints/:namespace/:name", delete(delete_endpoint))
        .route("/ingresses", get(list_ingresses))
        .route(
            "/ingresses/:namespace/:name/yaml",
            get(get_ingress_yaml).put(update_ingress_yaml),
        )
        .route("/ingresses/:namespace/:name", delete(delete_ingress))
        .route("/ingressclasses", get(list_ingressclasses))
        .route(
            "/ingressclasses/:name/yaml",
            get(get_ingressclass_yaml).put(update_ingressclass_yaml),
        )
        .route("/ingressclasses/:name", delete(delete_ingressclass))
        .route("/networkpolicies", get(list_networkpolicies))
        .route(
            "/networkpolicies/:namespace/:name/yaml",
            get(get_networkpolicy_yaml).put(update_networkpolicy_yaml),
        )
        .route(
            "/networkpolicies/:namespace/:name",
            delete(delete_networkpolicy),
        )
        .route("/persistentvolumes", get(list_persistent_volumes))
        .route("/persistentvolumeclaims", get(list_persistent_volume_claims))
        .route("/storageclasses", get(list_storage_classes))
        .route("/serviceaccounts/:namespace/:name/yaml",
            get(get_serviceaccount_yaml).put(update_serviceaccount_yaml),
        )
        .route("/serviceaccounts/:namespace/:name", delete(delete_serviceaccount))
        .route(
            "/roles/:namespace/:name/yaml",
            get(get_role_yaml).put(update_role_yaml),
        )
        .route("/roles/:namespace/:name", delete(delete_role))
        .route(
            "/rolebindings/:namespace/:name/yaml",
            get(get_rolebinding_yaml).put(update_rolebinding_yaml),
        )
        .route("/rolebindings/:namespace/:name", delete(delete_rolebinding))
        .route(
            "/clusterroles/:name/yaml",
            get(get_clusterrole_yaml).put(update_clusterrole_yaml),
        )
        .route("/clusterroles/:name", delete(delete_clusterrole))
        .route(
            "/clusterrolebindings/:name/yaml",
            get(get_clusterrolebinding_yaml).put(update_clusterrolebinding_yaml),
        )
        .route("/clusterrolebindings/:name", delete(delete_clusterrolebinding))
        .route("/port-forwards", get(list_port_forwards).post(create_port_forward))
        .route("/port-forwards/:id/stop", post(stop_port_forward))
        .route("/port-forwards/:id", delete(delete_port_forward))
        .route("/apply", post(apply_yaml))
        .route("/crds", get(list_crds))
        .route("/crds/:crd_name/resources", get(list_custom_resources))
        .route("/crds/:crd_name/resources/:name/yaml", get(get_custom_resource_yaml))
        .route("/crds/:crd_name/resources/:name", delete(delete_custom_resource))
        .route("/helm/releases", get(list_helm_releases))
        .route("/helm/charts", get(list_helm_charts))
        .route("/helm/charts/versions", get(get_helm_chart_versions))
        .route("/helm/charts/values", get(get_helm_chart_values))
        .route("/helm/charts/readme", get(get_helm_chart_readme))
        .route("/helm/charts/install", post(install_helm_chart))
        .route("/backup/config", get(get_backup_settings).put(save_backup_settings))
        .route("/backup/config/s3", post(save_backup_s3_config))
        .route("/backup/config/test-s3", post(test_backup_s3))
        .route("/backup/config/apply", post(apply_backup_settings))
        .route("/backup/schedules", post(create_backup_schedule))
        .route("/backup/schedules/:name", delete(delete_backup_schedule))
        .route("/backup/schedules/:name/run", post(run_backup_schedule_manual))
        .route("/backup/backups/delete", post(delete_backup_runs_bulk))
        .route("/backup/backups/:name", get(download_backup_run).delete(delete_backup_run))
        .route("/backup/manual", post(run_manual_backup))
        .route("/backup/restore", post(run_restore))
        .route("/backup/overview", get(get_backup_overview))
        .route("/helm/releases/:namespace/:name/yaml", get(get_helm_release_yaml))
        .route("/helm/releases/:namespace/:name/history", get(get_helm_release_history))
        .route("/helm/releases/:namespace/:name/resources", get(get_helm_release_resources))
        .route("/helm/releases/:namespace/:name/rollback", post(rollback_helm_release))
        .route("/helm/releases/:namespace/:name/upgrade", post(upgrade_helm_release))
        .route("/helm/releases/:namespace/:name", delete(delete_helm_release))
        .route(
            "/persistentvolumes/:name/yaml",
            get(get_persistentvolume_yaml).put(update_persistentvolume_yaml),
        )
        .route("/persistentvolumes/:name", delete(delete_persistentvolume))
        .route(
            "/persistentvolumeclaims/:namespace/:name/yaml",
            get(get_persistentvolumeclaim_yaml).put(update_persistentvolumeclaim_yaml),
        )
        .route("/persistentvolumeclaims/:namespace/:name", delete(delete_persistentvolumeclaim))
        .route(
            "/storageclasses/:name/yaml",
            get(get_storageclass_yaml).put(update_storageclass_yaml),
        )
        .route("/storageclasses/:name", delete(delete_storageclass))
        .route("/serviceaccounts", get(list_service_accounts))
        .route("/roles", get(list_roles))
        .route("/rolebindings", get(list_role_bindings))
        .route("/clusterroles", get(list_cluster_roles))
        .route("/clusterrolebindings", get(list_cluster_role_bindings))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_basic_auth,
        ));

    let api = public_api.merge(refresh_api).merge(protected_api);

    let index_html = static_dir.join("index.html");
    let assets_dir = static_dir.join("assets");
    let config_js = static_dir.join("config.js");
    let favicon_svg = static_dir.join("favicon.svg");

    // Share the replaceable kube client with gRPC (upgrades after kubeconfig upload).
    let grpc_client = state.client.clone();

    let app = Router::new()
        .route("/ws", get(ws_handler::ws_handler))  // WebSocket endpoint
        .route("/api/exec", get(ws_handler::exec_ws_handler))
        .nest("/api", api)
        .nest_service("/assets", ServeDir::new(assets_dir))
        .route_service("/config.js", ServeFile::new(config_js))
        .route_service("/favicon.svg", ServeFile::new(favicon_svg))
        .route_service("/", ServeFile::new(index_html.clone()))
        .fallback_service(ServeFile::new(index_html))
        .layer(middleware::from_fn(normalize_websocket_upgrade_headers))
        .with_state(state)
        .layer(cors);

    let http_port: u16 = std::env::var("PORT")
        .ok()
        .or_else(|| std::env::var("APP_PORT").ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(8091);
    let addr: SocketAddr = ([0, 0, 0, 0], http_port).into();
    info!("Starting HTTP server on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let http_server = axum::serve(listener, app);

    // gRPC server
    let grpc_port: u16 = std::env::var("GRPC_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(50051);
    let grpc_addr: SocketAddr = ([0, 0, 0, 0], grpc_port).into();
    info!("Starting gRPC server on {}", grpc_addr);
    
    let grpc_service = grpc_service::KubernetesWatchService::new(grpc_client).into_server();
    let grpc_server = Server::builder()
        .accept_http1(true)  // Required for grpc-web
        .add_service(tonic_web::enable(grpc_service))
        .serve(grpc_addr);

    // Run both servers concurrently
    tokio::try_join!(
        async { http_server.await.map_err(|e| anyhow::anyhow!(e)) },
        async { grpc_server.await.map_err(|e| anyhow::anyhow!(e)) }
    )?;

    Ok(())
}

async fn health() -> impl IntoResponse {
    let body = HealthResponse {
        status: "ok".into(),
    };
    (StatusCode::OK, Json(body))
}

async fn normalize_websocket_upgrade_headers(
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if path == "/ws" || path == "/api/exec" {
        let headers = request.headers_mut();
        let has_upgrade = headers
            .get(header::UPGRADE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false);

        if has_upgrade && !headers.contains_key(header::CONNECTION) {
            headers.insert(
                header::CONNECTION,
                header::HeaderValue::from_static("upgrade"),
            );
        }
    }

    next.run(request).await
}

async fn auth_status(State(state): State<AppState>) -> impl IntoResponse {
    #[derive(serde::Serialize)]
    struct AuthStatusResponse {
        ok: bool,
        placeholder: bool,
        message: Option<String>,
    }

    let placeholder = state.is_auth_placeholder();
    let message = if placeholder {
        Some(
            state.auth_user_message().await.unwrap_or_else(|| {
                "Upload a kubeconfig to connect to a Kubernetes cluster.".to_string()
            }),
        )
    } else {
        None
    };

    (
        StatusCode::OK,
        Json(AuthStatusResponse {
            ok: !placeholder,
            placeholder,
            message,
        }),
    )
}

async fn readiness(State(state): State<AppState>) -> impl IntoResponse {
    // Service is up even without cluster config; readiness reflects cluster connectivity.
    if state.is_auth_placeholder() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthResponse {
                status: "not ready".into(),
            }),
        )
            .into_response();
    }

    match state.kube_client().await.apiserver_version().await {
        Ok(_) => {
            let body = HealthResponse {
                status: "ready".into(),
            };
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(err) => {
            error!("Kubernetes API not reachable: {}", err);
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(HealthResponse {
                    status: "not ready".into(),
                }),
            )
                .into_response()
        }
    }
}

