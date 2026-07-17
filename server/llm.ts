/**
 * llm.ts — Utilitaires pour le LLM (suggestions de vedettes RAMEAU).
 *
 * L'application parle à n'importe quel endpoint compatible OpenAI
 * (/chat/completions). Par défaut, l'interface pointe sur le LLM du SSP Cloud.
 * Cette fonction déduit l'URL de listing des modèles à partir de l'endpoint.
 */
export function getModelsUrl(chatEndpoint: string) {
  const url = new URL(chatEndpoint);
  const pathParts = url.pathname.split('/').filter(Boolean);
  while (pathParts.length > 0 && ['chat', 'completions'].includes(pathParts[pathParts.length - 1])) pathParts.pop();
  pathParts.push('models');
  url.pathname = '/' + pathParts.join('/');
  return url.toString();
}
