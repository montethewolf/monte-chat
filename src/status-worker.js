import { parentPort } from "node:worker_threads";
import { listRecentDiscordThreads, readGatewayState, readKanban, readCron, readActiveWork, resolveThreadSession } from "./hermes-status.js";
parentPort.on("message", async ({ id, method, args }) => {
  try {
    let value;
    if (method === "resolve") value = resolveThreadSession(args.stateDb, args.threadId);
    else {
      const { paths, hlvUrl, hlvToken } = args;
      const threads = await listRecentDiscordThreads({ hlvUrl, hlvToken, stateDbPath: paths.stateDb });
      value = {
        gateway: readGatewayState(paths.gatewayState), kanban: readKanban(paths.kanbanDb),
        cron: readCron(paths.cronDb, paths.cronJobs), activeWork: readActiveWork(paths.stateDb), threads,
      };
    }
    parentPort.postMessage({ id, value });
  } catch { parentPort.postMessage({ id, error: "Hermes status unavailable" }); }
});
