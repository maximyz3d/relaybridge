'use strict';

// Read-only metadata transport. The promise owns the entire response body and
// cancellation cleanup; callers may use it as a physical singleflight worker.
async function readBoundedJson(url, { signal, timeoutMs = 4000, maxBytes = 1048576, headers, fetchImpl = fetch } = {}) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('metadata read timed out')), timeoutMs);
  timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let response, reader;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: combined, ...(headers ? { headers } : {}) });
    if (!response.ok) {
      await response.body?.cancel();
      return { completed: true, status: response.status, body: null };
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error('metadata response has no body');
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('metadata response exceeds the byte limit');
      chunks.push(Buffer.from(value));
    }
    const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    return { completed: true, status: response.status, body };
  } catch (error) {
    try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch {}
    return { completed: false, status: response?.status || null, body: null,
      timedOut: deadline.signal.aborted && !signal?.aborted, aborted: !!signal?.aborted,
      error: error.message };
  } finally {
    reader?.releaseLock();
    clearTimeout(timer);
  }
}

module.exports = { readBoundedJson };
