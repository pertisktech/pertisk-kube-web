import { useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2, ExternalLink } from '../components/Icons';
import { useRealtimeIngresses } from '../hooks/useRealtimeResources';
import { deleteIngress } from '../hooks/useKubernetes';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable, IngressDetailPanel, ConfirmDialog } from '../components';
import type { Ingress } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo, matchesResourceNameFilter } from '../utils';
import { openPanelTab } from '../components/BottomPanel';

type IngressSortKey = 'name' | 'namespace' | 'ingress_class' | 'hosts' | 'address' | 'rules' | 'age';

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

const normalizeIngressHosts = (hosts: string): string[] =>
  hosts
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

const toExternalIngressUrl = (host: string): string | null => {
  const sanitized = host.replace(/^\*\./, '').trim();
  if (!sanitized) return null;
  if (/^https?:\/\//i.test(sanitized)) return sanitized;
  return `https://${sanitized}`;
};

const getKey = (item: Ingress) => `${item.namespace}/${item.name}`;

export const IngressesPage = () => {
  const { data, isLoading, error } = useRealtimeIngresses();
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedItem, setSelectedItem] = useState<Ingress | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: IngressSortKey; direction: 'asc' | 'desc' }>({ key: 'age', direction: 'desc' });


  const handleDeleteSingle = async (namespace: string, name: string) => { setConfirmDelete({ keys: [`${namespace}/${name}`], label: name }); setPanelOpen(false); };
  const handleDeleteSelected = () => { if (!selectedRows.length) return; setConfirmDelete({ keys: selectedRows, label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} ingresses` }); };
  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try { await Promise.all(confirmDelete.keys.map((k) => { const [ns, n] = k.split('/'); return deleteIngress(ns, n); })); setSelectedRows([]); setConfirmDelete(null); }
    finally { setIsDeleting(false); }
  };

  const columns = [
    { header: 'Name', accessor: (row: Ingress) => <span className="font-medium text-text">{row.name}</span>, width: '20%', sortable: true, sortKey: 'name' },
    { header: 'Namespace', accessor: 'namespace' as const, width: '16%', sortable: true, sortKey: 'namespace' },
    { header: 'Class', accessor: 'ingress_class' as const, width: '14%', sortable: true, sortKey: 'ingress_class' },
    {
      header: 'Hosts',
      accessor: (row: Ingress) => {
        const hosts = normalizeIngressHosts(row.hosts);
        if (!hosts.length) return <span className="text-text-secondary">-</span>;

        return (
          <div className="flex flex-wrap items-center gap-2">
            {hosts.map((host) => {
              const targetUrl = toExternalIngressUrl(host);
              return (
                <span key={`${row.namespace}/${row.name}/${host}`} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-text-secondary">
                  <span className="max-w-[180px] truncate" title={host}>{host}</span>
                  {targetUrl && (
                    <a
                      href={targetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-icon-info)] hover:opacity-80"
                      title={`Open ${host} in new tab`}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Open ${host} in new tab`}
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </span>
              );
            })}
          </div>
        );
      },
      width: '20%',
      sortable: true,
      sortKey: 'hosts',
    },
    { header: 'Address', accessor: 'address' as const, width: '16%', sortable: true, sortKey: 'address' },
    { header: 'Rules', accessor: 'rules' as const, width: '6%', sortable: true, sortKey: 'rules' },
    { header: 'Age', accessor: (row: Ingress) => timeAgo(row.age), width: '8%', sortable: true, sortKey: 'age' },
  ];

  const sortedData = useMemo((): (Ingress & { id: string })[] => {
    let src = [...(data || [])];
    if (selectedNamespaces.length > 0) src = src.filter((i) => selectedNamespaces.includes(i.namespace));
    if (resourceNameFilter.trim()) src = src.filter((i) => matchesResourceNameFilter(i.name, resourceNameFilter));
    const withId = src.map((i) => ({ ...i, id: getKey(i) }));
    const f = sortState.direction === 'asc' ? 1 : -1;
    return withId.sort((a, b) => {
      if (sortState.key === 'name') return a.name.localeCompare(b.name) * f;
      if (sortState.key === 'namespace') return a.namespace.localeCompare(b.namespace) * f;
      if (sortState.key === 'ingress_class') return (a.ingress_class || '').localeCompare(b.ingress_class || '') * f;
      if (sortState.key === 'hosts') return (a.hosts || '').localeCompare(b.hosts || '') * f;
      if (sortState.key === 'address') return (a.address || '').localeCompare(b.address || '') * f;
      if (sortState.key === 'rules') return ((a.rules || 0) - (b.rules || 0)) * f;
      const at = Date.parse(a.age || ''); const bt = Date.parse(b.age || '');
      return ((Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt)) * f;
    });
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);


  const handleOpenYamlEditorFromPanel = async (item: Ingress) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/ingresses/${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.name)}/yaml`, {
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
        <h1 className="text-xl font-semibold text-text">Ingresses <span className="text-base font-normal text-text-secondary">(View ingress hosts, addresses, and rules)</span></h1>
      </div>

      <div className="space-y-2">
        <DataTable
          columns={columns} data={sortedData} isLoading={isLoading} error={error} rowKey="id"
          onRowClick={(row) => { setSelectedItem(row); setPanelOpen(true); }}
          selectedRowKey={panelOpen && selectedItem ? getKey(selectedItem) : undefined}
          sortState={sortState} onSortChange={(s) => setSortState(s as { key: IngressSortKey; direction: 'asc' | 'desc' })}
          enableRowSelection={true} selectedRows={selectedRows} onRowSelectionChange={setSelectedRows}
        />

        </div>

      {panelOpen && selectedItem && (
        <>
          <div className="fixed inset-0 z-[95] bg-black/20" onClick={() => setPanelOpen(false)} />
          <IngressDetailPanel ingress={selectedItem} onClose={() => setPanelOpen(false)} onOpenYamlEditor={handleOpenYamlEditorFromPanel} onDelete={handleDeleteSingle} />
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
        description={confirmDelete?.keys.length === 1 ? `Are you sure you want to delete "${confirmDelete?.label}"? This action cannot be undone.` : `Are you sure you want to delete ${confirmDelete?.keys.length} ingresses? This action cannot be undone.`}
        confirmLabel="Delete" destructive isLoading={isDeleting} onConfirm={handleConfirmDelete} onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
};
