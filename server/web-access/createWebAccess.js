import { WebAccessPolicy } from './policy.js';
import { WebAccessService } from './WebAccessService.js';
import { getLLMConfigPath } from '../llmConfig.js';
import { readConfigDocument } from '../configLock.js';
// Values are used only as local deny patterns, never as authentication. No legacy
// migration, account/network request, browser cookie discovery or log output.
async function localSecrets() {
  const config=await readConfigDocument(getLLMConfigPath());
  const values=[config?.llm?.apiKey,...(config?.modelProviders||[]).map(provider=>provider.apiKey)];
  for(const [key,value]of Object.entries(process.env))if(/(?:KEY|SECRET|TOKEN|COOKIE|PASSWORD)/i.test(key))values.push(value);
  return values.filter(value=>typeof value==='string'&&value.length>=6);
}
export function createWebAccess({state,...overrides}) {
  const policy=new WebAccessPolicy(state);
  return new WebAccessService({policy,getSecrets:localSecrets,...overrides});
}
