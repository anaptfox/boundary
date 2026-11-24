import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  bindNativeInteractions, bindProjection, compileInteractions, defineInteraction,
  installInteractions, projectInteractions,
} from '@foxworth/boundary';
import { portableSchema } from '@foxworth/boundary/program';
import { executeHandoff } from '@foxworth/boundary/handoff';
import { createControlRequestContributions } from '@foxworth/boundary/host/control';

const token = 'inspector-fixture-private-credential';
const string = portableSchema({ type: 'string', minLength: 2 });
const definitions = {
  change: defineInteraction({ id: 'fixture.change', input: string, output: string, changes: ['fixture'] }),
  inspect: defineInteraction({ id: 'fixture.inspect', output: string, reads: ['fixture'] }),
  nested: defineInteraction({ id: 'fixture.nested', output: portableSchema({ type: 'object', properties: { certainty: { type: 'string' } }, required: ['certainty'], additionalProperties: false }) }),
  hidden: defineInteraction({ id: 'fixture.hidden', output: string }),
};
const compiled = compileInteractions(definitions);
let effects = 0;
let proposals = 0;
const bindings = bindNativeInteractions(compiled, { change: null, inspect: null, nested: null, hidden: null }, {
  async change({ input, outcomes }) {
    effects++;
    if (input.startsWith('slow-')) await new Promise(resolve => setTimeout(resolve, 800));
    return input === 'unknown' ? outcomes.unknown() : outcomes.returned(input);
  },
  inspect({ outcomes }) { return outcomes.returned('visible'); },
  nested({ outcomes }) { return outcomes.returned({ certainty: 'unknown' }); },
  hidden({ outcomes }) { return outcomes.returned('hidden'); },
});
const installed = installInteractions(compiled, {
  installationId: 'inspector:fixture:installation', bindings,
  requests: createControlRequestContributions(compiled, {
    change: { interaction: compiled.handles.change, controlDigest: compiled.handles.change.contractDigest,
      previewSchema: string, request(input) { proposals++; return input; } },
  }),
  realizationIds: { change: { direct: 'inspector:fixture:change', request: 'inspector:fixture:proposal' }, inspect: { direct: 'inspector:fixture:inspect' }, nested: { direct: 'inspector:fixture:nested' }, hidden: { direct: 'inspector:fixture:hidden' } },
});
const projection = projectInteractions(compiled, { change: { interaction: compiled.handles.change, modes: ['direct', 'request'] }, inspect: 'direct', nested: 'direct' });
const bound = bindProjection(projection, installed.installation, { admit: () => ({ decision: 'allow' }) });
assert.equal(bound.status, 'bound');
const bundle = await readFile(process.argv[2]);
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html><body><main id="inspector"></main><script type="module" src="/bundle.js"></script></body></html>'); return; }
    if (request.url === '/bundle.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(bundle); return; }
    if (request.headers.authorization !== token) { response.writeHead(403); response.end(); return; }
    if (request.url === '/manifest') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(bound.binding.manifest)); return; }
    if (request.url === '/invoke') {
      let body = ''; for await (const chunk of request) body += chunk;
      const outcome = await executeHandoff(bound.binding, JSON.parse(body), {});
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(outcome)); return;
    }
    if (request.url === '/effects') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ effects, proposals })); return; }
    if (request.url === '/revoke') { bound.controller.revoke(); response.writeHead(204); response.end(); return; }
    response.writeHead(404); response.end();
  } catch (error) { console.error(error); response.writeHead(500); response.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
console.log(`INSPECTOR_URL=http://127.0.0.1:${server.address().port}`);
process.on('SIGTERM', () => server.close());
