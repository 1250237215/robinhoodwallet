const PAGE_SOURCE = 'debot-social-page';
const RELAY_SOURCE = 'debot-social-relay';
const BACKGROUND_SOURCE = 'debot-social-background';
const FORCE_POLL_TIMEOUT_MS = 20_000;
const FORCE_POLL_ERROR_TYPES = new Set(['AUTH', 'TIMEOUT', 'NETWORK', 'DEBOT']);
const MAX_ANALYSIS_IN_FLIGHT = 4;
const ANALYSIS_RESULT_RETRY_BASE_MS = 2_000;
const ANALYSIS_RESULT_RETRY_MAX_MS = 30_000;
const ANALYSIS_JOB_FALLBACK_LEASE_MS = 90_000;
const pendingForcePolls = new Map();
const analysisJobs = new Map();
const pendingAnalysisResults = new Map();
let commandPollBusy = false;
let analysisPollBusy = false;

function sendToBackground(type, payload) {
  return chrome.runtime.sendMessage({ source: RELAY_SOURCE, type, payload });
}

function postToPage(type, value = {}) {
  window.postMessage({ source: RELAY_SOURCE, type, ...value }, window.location.origin);
}

function acknowledgePostDelivery(deliveryId, ok) {
  if (!deliveryId) return;
  postToPage('posts-delivery-result', { payload: { deliveryId, ok: ok === true } });
}

function forwardPosts(payload) {
  const deliveryId = String(payload?.deliveryId || '');
  void sendToBackground('posts', payload).then((result) => {
    acknowledgePostDelivery(deliveryId, result?.ok === true && result.payload?.durable === true);
  }).catch(() => {
    acknowledgePostDelivery(deliveryId, false);
  });
}

function analysisKey(jobId, claimToken) {
  return `${jobId}:${claimToken}`;
}

function normalizedAnalysisJob(value) {
  const job = value && typeof value === 'object' ? value : {};
  const id = Number(job.id);
  const claimToken = String(job.claimToken || '').slice(0, 240);
  const type = String(job.type || '');
  if (!Number.isSafeInteger(id) || id <= 0 || !claimToken) return null;
  if (!['debot.token_detail.v1', 'debot.wallet_token_analysis.v1'].includes(type)) return null;
  const now = Date.now();
  const advertisedExpiry = [Number(job.deadlineAt), Number(job.leaseExpiresAt)]
    .filter((value) => Number.isFinite(value) && value > 0);
  if (advertisedExpiry.some((value) => value <= now)) return null;
  return {
    ...job,
    id,
    type,
    claimToken,
    expiresAt: advertisedExpiry.length ? Math.min(...advertisedExpiry) : now + ANALYSIS_JOB_FALLBACK_LEASE_MS
  };
}

function pruneExpiredAnalysisJobs() {
  const now = Date.now();
  for (const [key, job] of analysisJobs) {
    if (job.expiresAt > now) continue;
    analysisJobs.delete(key);
    const pending = pendingAnalysisResults.get(key);
    if (pending?.timerId !== null && pending?.timerId !== undefined) clearTimeout(pending.timerId);
    pendingAnalysisResults.delete(key);
  }
}

function scheduleAnalysisResultRetry(key) {
  const pending = pendingAnalysisResults.get(key);
  if (!pending || pending.timerId !== null) return;
  const delay = Math.min(
    ANALYSIS_RESULT_RETRY_BASE_MS * (2 ** Math.min(pending.attempt, 4)),
    ANALYSIS_RESULT_RETRY_MAX_MS
  );
  pending.timerId = setTimeout(() => {
    const current = pendingAnalysisResults.get(key);
    if (current !== pending) return;
    current.timerId = null;
    current.attempt += 1;
    void deliverAnalysisResult(key);
  }, delay);
}

async function deliverAnalysisResult(key) {
  const pending = pendingAnalysisResults.get(key);
  if (!pending || pending.sending) return;
  pending.sending = true;
  try {
    const response = await sendToBackground('analysis-result', pending.payload);
    if (response?.ok !== true || response.payload?.durable !== true) {
      scheduleAnalysisResultRetry(key);
      return;
    }
    if (pending.timerId !== null) clearTimeout(pending.timerId);
    pendingAnalysisResults.delete(key);
    analysisJobs.delete(key);
    void pollAnalysisJobs();
  } catch {
    scheduleAnalysisResultRetry(key);
  } finally {
    const current = pendingAnalysisResults.get(key);
    if (current) current.sending = false;
  }
}

