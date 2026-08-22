import { DeployError } from './errors.js';

const EXPECTED_BINDINGS = Object.freeze([
  'DB',
  'ADMIN_TOKEN',
  'EDGEPAY_LICENSE',
  'CONFIG_ENCRYPTION_KEY',
]);

export async function inspectWorker(client, accountId, scriptName) {
  let response;
  try {
    response = await client.getJSON(
      `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
      { stage: 'project_check' },
    );
  } catch (error) {
    if (error instanceof DeployError && error.status === 404) {
      return { exists: false, compatible: false, databaseId: '' };
    }
    throw error;
  }

  const bindings = Array.isArray(response?.result?.bindings) ? response.result.bindings : [];
  const names = new Set(bindings.map((binding) => String(binding?.name ?? '')));
  const database = bindings.find((binding) => (
    binding?.name === 'DB'
    && ['d1', 'd1_database'].includes(String(binding?.type ?? ''))
    && typeof (binding?.id ?? binding?.database_id) === 'string'
  ));
  const databaseId = String(database?.id ?? database?.database_id ?? '');
  const compatible = Boolean(databaseId) && EXPECTED_BINDINGS.every((name) => names.has(name));
  return {
    exists: true,
    compatible,
    databaseId,
    bindingNames: [...names].filter(Boolean).sort(),
  };
}
