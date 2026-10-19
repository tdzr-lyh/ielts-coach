import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudSync } from '../cloud.js';

const clone = value => JSON.parse(JSON.stringify(value));

function harness(initialUser = 'A') {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true }, configurable: true,
  });
  globalThis.IELTS_COACH_CLOUD = {
    provider: 'supabase', url: 'https://example.supabase.co', anonKey: 'test-public-key',
  };
  const context = {
    storage,
    records: new Map(),
    events: [],
    user: initialUser ? { id: initialUser, email: `${initialUser.toLowerCase()}@example.com` } : null,
    rpcCount: 0,
    queryCount: 0,
    queryError: null,
    queryGate: null,
    queryEntered: null,
    rpcGate: null,
    rpcEntered: null,
    rpcHook: null,
    signUpRequests: [],
  };
  context.client = {
    auth: {
      getSession: async () => ({ data: { session: context.user ? { user: context.user } : null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signUp: async request => {
        context.signUpRequests.push(clone(request));
        return { data: { session: null }, error: null };
      },
      signInWithPassword: async ({ email }) => {
        context.user = { id: email[0].toUpperCase(), email };
        return { data: { user: context.user }, error: null };
      },
      signOut: async () => { context.user = null; return { error: null }; },
    },
    from(table) {
      assert.equal(table, 'ielts_coach_states', 'old listening table must never be touched');
      let userId;
      return {
        select() { return this; },
        eq(column, value) { assert.equal(column, 'user_id'); userId = value; return this; },
        async maybeSingle() {
          context.queryCount += 1;
          const remote = context.records.has(userId) ? clone(context.records.get(userId)) : null;
          if (context.queryGate) {
            const gate = context.queryGate;
            context.queryGate = null;
            context.queryEntered?.();
            await gate;
          }
          return {
            data: remote,
            error: context.queryError,
          };
        },
      };
    },
    async rpc(name, args) {
      assert.equal(name, 'save_ielts_coach_state');
      context.rpcCount += 1;
      const userId = context.user.id;
      if (context.rpcHook) {
        const hook = context.rpcHook;
        context.rpcHook = null;
        hook(userId);
      }
      if (context.rpcGate) {
        const gate = context.rpcGate;
        context.rpcGate = null;
        context.rpcEntered?.();
        await gate;
      }
      const previous = context.records.get(userId);
      if ((previous?.revision ?? 0) !== args.p_expected_revision) {
        return {
          data: [{ applied: false, state: previous?.state ?? null, revision: previous?.revision ?? 0 }],
          error: null,
        };
      }
      const row = {
        state: clone(args.p_state),
        revision: (previous?.revision ?? 0) + 1,
        updated_at: new Date().toISOString(),
      };
      context.records.set(userId, row);
      return { data: [{ applied: true, ...clone(row) }], error: null };
    },
  };
  globalThis.supabase = {
    createClient(_url, _key, options) {
      assert.equal(options.auth.storageKey, 'ielts-coach-auth-v1');
      return context.client;
    },
  };
  context.makeCloud = () => new CloudSync({
    onStatus: (kind, message) => context.events.push({ type: 'status', kind, message }),
    onRemote: (state, revision) => context.events.push({ type: 'remote', state, revision }),
    onConflict: value => context.events.push({ type: 'conflict', ...value }),
    onAuth: user => context.events.push({ type: 'auth', userId: user?.id ?? null }),
  });
  context.cached = id => JSON.parse(storage.get(`ielts-coach-cloud-state-v1:${id}`));
  return context;
}

test('new account does not upload defaults or emit an empty remote state', async () => {
  const h = harness();
  const cloud = h.makeCloud();
  const result = await cloud.init();
  assert.equal(result.user.id, 'A');
  assert.equal('state' in result, false);
  assert.equal(h.rpcCount, 0);
  assert.equal(h.events.filter(event => event.type === 'remote').length, 0);
  await cloud.save({ value: 1 });
  assert.deepEqual(h.records.get('A').state, { value: 1 });
  assert.equal(h.records.get('A').revision, 1);
});

test('save arriving during an RPC retains the latest draft and advances its version', async () => {
  const h = harness();
  const cloud = h.makeCloud();
  await cloud.init();
  await cloud.save({ value: 1 });
  let unblock;
  h.rpcGate = new Promise(resolve => { unblock = resolve; });
  const entered = new Promise(resolve => { h.rpcEntered = resolve; });
  const first = cloud.save({ value: 2 });
  await entered;
  const second = cloud.save({ value: 3 });
  unblock();
  await Promise.all([first, second]);
  assert.deepEqual(h.records.get('A').state, { value: 3 });
  assert.equal(h.records.get('A').revision, 3);
  assert.equal(h.cached('A').dirty, false);
});

test('stage is synchronous, sends no request, and restores the final edit after immediate reload', async () => {
  const h = harness();
  const cloud = h.makeCloud();
  await cloud.init();
  await cloud.save({ value: 'previous' });
  const before = { query: h.queryCount, rpc: h.rpcCount };
  const staged = cloud.stage({ value: 'last-keystroke' });
  assert.equal(staged instanceof Promise, false);
  assert.equal(h.queryCount, before.query);
  assert.equal(h.rpcCount, before.rpc);
  assert.equal(h.cached('A').dirty, true);
  assert.equal(h.cached('A').state.value, 'last-keystroke');
  const restored = h.makeCloud();
  const result = await restored.init();
  assert.equal(result.state.value, 'last-keystroke');
  assert.equal(h.records.get('A').state.value, 'last-keystroke');
  assert.equal(h.records.get('A').revision, 2);
});

test('staged draft remains durable when reload finds a conflicting remote revision', async () => {
  const h = harness();
  const cloud = h.makeCloud();
  await cloud.init();
  await cloud.save({ value: 'previous' });
  cloud.stage({ value: 'last-keystroke' });
  h.records.set('A', { state: { value: 'other-device' }, revision: 2, updated_at: 'test' });
  const restored = h.makeCloud();
  const result = await restored.init();
  assert.equal(result.conflict, true);
  assert.equal(result.state.value, 'last-keystroke');
  assert.equal(h.cached('A').state.value, 'last-keystroke');
  assert.equal(h.cached('A').dirty, true);
  assert.equal(h.records.get('A').state.value, 'other-device');
});

test('a background pull that started before stage does not apply a stale remote snapshot', async () => {
  const h = harness();
  const cloud = h.makeCloud();
  await cloud.init();
  await cloud.save({ value: 'previous' });
  let unblock;
  h.queryGate = new Promise(resolve => { unblock = resolve; });
  const entered = new Promise(resolve => { h.queryEntered = resolve; });
  const pulling = cloud.pull();
  await entered;
  cloud.stage({ value: 'edit-during-pull' });
  unblock();
  await pulling;
  assert.equal(h.cached('A').state.value, 'edit-during-pull');
  assert.equal(h.records.get('A').state.value, 'edit-during-pull');
  assert.equal(h.events.some(event => event.type === 'remote' && event.state.value === 'previous'), false);
});

test('stage during an older write preserves and uploads the newest draft after that write', async () => {
  const h = harness();
  const cloud = h.makeCloud();
  await cloud.init();
  await cloud.save({ value: 'previous' });
  let unblock;
  h.rpcGate = new Promise(resolve => { unblock = resolve; });
  const entered = new Promise(resolve => { h.rpcEntered = resolve; });
  const saving = cloud.save({ value: 'first-edit' });
  await entered;
  const callsBeforeStage = h.rpcCount;
  cloud.stage({ value: 'latest-edit' });
  assert.equal(h.rpcCount, callsBeforeStage);
  assert.equal(h.cached('A').state.value, 'latest-edit');
  unblock();
  await saving;
  assert.equal(h.records.get('A').state.value, 'latest-edit');
  assert.equal(h.records.get('A').revision, 3);
  assert.equal(h.cached('A').dirty, false);
});

test('a newer remote version blocks writes and can be explicitly adopted', async () => {
  const h = harness();
  const cloud = h.makeCloud();
  await cloud.init();
  await cloud.save({ value: 'first' });
  h.records.set('A', { state: { value: 'remote' }, revision: 2, updated_at: 'test' });
  const before = h.rpcCount;
  const result = await cloud.save({ value: 'local' });
  assert.equal(result.conflict, true);
  assert.equal(h.rpcCount, before);
  assert.equal(h.cached('A').dirty, true);
  assert.equal(h.cached('A').state.value, 'local');
  assert.equal(h.records.get('A').state.value, 'remote');
  await cloud.resolveConflict('remote');
  assert.equal(h.cached('A').dirty, false);
  assert.equal(h.events.filter(event => event.type === 'remote').at(-1).state.value, 'remote');
});

test('a read-then-write race is caught by CAS and local choice retries deliberately', async () => {
  const h = harness();
  const cloud = h.makeCloud();
  await cloud.init();
  await cloud.save({ value: 'first' });
  h.rpcHook = id => h.records.set(id, { state: { value: 'raced' }, revision: 2, updated_at: 'test' });
  await cloud.save({ value: 'local' });
  assert.equal(h.records.get('A').state.value, 'raced');
  assert.equal(h.events.at(-1).type, 'conflict');
  cloud.stage({ value: 'latest-local' });
  await cloud.resolveConflict('local');
  assert.equal(h.records.get('A').state.value, 'latest-local');
  assert.equal(h.records.get('A').revision, 3);
});

test('offline draft survives a reload and synchronizes after version validation', async () => {
  const h = harness();
  const cloud = h.makeCloud();
  await cloud.init();
  await cloud.save({ value: 'first' });
  navigator.onLine = false;
  await cloud.save({ value: 'offline' });
  assert.equal(h.records.get('A').revision, 1);
  const restored = h.makeCloud();
  const result = await restored.init();
  assert.equal(result.state.value, 'offline');
  assert.equal(h.cached('A').dirty, true);
  navigator.onLine = true;
  await restored.pull();
  assert.equal(h.records.get('A').state.value, 'offline');
  assert.equal(h.records.get('A').revision, 2);
});

test('offline drafts remain under their original account across sign-out and sign-in', async () => {
  const h = harness();
  const cloud = h.makeCloud();
  await cloud.init();
  await cloud.save({ value: 'A-first' });
  navigator.onLine = false;
  await cloud.save({ value: 'A-pending' });
  await cloud.signOut();
  const result = await cloud.signIn('b@example.com', 'unused-test-password');
  assert.equal('state' in result, false);
  assert.equal(h.records.has('B'), false);
  navigator.onLine = true;
  await cloud.save({ value: 'B-only' });
  assert.equal(h.records.get('A').state.value, 'A-first');
  assert.equal(h.records.get('B').state.value, 'B-only');
  await cloud.signOut();
  await cloud.signIn('a@example.com', 'unused-test-password');
  assert.equal(h.records.get('A').state.value, 'A-pending');
});

test('an old in-flight response cannot overwrite the next account cache', async () => {
  const h = harness();
  const cloud = h.makeCloud();
  await cloud.init();
  let unblock;
  h.rpcGate = new Promise(resolve => { unblock = resolve; });
  const entered = new Promise(resolve => { h.rpcEntered = resolve; });
  const oldSave = cloud.save({ value: 'A-flight' });
  await entered;
  await cloud.signOut();
  await cloud.signIn('b@example.com', 'unused-test-password');
  await cloud.save({ value: 'B-only' });
  unblock();
  await oldSave;
  assert.equal(cloud.user.id, 'B');
  assert.equal(h.cached('B').state.value, 'B-only');
  assert.equal(h.records.get('B').state.value, 'B-only');
});

test('unknown base revision protects an existing remote account after a failed first read', async () => {
  const h = harness('C');
  h.records.set('C', { state: { value: 'existing-C' }, revision: 2, updated_at: 'test' });
  h.queryError = { code: 'PGRST205', message: 'missing table' };
  const cloud = h.makeCloud();
  await cloud.init();
  await cloud.save({ value: 'unknown-local' });
  h.queryError = null;
  const result = await cloud.pull();
  assert.equal(result.conflict, true);
  assert.equal(h.records.get('C').state.value, 'existing-C');
  assert.equal(h.rpcCount, 0);
});

test('missing table or RPC reports error and retains a durable draft without reporting ready', async () => {
  const h = harness();
  h.queryError = { code: 'PGRST205', message: 'missing table' };
  const cloud = h.makeCloud();
  await cloud.init();
  await cloud.save({ value: 'draft' });
  const statuses = h.events.filter(event => event.type === 'status');
  assert.equal(statuses.at(-1).kind, 'error');
  assert.match(statuses.at(-1).message, /supabase-setup\.sql/);
  assert.equal(statuses.some(event => event.kind === 'ready'), false);
  assert.equal(h.cached('A').state.value, 'draft');
  assert.equal(h.cached('A').dirty, true);
  h.queryError = null;
  h.client.rpc = async () => ({ data: null, error: { code: 'PGRST202', message: 'missing RPC' } });
  await cloud.pull();
  assert.equal(h.events.filter(event => event.type === 'status').at(-1).kind, 'error');
  assert.equal(h.cached('A').dirty, true);
});

test('signup exposes confirmation requirement and unauthenticated saves remain local-only', async () => {
  const h = harness(null);
  const cloud = h.makeCloud();
  await cloud.init();
  const signup = await cloud.signUp('new@example.com', 'unused-test-password');
  assert.equal(signup.confirmationRequired, true);
  assert.equal(cloud.user, null);
  assert.equal(cloud.stage({ value: 'guest' }).localOnly, true);
  assert.equal(h.storage.size, 0);
  assert.equal((await cloud.save({ value: 'guest' })).localOnly, true);
  assert.equal(h.rpcCount, 0);
  assert.equal(h.signUpRequests[0].options, undefined, 'Node has no browser redirect URL');
});

test('immediate signup returns the account snapshot and preserves a restored draft conflict', async () => {
  const h = harness(null);
  h.storage.set('ielts-coach-cloud-state-v1:A', JSON.stringify({
    version: 1,
    userId: 'A',
    state: { value: 'local-draft' },
    baseRevision: 1,
    dirty: true,
    savedAt: 'test',
  }));
  h.records.set('A', { state: { value: 'newer-remote' }, revision: 2, updated_at: 'test' });
  h.client.auth.signUp = async () => {
    h.user = { id: 'A', email: 'a@example.com' };
    return { data: { session: { user: h.user } }, error: null };
  };
  const cloud = h.makeCloud();
  await cloud.init();
  const result = await cloud.signUp('a@example.com', 'unused-test-password');
  assert.equal(result.confirmationRequired, false);
  assert.equal(result.user.id, 'A');
  assert.equal(result.conflict, true);
  assert.equal(result.state.value, 'local-draft');
  assert.equal(result.revision, 1);
  assert.equal(h.events.at(-1).type, 'conflict');
  assert.equal(h.events.at(-1).remote.value, 'newer-remote');
  assert.equal(h.records.get('A').state.value, 'newer-remote');
  assert.equal(h.cached('A').dirty, true);
  assert.equal(h.rpcCount, 0);
});

test('signup email confirmation returns to this Pages site without its hash or query', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    value: { href: 'https://tdzr-lyh.github.io/ielts-coach/index.html?preview=1#records' },
    configurable: true,
  });
  try {
    const h = harness(null);
    const cloud = h.makeCloud();
    await cloud.signUp(' new@example.com ', 'unused-test-password');
    assert.deepEqual(h.signUpRequests[0], {
      email: 'new@example.com',
      password: 'unused-test-password',
      options: { emailRedirectTo: 'https://tdzr-lyh.github.io/ielts-coach/' },
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else delete globalThis.location;
  }
});

test('signup also supports a localhost directory URL and does not hardcode the deployed hostname', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    value: { href: 'http://localhost:5174/#today' }, configurable: true,
  });
  try {
    const h = harness(null);
    await h.makeCloud().signUp('new@example.com', 'unused-test-password');
    assert.equal(h.signUpRequests[0].options.emailRedirectTo, 'http://localhost:5174/');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else delete globalThis.location;
  }
});

test('signup never submits a file or malformed location as an email redirect', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    for (const href of ['file:///C:/ielts-coach/index.html', 'invalid-url']) {
      Object.defineProperty(globalThis, 'location', { value: { href }, configurable: true });
      const h = harness(null);
      await h.makeCloud().signUp('new@example.com', 'unused-test-password');
      assert.equal(h.signUpRequests[0].options, undefined);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else delete globalThis.location;
  }
});
