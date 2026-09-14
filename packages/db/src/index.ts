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
  markProjectBuilt,
  updateProjectSpec,
} from "./projects.js";
export {
  ensureUsersTable,
  createUser,
  findUserById,
  findUserByEmail,
  createSession,
  getSessionUser,
  deleteSession,
  DuplicateEmailError,
} from "./users.js";
export {
  ensureCheckpointsTable,
  insertCheckpoint,
  listCheckpoints,
  getCheckpoint,
} from "./checkpoints.js";
export { generateSeedRecords } from "./seed.js";
export { tableNameFor, assertSafeIdentifier } from "./identifiers.js";
