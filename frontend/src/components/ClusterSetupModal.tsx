import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  fetchClusterStatus,
  selectClusterContext,
  uploadKubeconfig,
  type ClusterStatus,
} from '../hooks/useKubernetes';
import { dispatchResourcesRefresh } from '../hooks/useRealtimeResources';

interface ClusterSetupModalProps {
  open: boolean;
  onClose?: () => void;
  onConnected?: (status: ClusterStatus) => void;
}

export const ClusterSetupModal = ({ open, onClose, onConnected }: ClusterSetupModalProps) => {
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [content, setContent] = useState('');
  const [context, setContext] = useState('');
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const next = await fetchClusterStatus();
        if (!cancelled) {
          setStatus(next);
          if (next.context) setContext(next.context);
        }
      } catch {
        // ignore — modal still usable for upload
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const contexts = useMemo(() => {
    if (status?.contexts?.length) return status.contexts;
    return [];
  }, [status]);

  if (!open) return null;

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setParsing(true);
    try {
      const text = await file.text();
      setContent(text);
      toast.message(`Loaded ${file.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to read kubeconfig file');
    } finally {
      setParsing(false);
    }
  };

  const handleConnect = async () => {
    if (!content.trim()) {
      toast.error('Paste or upload a kubeconfig first');
      return;
    }
    setLoading(true);
    try {
      const result = await uploadKubeconfig(content, context || undefined);
      toast.success(result.message || `Connected (${result.context})`);
      window.dispatchEvent(new CustomEvent('cluster:switched'));
      dispatchResourcesRefresh();
      const next = await fetchClusterStatus();
      setStatus(next);
      onConnected?.(next);
      onClose?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to connect cluster');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectContext = async () => {
    if (!context.trim()) {
      toast.error('Select a context');
      return;
    }
    setLoading(true);
    try {
      const result = await selectClusterContext(context);
      toast.success(result.message || `Switched to ${result.context}`);
      window.dispatchEvent(new CustomEvent('cluster:switched'));
      dispatchResourcesRefresh();
      const next = await fetchClusterStatus();
      setStatus(next);
      onConnected?.(next);
      onClose?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to switch context');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-surface shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-text">Connect Kubernetes cluster</h2>
            <p className="mt-1 text-sm text-text-secondary">
              {status?.message
                || 'Upload a kubeconfig to start managing the cluster. The service can start without one.'}
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-sm text-text-secondary hover:bg-surface-hover hover:text-text"
            >
              Close
            </button>
          )}
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text">Kubeconfig file</label>
            <input
              type="file"
              accept=".yaml,.yml,.conf,text/*,*"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-text-secondary file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text">Or paste kubeconfig YAML</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={10}
              placeholder="apiVersion: v1&#10;kind: Config&#10;..."
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {(contexts.length > 0 || context) && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text">Context</label>
              {contexts.length > 0 ? (
                <select
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
                >
                  <option value="">Use current-context</option>
                  {contexts.map((ctx) => (
                    <option key={ctx} value={ctx}>
                      {ctx}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  placeholder="optional context name"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
                />
              )}
            </div>
          )}

          {status && !status.placeholder && status.context && (
            <p className="rounded-lg bg-[var(--color-icon-success)]/10 px-3 py-2 text-sm text-[var(--color-icon-success)]">
              Connected to context <strong>{status.context}</strong>
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
          {status && !status.placeholder && contexts.length > 0 && (
            <button
              type="button"
              disabled={loading || !context}
              onClick={handleSelectContext}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text hover:bg-surface-hover disabled:opacity-50"
            >
              Switch context
            </button>
          )}
          <button
            type="button"
            disabled={loading || parsing || !content.trim()}
            onClick={handleConnect}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
};
