import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Box, Loader, RotateCw, Upload, Trash2 } from './Icons';
import type { HelmRelease } from '../types';
import { useHelmReleaseHistory, useHelmReleaseResources, rollbackHelmRelease } from '../hooks/useKubernetes';
import { timeAgo } from '../utils';
import { ResourceDetailPanelLayout, PanelActionButton } from './ResourceDetailPanelLayout';
import { StatusBadge } from './StatusBadge';
import { ConfirmDialog } from './ConfirmDialog';
import { DrawerItem, DrawerTitle, DrawerLabelsAnnotations } from './drawer';

/** Helm release lifecycle descriptions (from helm list / release secret status). */
const getLifecycleDescription = (status: string): string => {
  const s = status.toLowerCase();
  switch (s) {
    case 'deployed':
      return 'Release is active and running.';
    case 'pending-install':
      return 'Install is in progress.';
    case 'pending-upgrade':
      return 'Upgrade is in progress.';
    case 'pending-rollback':
      return 'Rollback is in progress.';
    case 'uninstalling':
      return 'Uninstall is in progress (helm uninstall).';
    case 'uninstalled':
      return 'Release has been uninstalled.';
    case 'failed':
      return 'Release install, upgrade, or rollback failed.';
    case 'superseded':
      return 'Superseded by a newer revision.';
    default:
      return 'Release lifecycle state.';
  }
};

interface HelmReleaseDetailPanelProps {
  release: HelmRelease;
  onClose: () => void;
  onOpenYaml: (release: HelmRelease) => void;
  onDelete: (namespace: string, name: string) => void;
}

