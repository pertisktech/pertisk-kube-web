import { useEffect, useMemo, useState } from 'react';
import YAML from 'yaml';
import { ScrollText, Trash2 } from '../components/Icons';
import { useRealtimeDeployments } from '../hooks/useRealtimeResources';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable } from '../components/DataTable';
import { DeploymentDetailPanel } from '../components/DeploymentDetailPanel';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { StatusBadge } from '../components/StatusBadge';
import type { Deployment } from '../types';
import { getAuthToken } from '../utils/auth';
import { restartDeployment, scaleDeployment, deleteDeployment, quickUpdateDeploymentImageTag } from '../hooks/useKubernetes';
import { timeAgo, matchesResourceNameFilter } from '../utils';
import { openPanelTab } from '../components/BottomPanel';

type DeploymentSortKey = 'name' | 'namespace' | 'status' | 'ready' | 'updated' | 'available' | 'images' | 'age';

const imageWithoutDigest = (image: string): string => image.split('@')[0] ?? image;

const preferDigestImages = (images?: string[]): string[] => {
  if (!images || images.length === 0) return [];

  const selectedByBase = new Map<string, string>();
  const order: string[] = [];

  for (const image of images) {
    if (!image) continue;
    const base = imageWithoutDigest(image);
    const existing = selectedByBase.get(base);

    if (!existing) {
      selectedByBase.set(base, image);
      order.push(base);
      continue;
    }

    const existingHasDigest = existing.includes('@sha256:');
    const nextHasDigest = image.includes('@sha256:');
    if (!existingHasDigest && nextHasDigest) {
      selectedByBase.set(base, image);
    }
  }

  return order
    .map((base) => selectedByBase.get(base))
    .filter((image): image is string => Boolean(image));
};

const formatImageForTable = (image: string): string => {
  return image.split('@')[0] ?? image;
};

const sanitizeDeploymentYamlForEdit = (yamlText: string) => {
  try {
    const parsed = YAML.parse(yamlText) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') {
      return yamlText;
    }

    const metadata = (parsed.metadata as Record<string, unknown> | undefined) ?? undefined;
    if (metadata && typeof metadata === 'object') {
      delete metadata.managedFields;
      delete metadata.resourceVersion;
      delete metadata.uid;
      delete metadata.generation;
      delete metadata.creationTimestamp;
      delete metadata.selfLink;

      const annotations = metadata.annotations as Record<string, unknown> | undefined;
      if (annotations && typeof annotations === 'object') {
        delete annotations['deployment.kubernetes.io/revision'];
        delete annotations['kubectl.kubernetes.io/last-applied-configuration'];

        if (Object.keys(annotations).length === 0) {
          delete metadata.annotations;
        }
      }
    }

    delete parsed.status;

    return YAML.stringify(parsed, {
      lineWidth: 0,
    });
  } catch {
    return yamlText;
  }
};

const buildDeploymentKtailCommand = (deployment: Deployment): string => {
  const selectorEntries = Object.entries(deployment.selector_labels ?? {}).filter(
    ([key, value]) => key.trim().length > 0 && String(value).trim().length > 0
  );

  if (selectorEntries.length > 0) {
    const preferredSelector = selectorEntries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(',');
    return `ktail --color always --color-scheme modern -n ${deployment.namespace} -l ${preferredSelector}`;
  }

  const labels = deployment.labels ?? {};
  const preferredKeys = ['app.kubernetes.io/instance', 'app.kubernetes.io/name', 'app', 'k8s-app'];
  const fallbackSelector = preferredKeys
    .map((key) => [key, labels[key]] as const)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',');
  if (fallbackSelector) {
    return `ktail --color always --color-scheme modern -n ${deployment.namespace} -l ${fallbackSelector}`;
  }

  return `ktail --color always --color-scheme modern -n ${deployment.namespace}`;
};

