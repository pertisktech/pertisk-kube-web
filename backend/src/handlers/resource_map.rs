use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service, ServiceAccount,
};
use k8s_openapi::api::networking::v1::Ingress;
use kube::{api::ListParams, Api};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use tracing::error;

use crate::{
    models::{ResourceMapData, ResourceMapEdge, ResourceMapNode},
    AppState,
};

#[derive(Deserialize)]
pub struct ResourceMapQuery {
    pub namespace: Option<String>,
}

pub async fn get_resource_map(
    State(state): State<AppState>,
    Query(params): Query<ResourceMapQuery>,
) -> impl IntoResponse {
    let client = state.kube_client().await;

    let pods_api: Api<Pod> = Api::all(client.clone());
    let deployments_api: Api<Deployment> = Api::all(client.clone());
    let rs_api: Api<ReplicaSet> = Api::all(client.clone());
    let ss_api: Api<StatefulSet> = Api::all(client.clone());
    let ds_api: Api<DaemonSet> = Api::all(client.clone());
    let jobs_api: Api<Job> = Api::all(client.clone());
    let cronjobs_api: Api<CronJob> = Api::all(client.clone());
    let svc_api: Api<Service> = Api::all(client.clone());
    let ing_api: Api<Ingress> = Api::all(client.clone());
    let hpa_api: Api<HorizontalPodAutoscaler> = Api::all(client.clone());
    let cm_api: Api<ConfigMap> = Api::all(client.clone());
    let secret_api: Api<Secret> = Api::all(client.clone());
    let sa_api: Api<ServiceAccount> = Api::all(client.clone());
    let pvc_api: Api<PersistentVolumeClaim> = Api::all(client.clone());
    let pv_api: Api<PersistentVolume> = Api::all(client.clone());

    let lp = ListParams::default();

    let (
        pods_r, deps_r, rs_r, ss_r, ds_r,
        jobs_r, cronjobs_r,
        svc_r, ing_r, hpa_r,
        cm_r, secret_r, sa_r, pvc_r, pv_r,
    ) = tokio::join!(
        pods_api.list(&lp),
        deployments_api.list(&lp),
        rs_api.list(&lp),
        ss_api.list(&lp),
        ds_api.list(&lp),
        jobs_api.list(&lp),
        cronjobs_api.list(&lp),
        svc_api.list(&lp),
        ing_api.list(&lp),
        hpa_api.list(&lp),
        cm_api.list(&lp),
        secret_api.list(&lp),
        sa_api.list(&lp),
        pvc_api.list(&lp),
        pv_api.list(&lp),
    );

    macro_rules! unwrap_list {
        ($result:expr, $resource:literal) => {
            match $result {
                Ok(l) => l.items,
                Err(e) => {
                    error!("Failed to fetch {}: {e}", $resource);
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": format!("Failed to fetch {}", $resource)})),
                    )
                        .into_response();
                }
            }
        };
    }

    let pods = unwrap_list!(pods_r, "pods");
    let deps = unwrap_list!(deps_r, "deployments");
    let rsets = unwrap_list!(rs_r, "replicasets");
    let ssets = unwrap_list!(ss_r, "statefulsets");
    let dsets = unwrap_list!(ds_r, "daemonsets");
    let jobs = unwrap_list!(jobs_r, "jobs");
    let cronjobs = unwrap_list!(cronjobs_r, "cronjobs");
    let services = unwrap_list!(svc_r, "services");
    let ingresses = unwrap_list!(ing_r, "ingresses");
    let hpas = unwrap_list!(hpa_r, "hpas");
    let configmaps = unwrap_list!(cm_r, "configmaps");
    let secrets = unwrap_list!(secret_r, "secrets");
    let serviceaccounts = unwrap_list!(sa_r, "serviceaccounts");
    let pvcs = unwrap_list!(pvc_r, "pvcs");
    let pvs = unwrap_list!(pv_r, "pvs");

    // Namespace filter: comma-separated list
    let ns_list: Option<Vec<&str>> = params
        .namespace
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).collect());

    let in_ns = |ns: &str| -> bool {
        match &ns_list {
            None => true,
            Some(filters) => filters.contains(&ns),
        }
    };

    let mut nodes: Vec<ResourceMapNode> = Vec::new();
    let mut edges: Vec<ResourceMapEdge> = Vec::new();

    // Track which config/storage resources are actually referenced by pods
    // (to avoid cluttering the graph with orphan nodes)
    let mut referenced_cms: HashSet<String> = HashSet::new();    // "ns/name"
    let mut referenced_secrets: HashSet<String> = HashSet::new();
    let mut referenced_sas: HashSet<String> = HashSet::new();
    let mut referenced_pvcs: HashSet<String> = HashSet::new();
    let mut referenced_pvs: HashSet<String> = HashSet::new();    // just "name" (cluster-scoped)

    // ── Pods ──────────────────────────────────────────────────────────────────
    for pod in &pods {
        let name = pod.metadata.name.as_deref().unwrap_or_default();
        let ns = pod.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }

        let phase = pod
            .status
            .as_ref()
            .and_then(|s| s.phase.as_deref())
            .unwrap_or("Unknown")
            .to_string();

        nodes.push(ResourceMapNode {
            id: format!("pod/{ns}/{name}"),
            kind: "Pod".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: phase,
        });

        // ownerRef edges → ReplicaSet / StatefulSet / DaemonSet / Job
        if let Some(owners) = pod.metadata.owner_references.as_ref() {
            for owner in owners {
                let owner_id = match owner.kind.as_str() {
                    "ReplicaSet" => format!("replicaset/{ns}/{}", owner.name),
                    "StatefulSet" => format!("statefulset/{ns}/{}", owner.name),
                    "DaemonSet" => format!("daemonset/{ns}/{}", owner.name),
                    "Job" => format!("job/{ns}/{}", owner.name),
                    _ => continue,
                };
                edges.push(ResourceMapEdge {
                    source: owner_id,
                    target: format!("pod/{ns}/{name}"),
                    edge_type: "owns".into(),
                });
            }
        }

        // Config / storage references from pod spec
        if let Some(spec) = &pod.spec {
            // ServiceAccount (skip "default" to reduce noise)
            if let Some(sa_name) = &spec.service_account_name {
                if sa_name != "default" {
                    referenced_sas.insert(format!("{ns}/{sa_name}"));
                    edges.push(ResourceMapEdge {
                        source: format!("pod/{ns}/{name}"),
                        target: format!("serviceaccount/{ns}/{sa_name}"),
                        edge_type: "uses_sa".into(),
                    });
                }
            }

            // Volumes
            for vol in spec.volumes.as_deref().unwrap_or(&[]) {
                if let Some(cm_vol) = &vol.config_map {
                    if let Some(cm_name) = &cm_vol.name {
                        // Skip kube-internal CA configmap present in every namespace
                        if cm_name == "kube-root-ca.crt" {
                            continue;
                        }
                        referenced_cms.insert(format!("{ns}/{cm_name}"));
                        edges.push(ResourceMapEdge {
                            source: format!("pod/{ns}/{name}"),
                            target: format!("configmap/{ns}/{cm_name}"),
                            edge_type: "uses".into(),
                        });
                    }
                }
                if let Some(secret_vol) = &vol.secret {
                    if let Some(secret_name) = &secret_vol.secret_name {
                        referenced_secrets.insert(format!("{ns}/{secret_name}"));
                        edges.push(ResourceMapEdge {
                            source: format!("pod/{ns}/{name}"),
                            target: format!("secret/{ns}/{secret_name}"),
                            edge_type: "uses".into(),
                        });
                    }
                }
                if let Some(pvc_vol) = &vol.persistent_volume_claim {
                    referenced_pvcs.insert(format!("{ns}/{}", pvc_vol.claim_name));
                    edges.push(ResourceMapEdge {
                        source: format!("pod/{ns}/{name}"),
                        target: format!("pvc/{ns}/{}", pvc_vol.claim_name),
                        edge_type: "mounts".into(),
                    });
                }
            }

            // envFrom (containers + init containers)
            let all_containers = spec
                .containers
                .iter()
                .chain(spec.init_containers.as_deref().unwrap_or(&[]).iter());
            for container in all_containers {
                for env_from in container.env_from.as_deref().unwrap_or(&[]) {
                    if let Some(cm_ref) = &env_from.config_map_ref {
                        if let Some(cm_name) = &cm_ref.name {
                            referenced_cms.insert(format!("{ns}/{cm_name}"));
                            edges.push(ResourceMapEdge {
                                source: format!("pod/{ns}/{name}"),
                                target: format!("configmap/{ns}/{cm_name}"),
                                edge_type: "uses".into(),
                            });
                        }
                    }
                    if let Some(secret_ref) = &env_from.secret_ref {
                        if let Some(secret_name) = &secret_ref.name {
                            referenced_secrets.insert(format!("{ns}/{secret_name}"));
                            edges.push(ResourceMapEdge {
                                source: format!("pod/{ns}/{name}"),
                                target: format!("secret/{ns}/{secret_name}"),
                                edge_type: "uses".into(),
                            });
                        }
                    }
                }
            }
        }
    }

    // ── Deployments ───────────────────────────────────────────────────────────
    for dep in &deps {
        let name = dep.metadata.name.as_deref().unwrap_or_default();
        let ns = dep.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }

        let available = dep
            .status
            .as_ref()
            .and_then(|s| s.available_replicas)
            .unwrap_or(0);
        let desired = dep.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        let status = if available >= desired { "ready" } else { "degraded" };

        nodes.push(ResourceMapNode {
            id: format!("deployment/{ns}/{name}"),
            kind: "Deployment".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: status.into(),
        });
    }

    // ── ReplicaSets ───────────────────────────────────────────────────────────
    for rs in &rsets {
        let name = rs.metadata.name.as_deref().unwrap_or_default();
        let ns = rs.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }

        let ready = rs
            .status
            .as_ref()
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0);
        let desired = rs.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
        // Skip old rollout revisions with 0 desired
        if desired == 0 && ready == 0 {
            continue;
        }

        let status = if ready >= desired { "ready" } else { "degraded" };

        nodes.push(ResourceMapNode {
            id: format!("replicaset/{ns}/{name}"),
            kind: "ReplicaSet".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: status.into(),
        });

        if let Some(owners) = rs.metadata.owner_references.as_ref() {
            for owner in owners {
                if owner.kind == "Deployment" {
                    edges.push(ResourceMapEdge {
                        source: format!("deployment/{ns}/{}", owner.name),
                        target: format!("replicaset/{ns}/{name}"),
                        edge_type: "owns".into(),
                    });
                }
            }
        }
    }

    // ── StatefulSets ──────────────────────────────────────────────────────────
    for ss in &ssets {
        let name = ss.metadata.name.as_deref().unwrap_or_default();
        let ns = ss.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }

        let ready = ss
            .status
            .as_ref()
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0);
        let desired = ss.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        let status = if ready >= desired { "ready" } else { "degraded" };

        nodes.push(ResourceMapNode {
            id: format!("statefulset/{ns}/{name}"),
            kind: "StatefulSet".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: status.into(),
        });
    }

    // ── DaemonSets ────────────────────────────────────────────────────────────
    for ds in &dsets {
        let name = ds.metadata.name.as_deref().unwrap_or_default();
        let ns = ds.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }

        let ready = ds.status.as_ref().map(|s| s.number_ready).unwrap_or(0);
        let desired = ds
            .status
            .as_ref()
            .map(|s| s.desired_number_scheduled)
            .unwrap_or(0);
        let status = if ready >= desired { "ready" } else { "degraded" };

        nodes.push(ResourceMapNode {
            id: format!("daemonset/{ns}/{name}"),
            kind: "DaemonSet".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: status.into(),
        });
    }

    // ── CronJobs ──────────────────────────────────────────────────────────────
    for cj in &cronjobs {
        let name = cj.metadata.name.as_deref().unwrap_or_default();
        let ns = cj.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }

        let suspended = cj
            .spec
            .as_ref()
            .and_then(|s| s.suspend)
            .unwrap_or(false);
        let active = cj
            .status
            .as_ref()
            .map(|s| s.active.as_deref().unwrap_or(&[]).len())
            .unwrap_or(0);

        let status = if suspended {
            "suspended"
        } else if active > 0 {
            "active"
        } else {
            "ready"
        };

        nodes.push(ResourceMapNode {
            id: format!("cronjob/{ns}/{name}"),
            kind: "CronJob".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: status.into(),
        });
    }

    // ── Jobs (including CronJob-owned) ────────────────────────────────────────
    for job in &jobs {
        let name = job.metadata.name.as_deref().unwrap_or_default();
        let ns = job.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }

        let succeeded = job
            .status
            .as_ref()
            .and_then(|s| s.succeeded)
            .unwrap_or(0);
        let failed = job.status.as_ref().and_then(|s| s.failed).unwrap_or(0);
        let active = job.status.as_ref().and_then(|s| s.active).unwrap_or(0);

        let status = if succeeded > 0 {
            "completed"
        } else if failed > 0 {
            "failed"
        } else if active > 0 {
            "running"
        } else {
            "pending"
        };

        nodes.push(ResourceMapNode {
            id: format!("job/{ns}/{name}"),
            kind: "Job".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: status.into(),
        });

        // CronJob → Job edge via ownerReferences
        if let Some(owners) = job.metadata.owner_references.as_ref() {
            for owner in owners {
                if owner.kind == "CronJob" {
                    edges.push(ResourceMapEdge {
                        source: format!("cronjob/{ns}/{}", owner.name),
                        target: format!("job/{ns}/{name}"),
                        edge_type: "owns".into(),
                    });
                }
            }
        }
    }

    // ── HPAs ──────────────────────────────────────────────────────────────────
    for hpa in &hpas {
        let name = hpa.metadata.name.as_deref().unwrap_or_default();
        let ns = hpa.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }

        let current = hpa
            .status
            .as_ref()
            .and_then(|s| s.current_replicas)
            .unwrap_or(0);
        let desired = hpa
            .status
            .as_ref()
            .map(|s| s.desired_replicas)
            .unwrap_or(0);
        let status = if current == desired { "synced" } else { "scaling" };

        nodes.push(ResourceMapNode {
            id: format!("hpa/{ns}/{name}"),
            kind: "HPA".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: status.into(),
        });

        // HPA → target (Deployment / StatefulSet) edge
        if let Some(spec) = &hpa.spec {
            let target = &spec.scale_target_ref;
            let target_id = match target.kind.to_lowercase().as_str() {
                "deployment" => format!("deployment/{ns}/{}", target.name),
                "statefulset" => format!("statefulset/{ns}/{}", target.name),
                "daemonset" => format!("daemonset/{ns}/{}", target.name),
                _ => continue,
            };
            edges.push(ResourceMapEdge {
                source: format!("hpa/{ns}/{name}"),
                target: target_id,
                edge_type: "scales".into(),
            });
        }
    }

    // ── Build pod → top-level-controller lookup for service edges ─────────────
    // rs_key("ns/rs-name") -> deployment node id
    let mut rs_to_dep: HashMap<String, String> = HashMap::new();
    for rs in &rsets {
        let rs_name = rs.metadata.name.as_deref().unwrap_or_default();
        let rs_ns = rs.metadata.namespace.as_deref().unwrap_or("default");
        if let Some(owners) = rs.metadata.owner_references.as_ref() {
            for owner in owners {
                if owner.kind == "Deployment" {
                    rs_to_dep.insert(
                        format!("{rs_ns}/{rs_name}"),
                        format!("deployment/{rs_ns}/{}", owner.name),
                    );
                }
            }
        }
    }

    // pod_key("ns/pod-name") -> top-level controller node id
    let mut pod_to_controller: HashMap<String, String> = HashMap::new();
    for pod in &pods {
        let pod_name = pod.metadata.name.as_deref().unwrap_or_default();
        let pod_ns = pod.metadata.namespace.as_deref().unwrap_or("default");
        let pod_key = format!("{pod_ns}/{pod_name}");

        let controller_id = pod
            .metadata
            .owner_references
            .as_ref()
            .and_then(|owners| {
                owners.iter().find_map(|owner| match owner.kind.as_str() {
                    "ReplicaSet" => {
                        let rs_key = format!("{pod_ns}/{}", owner.name);
                        Some(
                            rs_to_dep
                                .get(&rs_key)
                                .cloned()
                                .unwrap_or_else(|| format!("replicaset/{pod_ns}/{}", owner.name)),
                        )
                    }
                    "StatefulSet" => Some(format!("statefulset/{pod_ns}/{}", owner.name)),
                    "DaemonSet" => Some(format!("daemonset/{pod_ns}/{}", owner.name)),
                    "Job" => Some(format!("job/{pod_ns}/{}", owner.name)),
                    _ => None,
                })
            })
            .unwrap_or_else(|| format!("pod/{pod_ns}/{pod_name}"));

        pod_to_controller.insert(pod_key, controller_id);
    }

    // ── Services ──────────────────────────────────────────────────────────────
    for svc in &services {
        let name = svc.metadata.name.as_deref().unwrap_or_default();
        let ns = svc.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }
        if name == "kubernetes" && ns == "default" {
            continue;
        }

        let selector: HashMap<String, String> = svc
            .spec
            .as_ref()
            .and_then(|s| s.selector.as_ref())
            .map(|sel| sel.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();

        if selector.is_empty() {
            continue;
        }

        nodes.push(ResourceMapNode {
            id: format!("service/{ns}/{name}"),
            kind: "Service".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: "active".into(),
        });

        // Service → top-level controller (trace pod ownerRefs: pod → RS → Deployment etc.)
        // This produces one clean edge per controller instead of N edges to individual pods.
        let mut seen_controllers: HashSet<String> = HashSet::new();
        for pod in &pods {
            let pod_ns = pod.metadata.namespace.as_deref().unwrap_or("default");
            if pod_ns != ns {
                continue;
            }
            let pod_name = pod.metadata.name.as_deref().unwrap_or_default();
            let pod_labels: HashMap<String, String> = pod
                .metadata
                .labels
                .as_ref()
                .map(|l| l.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();

            if selector.iter().all(|(k, v)| pod_labels.get(k) == Some(v)) {
                let pod_key = format!("{pod_ns}/{pod_name}");
                let controller_id = pod_to_controller
                    .get(&pod_key)
                    .cloned()
                    .unwrap_or_else(|| format!("pod/{pod_ns}/{pod_name}"));

                if seen_controllers.insert(controller_id.clone()) {
                    edges.push(ResourceMapEdge {
                        source: format!("service/{ns}/{name}"),
                        target: controller_id,
                        edge_type: "selects".into(),
                    });
                }
            }
        }
    }

    // ── Ingresses ─────────────────────────────────────────────────────────────
    for ing in &ingresses {
        let name = ing.metadata.name.as_deref().unwrap_or_default();
        let ns = ing.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }

        nodes.push(ResourceMapNode {
            id: format!("ingress/{ns}/{name}"),
            kind: "Ingress".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: "active".into(),
        });

        if let Some(spec) = &ing.spec {
            if let Some(rules) = &spec.rules {
                for rule in rules {
                    if let Some(http) = &rule.http {
                        for path in &http.paths {
                            if let Some(svc_backend) = &path.backend.service {
                                edges.push(ResourceMapEdge {
                                    source: format!("ingress/{ns}/{name}"),
                                    target: format!("service/{ns}/{}", svc_backend.name),
                                    edge_type: "routes".into(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // ── ConfigMaps (all in namespace, except kube internals) ───────────────────
    for cm in &configmaps {
        let name = cm.metadata.name.as_deref().unwrap_or_default();
        let ns = cm.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }
        // Skip kube-internal CA configmap injected in every namespace
        if name == "kube-root-ca.crt" {
            continue;
        }

        nodes.push(ResourceMapNode {
            id: format!("configmap/{ns}/{name}"),
            kind: "ConfigMap".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: "active".into(),
        });
    }

    // ── Secrets (all in namespace; skip auto-generated SA tokens) ────────────────
    for secret in &secrets {
        let name = secret.metadata.name.as_deref().unwrap_or_default();
        let ns = secret.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }
        // Skip automatically rotated service-account tokens
        let secret_type = secret.type_.as_deref().unwrap_or("");
        if secret_type == "kubernetes.io/service-account-token" {
            continue;
        }
        // Skip Helm release secrets (sh.helm.release.v1.*)
        if name.starts_with("sh.helm.release") {
            continue;
        }

        nodes.push(ResourceMapNode {
            id: format!("secret/{ns}/{name}"),
            kind: "Secret".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: "active".into(),
        });
    }

    // ── ServiceAccounts (only referenced, non-default) ─────────────────────────
    for sa in &serviceaccounts {
        let name = sa.metadata.name.as_deref().unwrap_or_default();
        let ns = sa.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }
        if !referenced_sas.contains(&format!("{ns}/{name}")) {
            continue;
        }

        nodes.push(ResourceMapNode {
            id: format!("serviceaccount/{ns}/{name}"),
            kind: "ServiceAccount".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: "active".into(),
        });
    }

    // ── PVCs (only referenced ones) + PVC → PV edges ──────────────────────────
    for pvc in &pvcs {
        let name = pvc.metadata.name.as_deref().unwrap_or_default();
        let ns = pvc.metadata.namespace.as_deref().unwrap_or("default");
        if !in_ns(ns) {
            continue;
        }
        if !referenced_pvcs.contains(&format!("{ns}/{name}")) {
            continue;
        }

        let phase = pvc
            .status
            .as_ref()
            .and_then(|s| s.phase.as_deref())
            .unwrap_or("Unknown");

        nodes.push(ResourceMapNode {
            id: format!("pvc/{ns}/{name}"),
            kind: "PVC".into(),
            name: name.into(),
            namespace: Some(ns.into()),
            status: phase.to_lowercase(),
        });

        // PVC → PV edge (via bound volume name)
        if let Some(pv_name) = pvc
            .spec
            .as_ref()
            .and_then(|s| s.volume_name.as_ref())
            .filter(|v| !v.is_empty())
        {
            referenced_pvs.insert(pv_name.clone());
            edges.push(ResourceMapEdge {
                source: format!("pvc/{ns}/{name}"),
                target: format!("pv/{pv_name}"),
                edge_type: "binds".into(),
            });
        }
    }

    // ── PVs (only those bound to included PVCs) ────────────────────────────────
    for pv in &pvs {
        let name = pv.metadata.name.as_deref().unwrap_or_default();
        if !referenced_pvs.contains(name) {
            continue;
        }

        let phase = pv
            .status
            .as_ref()
            .and_then(|s| s.phase.as_deref())
            .unwrap_or("Unknown");

        nodes.push(ResourceMapNode {
            id: format!("pv/{name}"),
            kind: "PV".into(),
            name: name.into(),
            namespace: None, // cluster-scoped
            status: phase.to_lowercase(),
        });
    }

    // Deduplicate edges
    edges.sort_by(|a, b| a.source.cmp(&b.source).then(a.target.cmp(&b.target)));
    edges.dedup_by(|a, b| a.source == b.source && a.target == b.target);

    Json(ResourceMapData { nodes, edges }).into_response()
}
