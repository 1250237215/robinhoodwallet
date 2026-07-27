const SOCIAL_API_SUFFIX = '/api/social';

function parseServerBase(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('Radar social API address is required');

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Radar social API address is invalid');
  }

  const localHttp = url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('Radar social API must use HTTPS; HTTP is allowed only for localhost or 127.0.0.1');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Radar social API must not contain credentials, a query string, or a fragment');
  }

  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (!pathname.endsWith(SOCIAL_API_SUFFIX)) {
    throw new Error(`Radar social API path must end with ${SOCIAL_API_SUFFIX}`);
  }
  return { url, pathname };
}

function extensionMatchOrigin(url) {
  return `${url.protocol}//${url.hostname}`;
}

export function normalizeServerBase(value) {
  const { url, pathname } = parseServerBase(value);
  return `${url.origin}${pathname}`;
}

export function serverOriginForBase(value) {
  return new URL(normalizeServerBase(value)).origin;
}

export function hostPermissionForServerBase(value) {
  const { url } = parseServerBase(value);
  return `${extensionMatchOrigin(url)}/*`;
}

export function radarRootPathForServerBase(value) {
  const { pathname } = parseServerBase(value);
  const root = pathname.slice(0, -SOCIAL_API_SUFFIX.length);
  return root || '/';
}

export function radarContentMatchForServerBase(value) {
  const { url } = parseServerBase(value);
  const root = radarRootPathForServerBase(value);
  const path = root === '/' ? '/*' : `${root}/*`;
  return `${extensionMatchOrigin(url)}${path}`;
}

export function radarContentMatchesForServerBase(value) {
  const { url } = parseServerBase(value);
  const root = radarRootPathForServerBase(value);
  const origin = extensionMatchOrigin(url);
  return root === '/'
    ? [`${origin}/*`]
    : [`${origin}${root}`, `${origin}${root}/*`];
}

export function isRadarPageUrl(value, serverBase) {
  let page;
  let server;
  try {
    page = new URL(String(value || ''));
    server = new URL(normalizeServerBase(serverBase));
  } catch {
    return false;
  }
  if (page.origin !== server.origin) return false;
  const root = radarRootPathForServerBase(serverBase);
  return root === '/' || page.pathname === root || page.pathname.startsWith(`${root}/`);
}
