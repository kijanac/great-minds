import { startServer } from "../../server/src/server.ts";

const started = await startServer();
console.log(JSON.stringify({ event: "parity_server_listening", url: started.url }));