function forwardAnalysisResult(payload) {
  const jobId = Number(payload?.jobId);
  const claimToken = String(payload?.claimToken || '').slice(0, 240);
  const key = analysisKey(jobId, claimToken);
  if (!analysisJobs.has(key)) return;
  if (!pendingAnalysisResults.has(key)) {
    pendingAnalysisResults.set(key, {
      payload: {
        jobId,
        claimToken,
        success: payload?.success === true,
        result: payload?.success === true ? payload?.result ?? null : null,
        error: payload?.success === true ? '' : String(payload?.error || '').slice(0, 2_000),
        errorType: payload?.success === true ? '' : String(payload?.errorType || '').slice(0, 40)
      },
      attempt: 0,
      sending: false,
      timerId: null
    });
  }
  void deliverAnalysisResult(key);
}

function requestPageForcePoll(requestId) {
  const existing = pendingForcePolls.get(requestId);
  if (existing) return existing.promise;

  let resolveRequest;
  const promise = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const timeoutId = setTimeout(() => {
    if (pendingForcePolls.get(requestId)?.promise !== promise) return;
    pendingForcePolls.delete(requestId);
    resolveRequest({ ok: false, requestId, errorType: 'PAGE_TIMEOUT' });
  }, FORCE_POLL_TIMEOUT_MS);
  pendingForcePolls.set(requestId, { promise, resolve: resolveRequest, timeoutId });
  postToPage('force-poll', { requestId });
  return promise;
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || message.source !== PAGE_SOURCE) return;
  if (message.type === 'posts') {
    forwardPosts(message.payload);
    return;
  }
  if (['heartbeat', 'watchlist'].includes(message.type)) {
    void sendToBackground(message.type, message.payload).catch(() => {});
    return;
  }
  if (message.type === 'force-poll-result') {
    const requestId = typeof message.payload?.requestId === 'string' ? message.payload.requestId : '';
    const pending = pendingForcePolls.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingForcePolls.delete(requestId);
    pending.resolve({
      ok: message.payload?.ok === true,
      requestId,
      ...(message.payload?.ok === true
        ? {}
        : { errorType: FORCE_POLL_ERROR_TYPES.has(message.payload?.errorType) ? message.payload.errorType : 'DEBOT' })
    });
    return;
  }
  if (message.type === 'command-result') {
    void sendToBackground('command-result', message.payload).catch(() => {});
    return;
  }
  if (message.type === 'analysis-result') {
    forwardAnalysisResult(message.payload);
  }
});

async function pollCommands() {
  if (commandPollBusy) return;
  commandPollBusy = true;
  try {
    const result = await sendToBackground('poll-commands', {});
    if (!result?.ok) return;
    const commands = Array.isArray(result.payload?.commands) ? result.payload.commands : [];
    for (const command of commands) {
      postToPage('command', { command });
    }
  } catch {
    // The next poll retries after the bridge or VPS reconnects.
  } finally {
    commandPollBusy = false;
  }
}

async function pollAnalysisJobs() {
  if (analysisPollBusy) return;
  pruneExpiredAnalysisJobs();
  const capacity = MAX_ANALYSIS_IN_FLIGHT - analysisJobs.size;
  if (capacity <= 0) return;
  analysisPollBusy = true;
  try {
    const result = await sendToBackground('poll-analysis-jobs', { limit: capacity });
    if (!result?.ok) return;
    const jobs = Array.isArray(result.payload?.jobs) ? result.payload.jobs : [];
    for (const candidate of jobs) {
      if (analysisJobs.size >= MAX_ANALYSIS_IN_FLIGHT) break;
      const job = normalizedAnalysisJob(candidate);
      if (!job) continue;
      const key = analysisKey(job.id, job.claimToken);
      if (analysisJobs.has(key)) continue;
      analysisJobs.set(key, job);
      postToPage('analysis-job', { job });
    }
  } catch {
    // The next interval or recovery probe retries after reconnection.
  } finally {
    analysisPollBusy = false;
  }
}

if (chrome.runtime.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.source !== BACKGROUND_SOURCE || message.type !== 'force-poll') return false;
    if (sender?.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return false;
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    if (!requestId.trim()) {
      sendResponse({ ok: false, requestId, errorType: 'DEBOT' });
      return false;
    }
    void pollCommands();
    void pollAnalysisJobs();
    void requestPageForcePoll(requestId).then(sendResponse);
    return true;
  });
}

void pollCommands();
void pollAnalysisJobs();
setInterval(() => {
  void pollCommands();
  void pollAnalysisJobs();
}, 2_000);
