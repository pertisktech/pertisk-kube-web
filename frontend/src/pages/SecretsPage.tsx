import { useEffect, useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimeSecrets } from '../hooks/useRealtimeResources';
import { deleteSecret } from '../hooks/useKubernetes';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable, SecretDetailPanel, ConfirmDialog } from '../components';
import type { Secret } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo, matchesResourceNameFilter } from '../utils';
import { openPanelTab } from '../components/BottomPanel';

type SecretSortKey = 'name' | 'namespace' | 'secret_type' | 'data_keys' | 'age';

const sanitizeSecretYamlForEdit = (yamlText: string) => {
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
        delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
        if (Object.keys(annotations).length === 0) {
          delete metadata.annotations;
        }
      }
    }

    delete parsed.status;

    return YAML.stringify(parsed, { lineWidth: 0 });
  } catch {
    return yamlText;
  }
};

export const SecretsPage = () => {
  const { data, isLoading, error } = useRealtimeSecrets();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedSecret, setSelectedSecret] = useState<Secret | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: SecretSortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });

  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedSecret(null);
      return;
    }

    if (!selectedSecret) {
      setSelectedSecret(data[0]);
      return;
    }

    const updatedSelected = data.find(
      (item) => item.name === selectedSecret.name && item.namespace === selectedSecret.namespace
    );
    setSelectedSecret(updatedSelected ?? data[0]);
  }, [data]);


  const handleOpenYamlEditorFromPanel = async (secret: Secret) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/secrets/${encodeURIComponent(secret.namespace)}/${encodeURIComponent(secret.name)}/yaml`, {
        headers: token ? { Authorization: token } : {},
      });
      if (!res.ok) throw new Error(`Failed to load YAML: ${res.statusText}`);
      const yaml = await res.text();
      openPanelTab({ type: 'yaml-editor', yamlContent: sanitizeSecretYamlForEdit(yaml), title: secret.name });
    } catch {
      openPanelTab({ type: 'yaml-editor' });
    }
  };


  const handleDeleteSingle = async (namespace: string, name: string) => {
    setConfirmDelete({ keys: [`${namespace}/${name}`], label: name });
    setPanelOpen(false);
  };

  const handleDeleteSelected = () => {
    if (selectedRows.length === 0) return;
    setConfirmDelete({
      keys: selectedRows,
      label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} secrets`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(
        confirmDelete.keys.map((key) => {
          const [ns, name] = key.split('/');
          return deleteSecret(ns, name);
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
      accessor: (s: Secret) => <span className="font-medium text-text">{s.name}</span>,
      width: '25%',
      sortable: true,
      sortKey: 'name',
    },
    {
      header: 'Namespace',
      accessor: 'namespace' as const,
      width: '20%',
      sortable: true,
      sortKey: 'namespace',
    },
    {
      header: 'Type',
      accessor: (s: Secret) => (
        <span className="text-text-secondary text-sm">{s.secret_type}</span>
      ),
      width: '20%',
      sortable: true,
      sortKey: 'secret_type',
    },
    {
      header: 'Data Keys',
      accessor: 'data_keys' as const,
      width: '15%',
      sortable: true,
      sortKey: 'data_keys',
    },
    {
      header: 'Age',
      accessor: (s: Secret) => timeAgo(s.age),
      width: '15%',
      sortable: true,
      sortKey: 'age',
    },
  ];

  const sortedSecrets = useMemo((): (Secret & { id: string })[] => {
    let source = [...(data || [])];

    if (selectedNamespaces.length > 0) {
      source = source.filter((s) => selectedNamespaces.includes(s.namespace));
    }
    if (resourceNameFilter.trim()) {
      source = source.filter((s) => matchesResourceNameFilter(s.name, resourceNameFilter));
    }

    const sourceWithId = source.map((item) => ({
      ...item,
      id: `${item.namespace}/${item.name}`,
    }));

    const factor = sortState.direction === 'asc' ? 1 : -1;

    return sourceWithId.sort((first, second) => {
      if (sortState.key === 'name') return first.name.localeCompare(second.name) * factor;
      if (sortState.key === 'namespace') return first.namespace.localeCompare(second.namespace) * factor;
      if (sortState.key === 'secret_type') return (first.secret_type || '').localeCompare(second.secret_type || '') * factor;
      if (sortState.key === 'data_keys') return ((first.data_keys ?? 0) - (second.data_keys ?? 0)) * factor;

      const firstAge = Date.parse(first.age || '');
      const secondAge = Date.parse(second.age || '');
      return ((Number.isNaN(firstAge) ? 0 : firstAge) - (Number.isNaN(secondAge) ? 0 : secondAge)) * factor;
    });
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Secrets <span className="text-base font-normal text-text-secondary">(Manage Kubernetes Secrets)</span></h1>
      </div>

      <div
        className="space-y-2"
      >
        <DataTable
          columns={columns}
          data={sortedSecrets}
          isLoading={isLoading}
          error={error}
          rowKey="id"
          onRowClick={(row) => {
            setSelectedSecret(row);
            setPanelOpen(true);
          }}
          selectedRowKey={
            panelOpen && selectedSecret
              ? `${selectedSecret.namespace}/${selectedSecret.name}`
              : undefined
          }
          sortState={sortState}
          onSortChange={(nextSort) =>
            setSortState(nextSort as { key: SecretSortKey; direction: 'asc' | 'desc' })
          }
          enableRowSelection={true}
          selectedRows={selectedRows}
          onRowSelectionChange={(rows) => setSelectedRows(rows)}
        />

        </div>

      {panelOpen && selectedSecret && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <SecretDetailPanel
            secret={selectedSecret}
            onClose={() => setPanelOpen(false)}
            onOpenYamlEditor={handleOpenYamlEditorFromPanel}
            onDelete={handleDeleteSingle}
          />
        </>
      )}

      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 px-4 py-3 bg-surface border-2 border-violet-500 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm text-text-secondary font-medium">{selectedRows.length} selected</span>
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
            : `Are you sure you want to delete ${confirmDelete?.keys.length} secrets? This action cannot be undone.`
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
