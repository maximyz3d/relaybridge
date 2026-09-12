'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { intentHash, resultProjection } = require('./result-delivery');

// Reconstructible outbox: the existing task is the durable intent. The receipt
// adds delivery evidence without changing its linked provider execution receipt.
function deliveryReceipts(task, storeId) {
  const result = resultProjection(task, storeId);
  if (!result.resultPersisted) return [];
  const events = [{ event: 'delivery_persisted', at: task.finishedAt }];
  if (result.acknowledged) events.push({ event: 'delivery_acknowledged', at: result.acknowledgedAt });
  return events.map(({ event, at }) => {
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('invalid delivery event time');
    const binding = { event, taskId: task.id, receiptStoreId: storeId, resultHash: result.metadata.sha256 };
    return { ...binding, receiptId: `rcpt_delivery_${intentHash(binding)}`,
      timestamp: new Date(at).toISOString(), requestId: result.metadata.requestId,
      invocationId: result.metadata.invocationId, attemptId: result.metadata.attemptId,
      providerReceiptId: result.metadata.providerReceiptId, providerRunId: result.metadata.providerRunId,
      providerCompleted: result.metadata.providerCompleted, resultPersisted: true,
      resultDelivered: event === 'delivery_acknowledged', deliveryEvidence: event === 'delivery_acknowledged' ? 'caller_acknowledged_exact_hash' : 'durable_task_result',
      resultBytes: result.metadata.bytes, complete: result.metadata.complete,
      partial: result.metadata.partial, replay: false };
  });
}

function createDeliveryReceiptSink({ directory, append }) {
  return receipt => {
    const file = path.join(directory, `${receipt.timestamp.slice(0, 10)}.jsonl`);
    // Synchronous inspection and append share the bridge event loop. Bounds
    // fail closed and leave the task intent available for a subsequent repair.
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('delivery receipt scan limit');
      const bytes = fs.readFileSync(file, 'utf8');
      if (bytes && !bytes.endsWith('\n')) throw new Error('incomplete receipt journal');
      for (const line of bytes.split('\n')) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (row.receiptId !== receipt.receiptId) continue;
        if (intentHash(row) !== intentHash(receipt)) throw new Error('delivery receipt identity conflict');
        return { receiptId: row.receiptId, existing: true };
      }
    }
    append(receipt);
    return { receiptId: receipt.receiptId, existing: false };
  };
}

module.exports = { deliveryReceipts, createDeliveryReceiptSink };