/** Helm release detail panel — layout and content order aligned with Freelens; includes Revisions (history) and Rollback like helm-dashboard. */
export const HelmReleaseDetailPanel = ({ release, onClose, onOpenYaml, onDelete }: HelmReleaseDetailPanelProps) => {
  const queryClient = useQueryClient();
  const { data: history = [], isLoading: historyLoading } = useHelmReleaseHistory(release.namespace, release.name);
  const { data: resources = [], isLoading: resourcesLoading } = useHelmReleaseResources(release.namespace, release.name);
  const [rollingBackRev, setRollingBackRev] = useState<number | null>(null);
  const [rollbackConfirmRev, setRollbackConfirmRev] = useState<number | null>(null);

  const handleRollback = async (revision: number) => {
    if (revision === release.revision) return;
    setRollingBackRev(revision);
    try {
      await rollbackHelmRelease(release.namespace, release.name, revision);
      toast.success(`Rolled back to revision ${revision}`);
      void queryClient.invalidateQueries({ queryKey: ['helm-releases'] });
      void queryClient.invalidateQueries({ queryKey: ['helm-release-history', release.namespace, release.name] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rollback failed');
    } finally {
      setRollingBackRev(null);
    }
  };

  const handleConfirmRollback = () => {
    const rev = rollbackConfirmRev;
    if (rev == null) return;
    setRollbackConfirmRev(null);
    void handleRollback(rev);
  };

  const releaseChart = release.chart === '-' ? release.name : release.chart;

  const renderResources = () => {
    if (resourcesLoading) {
      return (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          <Loader size={14} className="animate-spin flex-shrink-0" />
          Loading resources…
        </div>
      );
    }

    if (resources.length === 0) {
      return <p className="text-sm" style={{ color: 'var(--color-muted)' }}>No resources found.</p>;
    }

    return (
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-elevated">
              <th className="text-left py-2 px-3 font-medium" style={{ color: 'var(--color-muted)' }}>Kind</th>
              <th className="text-left py-2 px-3 font-medium" style={{ color: 'var(--color-muted)' }}>Name</th>
              <th className="text-left py-2 px-3 font-medium" style={{ color: 'var(--color-muted)' }}>Namespace</th>
              <th className="text-left py-2 px-3 font-medium" style={{ color: 'var(--color-muted)' }}>API Version</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => {
              const rowKey = `${r.api_version}:${r.kind}:${r.namespace || '-'}:${r.name}`;
              return (
                <tr key={rowKey} className="border-b border-border last:border-b-0 hover:opacity-90">
                  <td className="py-2 px-3 font-medium" style={{ color: 'var(--color-primary)' }}>{r.kind}</td>
                  <td className="py-2 px-3 font-mono text-xs" style={{ color: 'var(--color-text)' }}>{r.name}</td>
                  <td className="py-2 px-3 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{r.namespace || '—'}</td>
                  <td className="py-2 px-3 text-xs" style={{ color: 'var(--color-muted)' }}>{r.api_version}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderHistory = () => {
    if (historyLoading) {
      return (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          <Loader size={14} className="animate-spin flex-shrink-0" />
          Loading history…
        </div>
      );
    }

    if (history.length === 0) {
      return <p className="text-sm" style={{ color: 'var(--color-muted)' }}>No revision history.</p>;
    }

    return (
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-elevated">
              <th className="text-left py-2 px-3 font-medium" style={{ color: 'var(--color-muted)' }}>Rev</th>
              <th className="text-left py-2 px-3 font-medium" style={{ color: 'var(--color-muted)' }}>Updated</th>
              <th className="text-left py-2 px-3 font-medium" style={{ color: 'var(--color-muted)' }}>Status</th>
              <th className="text-left py-2 px-3 font-medium" style={{ color: 'var(--color-muted)' }}>Chart</th>
              <th className="text-left py-2 px-3 font-medium" style={{ color: 'var(--color-muted)' }}>Description</th>
              <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--color-muted)' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {[...history].reverse().map((rev) => {
              const isCurrent = rev.revision === release.revision;
              const isRollingBack = rollingBackRev === rev.revision;
              return (
                <tr
                  key={rev.revision}
                  className={`border-b border-border last:border-b-0 ${isCurrent ? 'bg-hover/50' : ''}`}
                >
                  <td className="py-2 px-3 font-medium" style={{ color: 'var(--color-text)' }}>{rev.revision}</td>
                  <td className="py-2 px-3" style={{ color: 'var(--color-text-secondary)' }} title={rev.updated}>
                    {timeAgo(rev.updated)}
                  </td>
                  <td className="py-2 px-3">
                    <StatusBadge status={rev.status} />
                  </td>
                  <td className="py-2 px-3 font-mono text-xs truncate max-w-[120px]" style={{ color: 'var(--color-text)' }} title={rev.chart}>
                    {rev.chart}
                  </td>
                  <td className="py-2 px-3 text-xs truncate max-w-[140px]" style={{ color: 'var(--color-text-secondary)' }} title={rev.description}>
                    {rev.description || '—'}
                  </td>
                  <td className="py-2 px-3 text-right">
                    {isCurrent ? (
                      <span className="text-xs" style={{ color: 'var(--color-muted)' }}>Current</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setRollbackConfirmRev(rev.revision)}
                        disabled={isRollingBack}
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-50"
                      >
                        {isRollingBack ? <Loader size={12} className="animate-spin" /> : <RotateCw size={12} />}
                        Rollback
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
  <ResourceDetailPanelLayout
    kind="Release"
    kindIcon={Box}
    title={release.name}
    status={release.status}
    keyInfo={[
      { label: 'Namespace', value: release.namespace },
      { label: 'Chart', value: releaseChart },
      { label: 'Revision', value: String(release.revision ?? '-') },
    ]}
    actions={
      <>
        <PanelActionButton icon={Upload} label="Upgrade Release" onClick={() => onOpenYaml(release)} />
        <PanelActionButton icon={Trash2} label="Uninstall Release" danger onClick={() => onDelete(release.namespace, release.name)} />
      </>
    }
    onClose={onClose}
  >
    <DrawerTitle>Release lifecycle</DrawerTitle>
    <DrawerItem name="Status">
      <StatusBadge status={release.status} />
    </DrawerItem>
    <p className="text-xs py-1" style={{ color: 'var(--color-muted)' }}>
      {getLifecycleDescription(release.status)}
    </p>
    <DrawerItem name="Chart">{releaseChart}</DrawerItem>
    <DrawerItem name="Updated">{release.updated ? `${timeAgo(release.updated)} (${release.updated})` : '—'}</DrawerItem>
    <DrawerItem name="Namespace">{release.namespace}</DrawerItem>
    <DrawerItem name="Version">{release.chart_version ?? '—'}</DrawerItem>
    <DrawerItem name="App Version">{release.app_version ?? '—'}</DrawerItem>
    <DrawerItem name="Revision">{release.revision ?? '—'}</DrawerItem>

    <DrawerTitle>Resources</DrawerTitle>
    <div className="space-y-2">{renderResources()}</div>

    <DrawerTitle>Revisions</DrawerTitle>
    <div className="space-y-2">{renderHistory()}</div>

    <DrawerLabelsAnnotations labels={release.labels} annotations={release.annotations} />

    <ConfirmDialog
      open={rollbackConfirmRev !== null}
      title="Rollback release"
      description={
        rollbackConfirmRev === null
          ? ''
          : `Roll back "${release.name}" to revision ${rollbackConfirmRev}? The current revision will be superseded.`
      }
      confirmLabel="Rollback"
      destructive
      isLoading={rollingBackRev !== null}
      onConfirm={handleConfirmRollback}
      onCancel={() => setRollbackConfirmRev(null)}
    />
  </ResourceDetailPanelLayout>
  );
};
