import assert from 'node:assert/strict';
import test from 'node:test';
import { createSheetsConnect, SHEETS_SCOPES } from '../scripts/sheets-connect.mjs';

const READ_ONLY_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

async function authorizationParams() {
  const connect = createSheetsConnect({
    loadClient: async () => ({ clientId: 'fake-client-id', clientSecret: 'fake-client-secret' }),
    saveRefreshToken: async () => assert.fail('Authorization must not save a token'),
    fetchImpl: async () => assert.fail('Authorization must not make an HTTP request'),
    now: () => 1_700_000_000_000,
    randomBytes: (size) => Buffer.alloc(size, 1),
  });
  const { url } = await connect.start('https://example.com/api/gmail/oauth/callback');
  return new URL(url).searchParams;
}

test('authorization omits incremental grants', async () => {
  const params = await authorizationParams();
  assert.equal(params.has('include_granted_scopes'), false);
});

test('authorization requests exactly the read-only sync scopes', async () => {
  const params = await authorizationParams();
  const requested = new Set((params.get('scope') || '').split(/\s+/).filter(Boolean));
  assert.deepEqual(requested, new Set(READ_ONLY_SCOPES));
  assert.deepEqual(requested, new Set(SHEETS_SCOPES));
});
