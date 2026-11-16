export const BubbleResponses = {
  badRequest: () => Response.json({ error: "Bad Request" }, { status: 400 }),
  notFound: () => Response.json({ error: "Not Found" }, { status: 404 }),
  internalServerError: () =>
    Response.json({ error: "Internal Server Error" }, { status: 500 }),
} as const;
