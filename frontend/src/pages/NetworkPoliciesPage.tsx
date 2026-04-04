import { useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimeNetworkPolicies } from '../hooks/useRealtimeResources';
import { deleteNetworkPolicy } from '../hooks/useKubernetes';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable, NetworkPolicyDetailPanel, ConfirmDialog } from '../components';
import type { NetworkPolicy } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo, matchesResourceNameFilter } from '../utils';
import { openPanelTab } from '../components/BottomPanel';

type NetworkPolicySortKey = 'name' | 'namespace' | 'pod_selector' | 'policy_types' | 'ingress_rules' | 'egress_rules' | 'age';

const sanitizeYamlForEdit = (yamlText: string) => {
  try {
    const parsed = YAML.parse(yamlText) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return yamlText;
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (metadata) {
      delete metadata.managedFields; delete metadata.resourceVersion; delete metadata.uid;
      delete metadata.generation; delete metadata.creationTimestamp; delete metadata.selfLink;
      const annotations = metadata.annotations as Record<string, unknown> | undefined;
      if (annotations) { delete annotations['kubectl.kubernetes.io/last-applied-configuration']; if (Object.keys(annotations).length === 0) delete metadata.annotations; }
    }
    delete parsed.status;
    return YAML.stringify(parsed, { lineWidth: 0 });
  } catch { return yamlText; }
};

export const NetworkPoliciesPage = () => {
  const { data, isLoading, error } = useRealtimeNetworkPolicies();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedItem, setSelectedItem] = useState<NetworkPolicy | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: NetworkPolicySortKey; direction: 'asc' | 'desc' }>({ key: 'age', direction: 'desc' });


  const handleDeleteSingle = async (namespace: string, name: string) => { setConfirmDelete({ keys: [`${namespace}/${name}`], label: name }); setPanelOpen(false); };
  const handleDeleteSelected = () => { if (!selectedRows.length) return; setConfirmDelete({ keys: selectedRows, label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] ?? selectedRows[0] : `${selectedRows.length} network policies` }); };
  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try { await Promise.all(confirmDelete.keys.map((key) => { const [ns, name] = key.split('/'); return deleteNetworkPolicy(ns, name); })); setSelectedRows([]); setConfirmDelete(null); }
    finally { setIsDeleting(false); }
  };

  const columns = [
    { header: 'Name', accessor: (row: NetworkPolicy) => <span className="font-medium text-text">{row.name}</span>, width: '20%', sortable: true, sortKey: 'name' },
    { header: 'Namespace', accessor: 'namespace' as const, width: '14%', sortable: true, sortKey: 'namespace' },
    { header: 'Pod Selector', accessor: 'pod_selector' as const, width: '20%', sortable: true, sortKey: 'pod_selector' },
    { header: 'Policy Types', accessor: 'policy_types' as const, width: '16%', sortable: true, sortKey: 'policy_types' },
    { header: 'Ingress Rules', accessor: (row: NetworkPolicy) => String(row.ingress_rules ?? 0), width: '12%', sortable: true, sortKey: 'ingress_rules' },
    { header: 'Egress Rules', accessor: (row: NetworkPolicy) => String(row.egress_rules ?? 0), width: '12%', sortable: true, sortKey: 'egress_rules' },
    { header: 'Age', accessor: (row: NetworkPolicy) => timeAgo(row.age), width: '14%', sortable: true, sortKey: 'age' },
  ];

  const sortedData = useMemo((): (NetworkPolicy & { id: string })[] => {
    let filtered = (data || []).filter((i) => selectedNamespaces.length === 0 || selectedNamespaces.includes(i.namespace));
    if (resourceNameFilter.trim()) {
      filtered = filtered.filter((i) => matchesResourceNameFilter(i.name, resourceNameFilter));
    }
    const withId = filtered.map((i) => ({ ...i, id: `${i.namespace}/${i.name}` }));
    const f = sortState.direction === 'asc' ? 1 : -1;
    return withId.sort((a, b) => {
      if (sortState.key === 'name') return a.name.localeCompare(b.name) * f;
      if (sortState.key === 'namespace') return a.namespace.localeCompare(b.namespace) * f;
      if (sortState.key === 'pod_selector') return (a.pod_selector || '').localeCompare(b.pod_selector || '') * f;
      if (sortState.key === 'policy_types') return (a.policy_types || '').localeCompare(b.policy_types || '') * f;
      if (sortState.key === 'ingress_rules') return ((a.ingress_rules ?? 0) - (b.ingress_rules ?? 0)) * f;
      if (sortState.key === 'egress_rules') return ((a.egress_rules ?? 0) - (b.egress_rules ?? 0)) * f;
      const at = Date.parse(a.age || ''); const bt = Date.parse(b.age || '');
      return ((Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt)) * f;
    });
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);


  const handleOpenYamlEditorFromPanel = async (item: NetworkPolicy) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/networkpolicies/${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.name)}/yaml`, {
        headers: token ? { Authorization: token } : {},
      });
      if (!res.ok) throw new Error(`Failed to load YAML: ${res.statusText}`);
      const yaml = await res.text();
      openPanelTab({ type: 'yaml-editor', yamlContent: sanitizeYamlForEdit(yaml), title: item.name });
    } catch {
      openPanelTab({ type: 'yaml-editor' });
    }
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Network Policies <span className="text-base font-normal text-text-secondary">(Manage Kubernetes network policy configurations)</span></h1>
      </div>

      <div className="space-y-2">
        <DataTable
          columns={columns} data={sortedData} isLoading={isLoading} error={error} rowKey="id"
          onRowClick={(row) => { setSelectedItem(row); setPanelOpen(true); }}
          selectedRowKey={panelOpen && selectedItem ? `${selectedItem.namespace}/${selectedItem.name}` : undefined}
          sortState={sortState} onSortChange={(s) => setSortState(s as { key: NetworkPolicySortKey; direction: 'asc' | 'desc' })}
          enableRowSelection={true} selectedRows={selectedRows} onRowSelectionChange={setSelectedRows}
        />

        </div>

      {panelOpen && selectedItem && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <NetworkPolicyDetailPanel networkPolicy={selectedItem} onClose={() => setPanelOpen(false)} onOpenYamlEditor={handleOpenYamlEditorFromPanel} onDelete={handleDeleteSingle} />
        </>
      )}

      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 px-4 py-3 bg-surface border-2 border-violet-500 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm text-text-secondary font-medium">{selectedRows.length} selected</span>
          <div className="w-px h-4 bg-border" />
          <button type="button" onClick={handleDeleteSelected} className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-icon-danger)]/10 text-[var(--color-icon-danger)] hover:bg-[var(--color-icon-danger)]/20 font-medium transition-colors"><Trash2 size={14} />Delete</button>
          <button type="button" onClick={() => setSelectedRows([])} className="text-xs text-text-secondary hover:text-text transition-colors">Clear</button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.label ?? ''}`}
        description={confirmDelete?.keys.length === 1 ? `Are you sure you want to delete "${confirmDelete?.label}"? This action cannot be undone.` : `Are you sure you want to delete ${confirmDelete?.keys.length} network policies? This action cannot be undone.`}
        confirmLabel="Delete" destructive isLoading={isDeleting} onConfirm={handleConfirmDelete} onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
