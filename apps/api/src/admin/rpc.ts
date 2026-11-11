// Хендлеры группы `admin.*` (доступ проверяет AdminMiddleware).
import { AdminRpcs, CurrentUser } from "@cg/rpc";
import { DateTime, Effect } from "effect";
import {
  createClass,
  deleteClass,
  listClasses,
  moveClass,
  renameClass,
} from "./classes";
import { deleteGame, listGames, setPublished } from "./games";
import { cancelInstall, listInstalls } from "./installs";
import {
  createRegion,
  deleteRegion,
  listRegions,
  updateRegion,
} from "./regions";
import { adminGameRequirements, setRequirements } from "./requirements";
import { loadSessionSettings, saveSessionSettings } from "./settings";
import { adminStop, listSessions } from "./sessions";
import {
  createHourPack,
  createTariff,
  listHourPacks,
  listTariffs,
  setArchivedHourPack,
  setArchivedTariff,
  setDefaultTariff,
  updateHourPack,
  updateTariff,
} from "./tariffs";
import { listUsers, resetSteamLogin, setBlocked, setRole } from "./users";
import { createWorker, issueCode, revoke } from "./workerEnroll";
import { listWorkers, setClass, setDraining, setRegion } from "./workers";

export const AdminRpcHandlers = AdminRpcs.toLayer({
  "admin.ping": () => Effect.succeed("pong" as const),
  "admin.settings.get": () => loadSessionSettings,
  "admin.settings.update": (value) => saveSessionSettings(value),
  "admin.workers.list": () =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate;
      return yield* listWorkers(now);
    }),
  "admin.workers.setDraining": ({ workerId, draining }) =>
    setDraining(workerId, draining),
  "admin.sessions.list": ({ failedOnly }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate;
      return yield* listSessions(failedOnly, now);
    }),
  "admin.sessions.stop": ({ sessionId }) => adminStop(sessionId),
  "admin.games.list": () => listGames(),
  "admin.games.delete": ({ workerId, appId }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate;
      return yield* deleteGame(workerId, appId, now);
    }),
  "admin.games.requirements": ({ appId }) => adminGameRequirements(appId),
  "admin.games.setRequirements": ({ appId, requirements }) =>
    Effect.gen(function* () {
      const current = yield* CurrentUser;
      return yield* setRequirements(appId, current.id, requirements);
    }),
  "admin.games.setPublished": ({ appId, published }) =>
    setPublished(appId, published),
  "admin.installs.list": () =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate;
      return yield* listInstalls(now);
    }),
  "admin.installs.cancel": ({ jobId }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate;
      return yield* cancelInstall(jobId, now);
    }),
  "admin.users.list": () => listUsers(),
  "admin.users.setRole": ({ userId, role }) =>
    Effect.gen(function* () {
      const current = yield* CurrentUser;
      return yield* setRole(current.id, userId, role);
    }),
  "admin.users.setBlocked": ({ userId, blocked }) =>
    Effect.gen(function* () {
      const current = yield* CurrentUser;
      const now = yield* DateTime.nowAsDate;
      return yield* setBlocked(current.id, userId, blocked, now);
    }),
  "admin.users.resetSteamLogin": ({ userId }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate;
      return yield* resetSteamLogin(userId, now);
    }),
  "admin.classes.list": () => listClasses(),
  "admin.classes.create": ({ name }) => createClass(name),
  "admin.classes.rename": ({ id, name }) => renameClass(id, name),
  "admin.classes.move": ({ id, direction }) => moveClass(id, direction),
  "admin.classes.delete": ({ id }) => deleteClass(id),
  "admin.workers.setClass": ({ workerId, classId }) =>
    setClass(workerId, classId),
  "admin.regions.list": () => listRegions(),
  "admin.regions.create": ({ code, name }) => createRegion(code, name),
  "admin.regions.update": ({ id, name, position }) =>
    updateRegion(id, name, position),
  "admin.regions.delete": ({ id }) => deleteRegion(id),
  "admin.workers.create": ({ id, regionId }) => createWorker(id, regionId),
  "admin.workers.issueCode": ({ workerId }) => issueCode(workerId),
  "admin.workers.revoke": ({ workerId }) => revoke(workerId),
  "admin.workers.setRegion": ({ workerId, regionId }) =>
    setRegion(workerId, regionId),
  "admin.tariffs.list": () => listTariffs(),
  "admin.tariffs.create": ({ input }) => createTariff(input),
  "admin.tariffs.update": ({ id, input }) => updateTariff(id, input),
  "admin.tariffs.setDefault": ({ id }) => setDefaultTariff(id),
  "admin.tariffs.setArchived": ({ id, archived }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate;
      return yield* setArchivedTariff(id, archived, now);
    }),
  "admin.hourPacks.list": () => listHourPacks(),
  "admin.hourPacks.create": ({ input }) => createHourPack(input),
  "admin.hourPacks.update": ({ id, input }) => updateHourPack(id, input),
  "admin.hourPacks.setArchived": ({ id, archived }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate;
      return yield* setArchivedHourPack(id, archived, now);
    }),
});
