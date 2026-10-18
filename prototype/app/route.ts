export function GET() {
  return Response.json({
    service: "dot-link-federated",
    mcp: "/mcp",
    federation: "/api/federation",
    setup: "https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link",
  });
}
