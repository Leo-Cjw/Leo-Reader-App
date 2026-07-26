import v8 from 'node:v8';
import { spawnSync } from 'node:child_process';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const responseMarker = `__READER_PARSER_RESPONSE_${request.nonce}__`;

if (request.task === 'hang') {
  setInterval(() => {}, 1000);
} else if (request.task === 'crash') {
  process.exit(17);
} else {
  let nestedProcessBlocked = false;
  try { spawnSync(process.execPath, ['-e', '']); }
  catch (error) { nestedProcessBlocked = error?.code === 'ERR_ACCESS_DENIED'; }
  const result = request.task === 'oversize'
    ? { value: 'x'.repeat(16_000) }
    : {
        pid: process.pid,
        execArgv: process.execArgv,
        heapLimit: v8.getHeapStatistics().heap_size_limit,
        electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
        nodeOptions: process.env.NODE_OPTIONS,
        parserWorker: process.env.READER_PARSER_WORKER,
        inheritedSecret: process.env.READER_PARSER_SECRET,
        permissionsEnabled: Boolean(process.permission),
        fsWriteAllowed: process.permission?.has('fs.write') ?? null,
        arbitraryReadAllowed: process.permission?.has('fs.read', '/etc/passwd') ?? null,
        nestedProcessBlocked
      };
  process.stdout.write(`${responseMarker}${JSON.stringify({ version: 1, ok: true, result })}`);
}
