import { getAuthToken } from './auth';

const INGRESS_ADDRESS_ANNOTATIONS = [
  'external-dns.alpha.kubernetes.io/target',
  'external-dns.alpha.kubernetes.io/hostname',
  'nginx.ingress.kubernetes.io/external-dns',
] as const;

interface IngressClassApiItem {
  name?: string;
  controller?: string;
  address?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

interface ServiceApiItem {
  name?: string;
  namespace?: string;
  service_type?: string;
  external_ip?: string;
}

let cachedIngressClassAddressMap: Record<string, string> = {};

export function getCachedIngressClassAddressMap(): Record<string, string> {
  return cachedIngressClassAddressMap;
}

function sortIngressAddresses(addresses: string[]): string[] {
  return [...new Set(addresses)].sort((a, b) => {
    const isIpv4 = (value: string) => value.includes('.') && !value.includes(':');
    if (isIpv4(a) && !isIpv4(b)) return -1;
    if (!isIpv4(a) && isIpv4(b)) return 1;
    return a.localeCompare(b);
  });
}

function formatIngressAddresses(addresses: string[]): string {
  const cleaned = sortIngressAddresses(addresses.filter((value) => value && value !== '-'));
  return cleaned.length > 0 ? cleaned.join(', ') : '-';
}

function parseExternalAddresses(externalIp: string | undefined): string[] {
  if (!externalIp || externalIp === '-') return [];
  return externalIp.split(',').map((part) => part.trim()).filter(Boolean);
}

function controllerServiceCandidates(classItem: IngressClassApiItem): Array<[string, string]> {
  const className = classItem.name?.trim() ?? '';
  const annotations = classItem.annotations ?? {};
  const labels = classItem.labels ?? {};
  const releaseNamespace = annotations['meta.helm.sh/release-namespace']?.trim();
  const releaseName = annotations['meta.helm.sh/release-name']?.trim();
  const appName = labels['app.kubernetes.io/name']?.trim();
  const appInstance = labels['app.kubernetes.io/instance']?.trim();
  const controller = classItem.controller?.trim();

  const candidates: Array<[string, string]> = [];
  if (!releaseNamespace) {
    return candidates;
  }

  if (releaseName) candidates.push([releaseNamespace, releaseName]);
  if (appInstance) candidates.push([releaseNamespace, appInstance]);
  if (appName) candidates.push([releaseNamespace, appName]);
  if (className) candidates.push([releaseNamespace, className]);

  if (controller) {
    const serviceName = controller.split('/').pop()?.trim();
    if (serviceName) candidates.push([releaseNamespace, serviceName]);
  }

  return candidates;
}

function buildLoadBalancerServiceMap(services: ServiceApiItem[]): Map<string, string[]> {
  const map = new Map<string, string[]>();

  for (const service of services) {
    if (service.service_type !== 'LoadBalancer') continue;
    const namespace = service.namespace?.trim();
    const name = service.name?.trim();
    if (!namespace || !name) continue;

    const addresses = parseExternalAddresses(service.external_ip);
    if (addresses.length === 0) continue;
    map.set(`${namespace}/${name}`, addresses);
  }

  return map;
}

function resolveClassAddressFromServices(
  classItem: IngressClassApiItem,
  loadBalancerServices: Map<string, string[]>,
): string {
  for (const [namespace, serviceName] of controllerServiceCandidates(classItem)) {
    const addresses = loadBalancerServices.get(`${namespace}/${serviceName}`);
    if (addresses?.length) {
      return formatIngressAddresses(addresses);
    }
  }

  const releaseNamespace = classItem.annotations?.['meta.helm.sh/release-namespace']?.trim();
  if (!releaseNamespace) return '-';

  const inNamespace = [...loadBalancerServices.entries()].filter(([key]) =>
    key.startsWith(`${releaseNamespace}/`),
  );
  if (inNamespace.length === 1) {
    return formatIngressAddresses(inNamespace[0][1]);
  }

  return '-';
}

export async function refreshIngressClassAddressMap(signal?: AbortSignal): Promise<Record<string, string>> {
  const token = getAuthToken();
  const headers = token ? { Authorization: token } : undefined;

  const [classResponse, serviceResponse] = await Promise.all([
    fetch('/api/ingressclasses', { cache: 'no-store', signal, headers }),
    fetch('/api/services', { cache: 'no-store', signal, headers }),
  ]);

  const map: Record<string, string> = {};

  if (classResponse.ok) {
    const classPayload = await classResponse.json() as { data?: IngressClassApiItem[] };
    const loadBalancerServices = serviceResponse.ok
      ? buildLoadBalancerServiceMap((await serviceResponse.json() as { data?: ServiceApiItem[] }).data ?? [])
      : new Map<string, string[]>();

    for (const classItem of classPayload.data ?? []) {
      if (!classItem.name) continue;

      // Resolve from LoadBalancer services first — backend may miss classes where
      // Helm release name differs from app.kubernetes.io/name (e.g. pertisk-proxy).
      const resolved = resolveClassAddressFromServices(classItem, loadBalancerServices);
      if (resolved !== '-') {
        map[classItem.name] = resolved;
        continue;
      }

      const apiAddress = classItem.address?.trim();
      if (apiAddress && apiAddress !== '-') {
        map[classItem.name] = apiAddress;
      }
    }
  }

  cachedIngressClassAddressMap = map;
  return map;
}

/** @deprecated use refreshIngressClassAddressMap */
export async function fetchIngressClassAddressMap(signal?: AbortSignal): Promise<Record<string, string>> {
  return refreshIngressClassAddressMap(signal);
}

export function normalizeIngressHosts(hosts: string): string[] {
  return hosts
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

export function toExternalIngressUrl(host: string): string | null {
  const sanitized = host.replace(/^\*\./, '').trim();
  if (!sanitized) return null;

  const normalized = sanitized.toLowerCase();
  if (normalized === '-' || normalized === '<none>' || normalized === 'none' || normalized === 'n/a') {
    return null;
  }

  if (/^https?:\/\//i.test(sanitized)) return sanitized;

  const defaultProtocol =
    typeof window !== 'undefined' && window.location.protocol === 'http:' ? 'http' : 'https';
  return `${defaultProtocol}://${sanitized}`;
}

export function extractIngressAddress(raw: Record<string, unknown>): string {
  const status = (raw.status as Record<string, unknown> | undefined) ?? {};
  const loadBalancer =
    (status.loadBalancer as Record<string, unknown> | undefined) ??
    (status.load_balancer as Record<string, unknown> | undefined);
  const ingressEntries = (loadBalancer?.ingress as Array<Record<string, unknown>> | undefined) ?? [];

  const fromStatus = ingressEntries
    .map((entry) => {
      const ip = entry.ip;
      const hostname = entry.hostname;
      if (typeof ip === 'string' && ip.trim()) return ip.trim();
      if (typeof hostname === 'string' && hostname.trim()) return hostname.trim();
      return null;
    })
    .filter((value): value is string => Boolean(value));

  if (fromStatus.length > 0) {
    return formatIngressAddresses(fromStatus);
  }

  const annotations = (raw.metadata as Record<string, unknown> | undefined)?.annotations as
    | Record<string, string>
    | undefined;
  if (annotations) {
    const fromAnnotations = INGRESS_ADDRESS_ANNOTATIONS.flatMap((key) => {
      const value = annotations[key];
      if (!value?.trim()) return [];
      return value.split(',').map((part) => part.trim()).filter(Boolean);
    });
    if (fromAnnotations.length > 0) {
      return formatIngressAddresses(fromAnnotations);
    }
  }

  return '-';
}

interface IngressLike {
  ingress_class: string;
  address: string;
}

export function applyIngressControllerAddresses<T extends IngressLike>(
  items: T[],
  classAddressMap: Record<string, string> = cachedIngressClassAddressMap,
): T[] {
  return items.map((item) => {
    const controllerAddress = classAddressMap[item.ingress_class];
    if (controllerAddress && controllerAddress !== '-') {
      return { ...item, address: controllerAddress };
    }

    if (item.address && item.address !== '-') {
      return item;
    }

    return item;
  });
}

export function resolveIngressAddressForClass(
  ingressClass: string,
  raw: Record<string, unknown>,
  classAddressMap: Record<string, string> = cachedIngressClassAddressMap,
): string {
  const controllerAddress = classAddressMap[ingressClass];
  if (controllerAddress && controllerAddress !== '-') {
    return controllerAddress;
  }

  if (typeof raw.address === 'string' && raw.address.trim() && raw.address !== '-') {
    return raw.address;
  }

  return extractIngressAddress(raw);
}
