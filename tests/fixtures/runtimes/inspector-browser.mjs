import { mountInspector } from '@foxworth/boundary/inspector';

// The credential is owned by this fixture host, never by the inspector UI.
const token = 'inspector-fixture-private-credential';
const transport = {
  async manifest() {
    const response = await fetch('/manifest', { headers: { authorization: token } });
    if (!response.ok) throw new Error('manifest unavailable');
    return response.json();
  },
  async invoke(invocation) {
    const response = await fetch('/invoke', {
      method: 'POST', headers: { authorization: token, 'content-type': 'application/json' },
      body: JSON.stringify(invocation),
    });
    if (!response.ok) throw new Error('invocation unavailable');
    return response.json();
  },
};
const inspector = mountInspector(document.querySelector('#inspector'), { transport });
// Test-only host controls exercise the lifecycle the host actually owns.
window.inspectorFixture = {
  disconnect: () => inspector.setTransport(null),
  reconnect: () => inspector.setTransport(transport),
  refresh: () => inspector.refresh(),
  dispose: () => inspector.dispose(),
};
