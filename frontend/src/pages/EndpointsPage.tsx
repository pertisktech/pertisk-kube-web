import { useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimeEndpoints } from '../hooks/useRealtimeResources';
import { deleteEndpoint } from '../hooks/useKubernetes';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable, EndpointDetailPanel, ConfirmDialog } from '../components';
import type { Endpoint } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo, matchesResourceNameFilter } from '../utils';
import { openPanelTab } from '../components/BottomPanel';

type EndpointSortKey = 'name' | 'namespace' | 'addresses' | 'not_ready' | 'ports' | 'age';

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

const getKey = (item: Endpoint) => `${item.namespace}/${item.name}`;

export const EndpointsPage = () => {
  const { data, isLoading, error } = useRealtimeEndpoints();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedItem, setSelectedItem] = useState<Endpoint | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: EndpointSortKey; direction: 'asc' | 'desc' }>({ key: 'age', direction: 'desc' });


  const handleDeleteSingle = async (namespace: string, name: string) => { setConfirmDelete({ keys: [`${namespace}/${name}`], label: name }); setPanelOpen(false); };
  const handleDeleteSelected = () => { if (!selectedRows.length) return; setConfirmDelete({ keys: selectedRows, label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} endpoints` }); };
  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try { await Promise.all(confirmDelete.keys.map((k) => { const [ns, n] = k.split('/'); return deleteEndpoint(ns, n); })); setSelectedRows([]); setConfirmDelete(null); }
    finally { setIsDeleting(false); }
  };

  const columns = [
    { header: 'Name', accessor: (row: Endpoint) => <span className="font-medium text-text">{row.name}</span>, width: '24%', sortable: true, sortKey: 'name' },
    { header: 'Namespace', accessor: 'namespace' as const, width: '18%', sortable: true, sortKey: 'namespace' },
    { header: 'Ready', accessor: 'addresses' as const, width: '10%', sortable: true, sortKey: 'addresses' },
    { header: 'Not Ready', accessor: 'not_ready' as const, width: '12%', sortable: true, sortKey: 'not_ready' },
    { header: 'Ports', accessor: 'ports' as const, width: '24%', sortable: true, sortKey: 'ports' },
    { header: 'Age', accessor: (row: Endpoint) => timeAgo(row.age), width: '12%', sortable: true, sortKey: 'age' },
  ];

  const sortedData = useMemo((): (Endpoint & { id: string })[] => {
    let src = [...(data || [])];
    if (selectedNamespaces.length > 0) src = src.filter((i) => selectedNamespaces.includes(i.namespace));
    if (resourceNameFilter.trim()) src = src.filter((i) => matchesResourceNameFilter(i.name, resourceNameFilter));
    const withId = src.map((i) => ({ ...i, id: getKey(i) }));
    const f = sortState.direction === 'asc' ? 1 : -1;
    return withId.sort((a, b) => {
      if (sortState.key === 'name') return a.name.localeCompare(b.name) * f;
      if (sortState.key === 'namespace') return a.namespace.localeCompare(b.namespace) * f;
      if (sortState.key === 'addresses') return ((a.addresses || 0) - (b.addresses || 0)) * f;
      if (sortState.key === 'not_ready') return ((a.not_ready || 0) - (b.not_ready || 0)) * f;
      if (sortState.key === 'ports') return (a.ports || '').localeCompare(b.ports || '') * f;
      const at = Date.parse(a.age || ''); const bt = Date.parse(b.age || '');
      return ((Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt)) * f;
    });
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);


  const handleOpenYamlEditorFromPanel = async (item: Endpoint) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/endpoints/${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.name)}/yaml`, {
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
        <h1 className="text-xl font-semibold text-text">Endpoints <span className="text-base font-normal text-text-secondary">(Inspect endpoint addresses and ports)</span></h1>
      </div>

      <div className="space-y-2">
        <DataTable
          columns={columns} data={sortedData} isLoading={isLoading} error={error} rowKey="id"
          onRowClick={(row) => { setSelectedItem(row); setPanelOpen(true); }}
          selectedRowKey={panelOpen && selectedItem ? getKey(selectedItem) : undefined}
          sortState={sortState} onSortChange={(s) => setSortState(s as { key: EndpointSortKey; direction: 'asc' | 'desc' })}
          enableRowSelection={true} selectedRows={selectedRows} onRowSelectionChange={setSelectedRows}
        />

        </div>

      {panelOpen && selectedItem && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <EndpointDetailPanel endpoint={selectedItem} onClose={() => setPanelOpen(false)} onOpenYamlEditor={handleOpenYamlEditorFromPanel} onDelete={handleDeleteSingle} />
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
        description={confirmDelete?.keys.length === 1 ? `Are you sure you want to delete "${confirmDelete?.label}"? This action cannot be undone.` : `Are you sure you want to delete ${confirmDelete?.keys.length} endpoints? This action cannot be undone.`}
        confirmLabel="Delete" destructive isLoading={isDeleting} onConfirm={handleConfirmDelete} onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
