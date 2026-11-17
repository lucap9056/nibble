import path from "node:path";
import { ROUTER_BINARY_NAME } from "@lucap9056/nibble-engine/config";
import { buildDaemon, DAEMON_BINARY_NAME } from "./build-daemon";
import { buildEngine } from "./build-engine";
import { buildRouter } from "./build-router";

const distPath = path.resolve(import.meta.dir, "..", "dist");

const engineOutfile = path.join(distPath, "nibble");
const engineOutputs = await buildEngine(engineOutfile);
console.log(engineOutputs.join("\n"));

const routerOutfile = path.join(distPath, ROUTER_BINARY_NAME);
console.log(buildRouter(routerOutfile));

const daemonOutfile = path.join(distPath, DAEMON_BINARY_NAME);
console.log(buildDaemon(daemonOutfile));
