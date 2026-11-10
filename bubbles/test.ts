import { define } from "@lucap9056/nibble";

interface UserWebSocketContext {
  user: string;
}

export default define({
  handlers: {
    get: (req) => Response.json({ url: req.url }),
    post: async (req) => Response.json(await req.json(), { status: 201 }),
    put: async (req) => Response.json(await req.json()),
    patch: async (req) => Response.json(await req.json()),
    delete: () => new Response(null, { status: 204 }),
    options: () =>
      new Response(null, {
        status: 204,
        headers: { Allow: "GET, POST, PUT, PATCH, DELETE, OPTIONS" },
      }),
    wss: {
      upgrade: (req): UserWebSocketContext => ({
        user: req.headers.get("X-User") ?? "anonymous",
      }),
      onconnect: (ws) => { ws.send(`hello ${ws.data.user}`); }, // ws.data is UserWebSocketContext
      onmessage: (ws, message) => { ws.send(message); },
      onclose: (ws, code, reason) => { console.log(ws.data.user, code, reason);  },
    },
  },
});
