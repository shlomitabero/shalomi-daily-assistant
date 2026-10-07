export { openDatabase, type ForgeDatabase } from "./connection.js";
export {
  applyMigrations,
  generateCreateTableStatements,
  diffAndMigrate,
  describeMigrationHazards,
  type MigrationChange,
} from "./migrate.js";
export {
  insertRecord,
  listRecords,
  getRecord,
  updateRecord,
  deleteRecord,
  countRecords,
  ValidationError,
  NotFoundError,
} from "./repository.js";
export {
  ensureProjectsTable,
  insertProject,
  getProject,
  listProjectsForOwner,
  listProjectsForUser,
  listOwnedProjectIds,
  markProjectBuilt,
  updateProjectSpec,
  updateProjectName,
  updateProjectDescription,
  deleteProject,
} from "./projects.js";
export {
  ensureProjectCollaboratorsTable,
  addCollaborator,
  removeCollaborator,
  removeAllCollaborators,
  removeAllCollaborationsForUser,
  isCollaborator,
  listCollaborators,
} from "./collaborators.js";
export {
  ensureUsersTable,
  createUser,
  findUserById,
  findUserByEmail,
  createSession,
  getSessionUser,
  deleteSession,
  deleteExpiredSessions,
  deleteAllSessionsForUser,
  deleteOtherSessionsForUser,
  deleteUser,
  getPasswordHash,
  updatePasswordHash,
  DuplicateEmailError,
} from "./users.js";
export {
  ensureCheckpointsTable,
  insertCheckpoint,
  listCheckpoints,
  getCheckpoint,
  renameCheckpoint,
  deleteCheckpoint,
  deleteCheckpointsForProject,
  listAllCheckpointedEntityNames,
  listHistoricalEntityNames,
  extractEntityNamesFromSpecJson,
} from "./checkpoints.js";
export { generateSeedRecords, orderForSeeding } from "./seed.js";
export { tableNameFor, assertSafeIdentifier } from "./identifiers.js";
export {
  ensureWhatsAppConnectionsTable,
  getWhatsAppConnection,
  recordWhatsAppConnected,
  recordWhatsAppDisconnected,
  ensureWhatsAppMessagesTable,
  insertWhatsAppMessage,
  listWhatsAppMessages,
  clearWhatsAppMessages,
  deleteWhatsAppMessage,
  deleteWhatsAppData,
  type WhatsAppConnection,
  type WhatsAppMessage,
  type WhatsAppMessageDirection,
  type WhatsAppMessageStatus,
} from "./whatsapp.js";
export {
  ensureIdempotencyKeysTable,
  getIdempotencyRecord,
  insertIdempotencyRecord,
  completeIdempotencyRecord,
  deleteIdempotencyRecord,
  type IdempotencyRecord,
} from "./idempotency.js";
