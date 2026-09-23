export { openDatabase, type ForgeDatabase } from "./connection.js";
export {
  applyMigrations,
  generateCreateTableStatements,
  diffAndMigrate,
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
  markProjectBuilt,
  updateProjectSpec,
  updateProjectName,
  deleteProject,
} from "./projects.js";
export {
  ensureProjectCollaboratorsTable,
  addCollaborator,
  removeCollaborator,
  removeAllCollaborators,
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
  DuplicateEmailError,
} from "./users.js";
export {
  ensureCheckpointsTable,
  insertCheckpoint,
  listCheckpoints,
  getCheckpoint,
  deleteCheckpointsForProject,
} from "./checkpoints.js";
export { generateSeedRecords } from "./seed.js";
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
  deleteWhatsAppData,
  type WhatsAppConnection,
  type WhatsAppMessage,
  type WhatsAppMessageDirection,
  type WhatsAppMessageStatus,
} from "./whatsapp.js";
