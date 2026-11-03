/** Build-time SQL project sessions. Always close a session after use. */
export { openQueryProject, QueryProjectError } from './query-project.js'
export type { QueryProject, QueryProjectOptions } from './query-project.js'
export { projectAnalysisVersion } from './project-facts.js'
export type { ProjectAnalysis, ProjectInput, QueryAnalysis, QueryDescriptor } from './project-facts.js'
