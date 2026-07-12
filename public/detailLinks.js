function normalizeText(value) {
  return String(value || '');
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]
  );
}

function normalizeHandle(value) {
  const raw = normalizeText(value).trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{2,20}$/.test(raw) ? `@${raw}` : null;
}

function normalizeWallet(value) {
  return normalizeText(value).match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase() || null;
}

function validHttpUrl(value) {
  const text = normalizeText(value).trim();
  if (!/^https?:\/\//i.test(text)) {
    return null;
  }
  try {
    return new URL(text).toString();
  } catch {
    return null;
  }
}

export function xUrlForHandle(handle) {
  const normalized = normalizeHandle(handle);
  return normalized ? `https://x.com/${normalized.slice(1)}` : null;
}

export function basescanAddressUrl(address) {
  const wallet = normalizeWallet(address);
  return wallet ? `https://basescan.org/address/${wallet}` : null;
}

export function renderLinkedValue(value, url = null) {
  const text = normalizeText(value);
  if (!text) {
    return '未确认';
  }

  const href = validHttpUrl(url);
  if (!href) {
    return escapeHtml(text);
  }

  return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;
}

export function buildDetailLinks({ devHandle, feeRecipientHandle, feeRecipientWallet, virtualsWalletAddress, bankr = {} }) {
  const deployerHandle = bankr.deployerHandle || null;
  const deployerWallet = bankr.deployerWallet || null;

  return {
    devUrl: xUrlForHandle(devHandle),
    feeRecipientUrl: bankr.feeRecipientUrl || xUrlForHandle(feeRecipientHandle),
    feeRecipientWalletUrl: basescanAddressUrl(feeRecipientWallet),
    virtualsWalletUrl: basescanAddressUrl(virtualsWalletAddress),
    bankrUrl: bankr.url || null,
    deployerUrl: bankr.deployerUrl || xUrlForHandle(deployerHandle) || basescanAddressUrl(deployerWallet),
    tweetUrl: bankr.tweetUrl || null,
    websiteUrl: bankr.websiteUrl || null
  };
}

export function linkifyEvidenceText(value) {
  const text = normalizeText(value);
  if (!text) {
    return '';
  }

  const pattern =
    /(https?:\/\/[^\s<>"']+)|(@[A-Za-z0-9_]{2,20})|(0x[a-fA-F0-9]{40})/g;
  let html = '';
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    html += escapeHtml(text.slice(cursor, match.index));
    const token = match[0];
    const href =
      validHttpUrl(token) || xUrlForHandle(token) || basescanAddressUrl(token) || null;
    html += href ? renderLinkedValue(token, href) : escapeHtml(token);
    cursor = match.index + token.length;
  }

  html += escapeHtml(text.slice(cursor));
  return html;
}
