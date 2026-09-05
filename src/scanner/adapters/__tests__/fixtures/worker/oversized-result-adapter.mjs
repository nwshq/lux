import { parentPort } from 'node:worker_threads';
parentPort.postMessage('{"padding":"' + 'x'.repeat(8 * 1024 * 1024) + '"}');
