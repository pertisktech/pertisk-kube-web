import { useEffect, useMemo, useState } from 'react';
import YAML from 'yaml';
import { Trash2 } from '../components/Icons';
import { useRealtimeJobs } from '../hooks/useRealtimeResources';
import { useRealtimePods } from '../hooks/useRealtimePods';
import { useNamespace } from '../context/NamespaceContext';
import { DataTable, JobDetailPanel, ConfirmDialog } from '../components';
import { StatusBadge } from '../components/StatusBadge';
import type { Job, Pod } from '../types';
import { getAuthToken } from '../utils/auth';
import { timeAgo, matchesResourceNameFilter } from '../utils';
import { deleteJob } from '../hooks/useKubernetes';
import { openPanelTab } from '../components/BottomPanel';

type JobSortKey = 'name' | 'namespace' | 'status' | 'completions' | 'duration' | 'age';

const sanitizeJobYamlForEdit = (yamlText: string) => {
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

export const JobsPage = () => {
  const { data, isLoading, error } = useRealtimeJobs();
  const { data: pods } = useRealtimePods<Pod>({ enabled: true });
  const { selectedNamespaces, resourceNameFilter } = useNamespace();
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortState, setSortState] = useState<{ key: JobSortKey; direction: 'asc' | 'desc' }>({
    key: 'age',
    direction: 'desc',
  });

  useEffect(() => {
    if (!data || data.length === 0) {
      setSelectedJob(null);
      return;
    }

    if (!selectedJob) {
      setSelectedJob(data[0]);
      return;
    }

    const updatedSelected = data.find(
      (item) => item.name === selectedJob.name && item.namespace === selectedJob.namespace
    );
    setSelectedJob(updatedSelected ?? data[0]);
  }, [data]);


  const handleOpenYamlEditorFromPanel = async (job: Job) => {
    setPanelOpen(false);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/jobs/${encodeURIComponent(job.namespace)}/${encodeURIComponent(job.name)}/yaml`, {
        headers: token ? { Authorization: token } : {},
      });
      if (!res.ok) throw new Error(`Failed to load YAML: ${res.statusText}`);
      const yaml = await res.text();
      openPanelTab({ type: 'yaml-editor', yamlContent: sanitizeJobYamlForEdit(yaml), title: job.name });
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
      label: selectedRows.length === 1 ? selectedRows[0].split('/')[1] : `${selectedRows.length} jobs`,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setIsDeleting(true);
    try {
      await Promise.all(
        confirmDelete.keys.map((key) => {
          const [ns, name] = key.split('/');
          return deleteJob(ns, name);
        })
      );
      setSelectedRows([]);
      setConfirmDelete(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const getCompletionTextClass = (completions: string) => {
    const [done, total] = completions.split('/').map((value) => Number(value));
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0 && done >= total) {
      return 'text-[var(--color-icon-success)]';
    }
    return 'text-text-secondary';
  };

  const parseDurationToSeconds = (duration: string): number => {
    const trimmed = (duration || '').trim();
    if (!trimmed || trimmed === '-') return -1;
    const match = trimmed.match(/^(\d+)\s*([smhdw])$/i);
    if (!match) return -1;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 's') return value;
    if (unit === 'm') return value * 60;
    if (unit === 'h') return value * 3600;
    if (unit === 'd') return value * 86400;
    return value * 604800;
  };

  const columns = [
    {
      header: 'Name',
      accessor: (row: Job) => (
        <span className="font-medium text-text">{row.name}</span>
      ),
      width: '28%',
      sortable: true,
      sortKey: 'name',
    },
    {
      header: 'Namespace',
      accessor: 'namespace' as const,
      width: '18%',
      sortable: true,
      sortKey: 'namespace',
    },
    {
      header: 'Status',
      accessor: (row: Job) => <StatusBadge status={row.status || 'Pending'} />,
      width: '15%',
      sortable: true,
      sortKey: 'status',
    },
    {
      header: 'Completions',
      accessor: (row: Job) => (
        <span className={`font-medium ${getCompletionTextClass(row.completions || '-')}`}>
          {row.completions || '-'}
        </span>
      ),
      width: '15%',
      sortable: true,
      sortKey: 'completions',
    },
    {
      header: 'Duration',
      accessor: 'duration' as const,
      width: '12%',
      sortable: true,
      sortKey: 'duration',
    },
    {
      header: 'Age',
      accessor: (row: Job) => timeAgo(row.age),
      width: '12%',
      sortable: true,
      sortKey: 'age',
    },
  ];

  const sortedJobs = useMemo((): (Job & { id: string })[] => {
    let source = [...(data || [])];
    
    // Filter by selected namespaces (if any are selected)
    if (selectedNamespaces.length > 0) {
      source = source.filter((job) => selectedNamespaces.includes(job.namespace));
    }
    if (resourceNameFilter.trim()) {
      source = source.filter((job) => matchesResourceNameFilter(job.name, resourceNameFilter));
    }
    
    // Add unique id for row selection
    source = source.map((job) => ({
      ...job,
      id: `${job.namespace}/${job.name}`,
    })) as (Job & { id: string })[];
    
    const factor = sortState.direction === 'asc' ? 1 : -1;

    return source.sort((first, second) => {
      if (sortState.key === 'name') return first.name.localeCompare(second.name) * factor;
      if (sortState.key === 'namespace') return first.namespace.localeCompare(second.namespace) * factor;
      if (sortState.key === 'status') return (first.status || '').localeCompare(second.status || '') * factor;
      if (sortState.key === 'completions') {
        const parse = (value: string) => {
          const [done, total] = (value || '').split('/').map((v) => Number(v));
          if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return -1;
          return done / total;
        };
        return (parse(first.completions) - parse(second.completions)) * factor;
      }
      if (sortState.key === 'duration') {
        return (parseDurationToSeconds(first.duration) - parseDurationToSeconds(second.duration)) * factor;
      }

      const firstAge = Date.parse(first.age || '');
      const secondAge = Date.parse(second.age || '');
      return ((Number.isNaN(firstAge) ? 0 : firstAge) - (Number.isNaN(secondAge) ? 0 : secondAge)) * factor;
    }) as (Job & { id: string })[];
  }, [data, sortState, selectedNamespaces, resourceNameFilter]);

  const selectedJobPod = useMemo(() => {
    if (!selectedJob) return null;
    const owner = `Job/${selectedJob.name}`;

    const relatedPods = (pods || []).filter(
      (pod) => pod.namespace === selectedJob.namespace && pod.controlled_by === owner
    );

    if (relatedPods.length === 0) return null;

    return [...relatedPods].sort((first, second) => {
      const firstHasMetrics = Number(first.cpu_usage_percent != null) + Number(first.memory_usage_percent != null);
      const secondHasMetrics = Number(second.cpu_usage_percent != null) + Number(second.memory_usage_percent != null);
      if (firstHasMetrics !== secondHasMetrics) return secondHasMetrics - firstHasMetrics;

      const firstTime = Date.parse(first.created || first.age || '');
      const secondTime = Date.parse(second.created || second.age || '');
      return (Number.isFinite(secondTime) ? secondTime : 0) - (Number.isFinite(firstTime) ? firstTime : 0);
    })[0];
  }, [pods, selectedJob]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Jobs <span className="text-base font-normal text-text-secondary">(Manage Kubernetes jobs)</span></h1>
      </div>

      <div
        className="space-y-2"
      >
        <DataTable
        columns={columns}
        data={sortedJobs}
        isLoading={isLoading}
        error={error}
        rowKey="id"
        onRowClick={(row) => {
          setSelectedJob(row);
          setPanelOpen(true);
        }}
        selectedRowKey={panelOpen && selectedJob ? `${selectedJob.namespace}/${selectedJob.name}` : undefined}
        sortState={sortState}
        onSortChange={(nextSort) => setSortState(nextSort as { key: JobSortKey; direction: 'asc' | 'desc' })}
        enableRowSelection={true}
        selectedRows={selectedRows}
        onRowSelectionChange={(rows) => setSelectedRows(rows)}
      />

        </div>

      {panelOpen && selectedJob && (
        <>
          <div
            className="fixed inset-0 z-[95] bg-black/20"
            onClick={() => setPanelOpen(false)}
          />
          <JobDetailPanel
            job={selectedJob}
            podForMetrics={selectedJobPod}
            onClose={() => setPanelOpen(false)}
            onOpenYamlEditor={handleOpenYamlEditorFromPanel}
            onDelete={handleDeleteSingle}
          />
        </>
      )}

      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 px-4 py-3 bg-surface border-2 border-violet-500 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
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
            : `Are you sure you want to delete ${confirmDelete?.keys.length} jobs? This action cannot be undone.`
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