export const DeploymentsPage = () => {
  const { data, isLoading, error } = useRealtimeDeployments();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: DeploymentSortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });

  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedDeployment(null);
      return;
    }

    if (!selectedDeployment) {
      setSelectedDeployment(data[0]);
      return;
    }

    const updatedSelected = data.find(
      (item) => item.name === selectedDeployment.name && item.namespace === selectedDeployment.namespace
    );
    setSelectedDeployment(updatedSelected ?? data[0]);
  }, [data]);


  const handleOpenYamlEditorFromPanel = async (deployment: Deployment) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/deployments/${encodeURIComponent(deployment.namespace)}/${encodeURIComponent(deployment.name)}/yaml`, {
        headers: token ? { Authorization: token } : {},
      });
      if (!res.ok) throw new Error(`Failed to load YAML: ${res.statusText}`);
      const yaml = await res.text();
      openPanelTab({ type: 'yaml-editor', yamlContent: sanitizeDeploymentYamlForEdit(yaml), title: deployment.name });
    } catch {
      openPanelTab({ type: 'yaml-editor' });
    }
  };


  const handleDeleteSingle = async (namespace: string, name: string) => {
    setConfirmDelete({ keys: [`${namespace}/${name}`], label: name });
    setPanelOpen(false);
  };

  const handleTailLogs = (deployment: Deployment) => {
    const command = buildDeploymentKtailCommand(deployment);
    openPanelTab({
      type: 'host-shell',
      title: `ktail ${deployment.name}`,
      initialCommand: command,
    });
  };

  const handleDeleteSelected = () => {
    if (selectedRows.length === 0) return;
    setConfirmDelete({
      keys: selectedRows,
      label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} deployments`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(
        confirmDelete.keys.map((key) => {
          const [ns, name] = key.split('/');
          return deleteDeployment(ns, name);
        })
      );
      setSelectedRows([]);
      setConfirmDelete(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const columns = [
    {
      header: 'Name',
      accessor: (row: Deployment) => (
        <span className="font-medium text-text">{row.name}</span>
      ),
      width: '16%',
      sortable: true,
      sortKey: 'name',
    },
    {
      header: 'Namespace',
      accessor: 'namespace' as const,
      width: '10%',
      sortable: true,
      sortKey: 'namespace',
    },
    {
      header: 'Status',
      accessor: (row: Deployment) => <StatusBadge status={row.status || 'Unknown'} />,
      width: '8%',
      sortable: true,
      sortKey: 'status',
    },
    {
      header: 'Ready',
      accessor: 'ready' as const,
      width: '7%',
      sortable: true,
      sortKey: 'ready',
    },
    {
      header: 'Updated',
      accessor: 'updated' as const,
      width: '7%',
      sortable: true,
      sortKey: 'updated',
    },
    {
      header: 'Available',
      accessor: 'available' as const,
      width: '7%',
      sortable: true,
      sortKey: 'available',
    },
    {
      header: 'Images',
      accessor: (row: Deployment) => {
        const displayImages = preferDigestImages(row.images);
        return (
          <div className="whitespace-normal" title={displayImages.join('\n') || '-'}>
            {displayImages.length > 0 ? (
              displayImages.map((image) => (
                <div key={image} className="break-all leading-5">
                  {formatImageForTable(image)}
                </div>
              ))
            ) : (
              '-'
            )}
          </div>
        );
      },
      width: '37%',
      sortable: true,
      sortKey: 'images',
    },
    {
      header: 'Age',
      accessor: (row: Deployment) => timeAgo(row.age),
      width: '1%',
      sortable: true,
      sortKey: 'age',
      headerClassName: 'px-1 py-2 text-center',
      cellClassName: 'px-1 py-1.5 text-center',
    },
    {
      header: 'Logs',
      accessor: (row: Deployment) => {
        return (
          <div className="inline-flex items-center justify-center">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleTailLogs(row);
              }}
              title="Tail Logs"
              aria-label="Tail logs"
              className="inline-flex items-center justify-center h-5 w-5 rounded border transition-colors hover:opacity-90"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-primary)', backgroundColor: 'var(--color-surface-elevated)' }}
            >
              <ScrollText size={12} />
            </button>
          </div>
        );
      },
      width: '36px',
      headerClassName: 'px-0.5 py-2 text-center',
      cellClassName: 'px-0.5 py-1 text-center',
    },
  ];

  const sortedDeployments = useMemo((): (Deployment & { id: string })[] => {
    let source = [...(data || [])];
    
    // Filter by selected namespaces (if any are selected)
    if (selectedNamespaces.length > 0) {
      source = source.filter((deployment) => selectedNamespaces.includes(deployment.namespace));
    }
    if (resourceNameFilter.trim()) {
      source = source.filter((d) => matchesResourceNameFilter(d.name, resourceNameFilter));
    }
    
    // Add unique id for row selection
    source = source.map((item) => ({
      ...item,
      id: `${item.namespace}/${item.name}`,
    })) as (Deployment & { id: string })[];
    
    const factor = sortState.direction === 'asc' ? 1 : -1;

    return source.sort((first, second) => {
      if (sortState.key === 'name') return first.name.localeCompare(second.name) * factor;
      if (sortState.key === 'namespace') return first.namespace.localeCompare(second.namespace) * factor;
      if (sortState.key === 'status') return (first.status || '').localeCompare(second.status || '') * factor;
      if (sortState.key === 'ready') return (first.ready || '').localeCompare(second.ready || '') * factor;
      if (sortState.key === 'updated') return ((first.updated ?? 0) - (second.updated ?? 0)) * factor;
      if (sortState.key === 'available') return ((first.available ?? 0) - (second.available ?? 0)) * factor;
      if (sortState.key === 'images') {
        return preferDigestImages(first.images).join(',').localeCompare(preferDigestImages(second.images).join(',')) * factor;
      }

      const firstAge = Date.parse(first.age || '');
      const secondAge = Date.parse(second.age || '');
      return ((Number.isNaN(firstAge) ? 0 : firstAge) - (Number.isNaN(secondAge) ? 0 : secondAge)) * factor;
    }) as (Deployment & { id: string })[];
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Deployments <span className="text-base font-normal text-text-secondary">(Manage Kubernetes deployments)</span></h1>
      </div>

      <div
        className="space-y-2"
      >
        <DataTable
          columns={columns}
          data={sortedDeployments}
          isLoading={isLoading}
          error={error}
          rowKey="id"
          onRowClick={(row) => {
            setSelectedDeployment(row);
            setPanelOpen(true);
          }}
          selectedRowKey={panelOpen && selectedDeployment ? `${selectedDeployment.namespace}/${selectedDeployment.name}` : undefined}
          sortState={sortState}
          onSortChange={(nextSort) => setSortState(nextSort as { key: DeploymentSortKey; direction: 'asc' | 'desc' })}
          enableRowSelection={true}
          selectedRows={selectedRows}
          onRowSelectionChange={(rows) => setSelectedRows(rows)}
        />

        </div>

      {panelOpen && selectedDeployment && (
        <>
          <div
            className="fixed inset-0 z-[95] bg-black/20"
            onClick={() => setPanelOpen(false)}
          />
          <DeploymentDetailPanel
            deployment={selectedDeployment}
            onClose={() => setPanelOpen(false)}
            onOpenYamlEditor={handleOpenYamlEditorFromPanel}
            onScale={scaleDeployment}
            onRestart={restartDeployment}
            onTailLogs={handleTailLogs}
            onQuickUpdateTag={quickUpdateDeploymentImageTag}
            onDelete={handleDeleteSingle}
          />
        </>
      )}

      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 px-4 py-3 bg-surface border-2 border-orange-500 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm text-text-secondary font-medium">
            {selectedRows.length} selected
          </span>
          <div className="w-px h-4 bg-border" />
          <button
            type="button"
            onClick={handleDeleteSelected}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-icon-danger)]/10 text-[var(--color-icon-danger)] hover:bg-[var(--color-icon-danger)]/20 font-medium transition-colors"
          >
            <Trash2 size={14} />
            Delete
          </button>
          <button
            type="button"
            onClick={() => setSelectedRows([])}
            className="text-xs text-text-secondary hover:text-text transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.label ?? ''}`}
        description={
          confirmDelete && confirmDelete.keys.length === 1
            ? `Are you sure you want to delete "${confirmDelete.label}"? This action cannot be undone.`
            : `Are you sure you want to delete ${confirmDelete?.keys.length} deployments? This action cannot be undone.`
        }
        confirmLabel="Delete"
        destructive
        isLoading={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
