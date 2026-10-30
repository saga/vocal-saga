import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

if (!parentPort) throw new Error('Book scan worker must run in a worker thread.');

try {
  const { scanBookSegmentFeatures } = await tsImport('./bookScan.ts', import.meta.url);
  const segments = Array.isArray(workerData?.segments) ? workerData.segments : [];
  const sourceLang = typeof workerData?.sourceLang === 'string' ? workerData.sourceLang : 'en';
  const features = scanBookSegmentFeatures(segments, sourceLang);
  parentPort.postMessage({ ok: true, features });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  parentPort.close();
}
