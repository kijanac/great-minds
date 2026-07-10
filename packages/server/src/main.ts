import { startServer } from "./server.ts";

const started = await startServer();
console.log(JSON.stringify({ event: "server_listening", url: started.url }));
