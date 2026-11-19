// The assistant's knowledge folder ships with the app: agent/ in this repository while
// developing, Resources/agent in the packaged app. CODEMAP_AGENT_DIR overrides it (tests).
// The host adapter (or a lazy Electron fallback) supplies the path, so this module never
// imports electron while it is evaluated.
export { knowledgeDir as knowledgeRoot } from './hostAdapter'
