import { buildServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8787);
const app = await buildServer({ logger: true });
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
